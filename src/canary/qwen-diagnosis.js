// Pinpoints why Qwen (Alibaba Cloud Model Studio) refuses the configured key,
// without guessing: the key's own model list, then a 1-token call to the
// configured model and to a second model. Only HTTP statuses and Model
// Studio's machine-readable error codes (e.g. "AccessDenied.Unpurchased")
// are kept; messages, bodies and the key never are. Runs only inside an
// owner-requested canary (at most three tiny calls), never in a loop.

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,60}$/;

function providerCode(body) {
  return [body?.error?.code, body?.code, body?.error?.type].find((value) => typeof value === 'string' && CODE_RE.test(value)) || null;
}

async function call(fetchFn, url, init, timeoutMs) {
  try {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let body = {};
    try { body = await response.json(); } catch {}
    return { status: response.status, code: response.ok ? null : providerCode(body) };
  } catch (error) {
    return { status: null, code: `NETWORK_${String(error?.name || 'ERROR').replace(/[^A-Za-z]/g, '').slice(0, 30)}` };
  }
}

// Maps the observations to one named blocker and the exact owner action.
export function interpretQwen({ models, primary, secondary }) {
  const denied = (probe) => probe && [401, 403].includes(probe.status);
  const unpurchased = (probe) => /Unpurchased|NotActivated|AccessDenied/i.test(probe?.code || '');
  if (models.status === 401 || /InvalidApiKey/i.test(models.code || '')) {
    return { blocker: 'CREDENTIAL_INVALID', explanation: 'The key is rejected by this endpoint. Model Studio keys are region-bound: a key created in another region (e.g. China/Beijing) is invalid on the Singapore endpoint.', action: 'Create an API key in the Model Studio console with the region switcher set to Singapore, then store it with set-secret.' };
  }
  if (/Arrearage|Overdue/i.test(`${primary?.code} ${secondary?.code}`)) {
    return { blocker: 'ACCOUNT_OVERDUE', explanation: 'The Alibaba Cloud account has an overdue balance.', action: 'Settle the balance under Expenses and Costs in the Alibaba Cloud console.' };
  }
  if (primary?.status && primary.status < 300) return { blocker: null, explanation: 'Qwen answers normally.', action: null };
  if (primary?.status === 404 || /ModelNotFound|model_not_found|InvalidParameter/i.test(primary?.code || '')) {
    return { blocker: 'WRONG_MODEL_ID', explanation: 'The configured model id is not served by this endpoint.', action: 'No owner action: the model id is corrected in configuration.' };
  }
  if (denied(primary) && unpurchased(primary) && secondary?.status && secondary.status < 300) {
    return { blocker: 'MODEL_NOT_ENTITLED', explanation: 'The account works but is not entitled to the configured model.', action: 'No owner action: route to an entitled model (or enable the model in Model Studio).' };
  }
  if (denied(primary) && unpurchased(primary) && (!secondary || (denied(secondary) && unpurchased(secondary)))) {
    return {
      blocker: 'ACCOUNT_NOT_ACTIVATED',
      explanation: `The key is accepted (model list: HTTP ${models.status}) but every model call is refused with ${primary.code}: Model Studio is not activated (or its free quota ended without pay-as-you-go enabled) for this account in the endpoint's region.`,
      action: 'Sign in to the Alibaba Cloud Model Studio console, switch the region to Singapore, click "Activate Model Studio" / accept the service terms (and, if prompted, complete account verification and add a payment method for pay-as-you-go). No new key is needed.',
    };
  }
  return { blocker: 'UNKNOWN', explanation: `Model list HTTP ${models.status ?? 'n/a'}; model call HTTP ${primary?.status ?? 'n/a'} (${primary?.code || 'no code'}).`, action: 'Inspect the Model Studio console for the account status in the Singapore region.' };
}

export async function diagnoseQwen({ env = process.env, fetchFn = fetch, timeoutMs = 20_000 } = {}) {
  const key = String(env.QWEN_API_KEY || '').trim();
  if (key.length < 12) return { configured: false };
  const chat = env.QWEN_API_ENDPOINT || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
  let host = null;
  try { host = new URL(chat).host; } catch { return { configured: true, endpointHost: 'INVALID_URL' }; }
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const models = await call(fetchFn, chat.replace(/\/chat\/completions$/, '/models'), { headers }, timeoutMs);
  const probe = (model) => call(fetchFn, chat, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }) }, timeoutMs);
  const model = env.QWEN_MODEL || 'qwen3.8-flash';
  const primary = await probe(model);
  const secondModel = model === 'qwen-flash' ? 'qwen-plus' : 'qwen-flash';
  const secondary = primary.status && primary.status >= 400 ? await probe(secondModel) : null;
  return {
    configured: true, endpointHost: host, model, secondModel: secondary ? secondModel : null,
    observations: { models, primary, secondary },
    ...interpretQwen({ models, primary, secondary }),
  };
}
