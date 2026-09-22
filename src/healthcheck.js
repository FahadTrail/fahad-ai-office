// Zero-token readiness check. GET requests only; no job claim, writes, or AI call.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export async function checkHealth({ env = process.env, fetchFn = fetch, verifyCode = true } = {}) {
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']) {
    if (!env[name] || env[name].length < 12 || /PASTE_HERE|YOUR_.*KEY/i.test(env[name])) {
      throw new Error('Missing or placeholder setting: ' + name);
    }
  }
  const base = new URL(env.SUPABASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') {
    throw new Error('SUPABASE_URL must be an HTTPS project origin');
  }
  if (verifyCode) {
    const sourceDir = new URL('./', import.meta.url);
    for (const name of readdirSync(sourceDir).filter((name) => name.endsWith('.js'))) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(name, sourceDir))], {
        encoding: 'utf8', timeout: 5000,
      });
      if (result.status !== 0) throw new Error('JavaScript syntax check failed: ' + name);
    }
    // Importing the SDK verifies it is installed; query() is never called.
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof sdk.query !== 'function') throw new Error('Claude Agent SDK query export is missing');
    const supabase = await import('@supabase/supabase-js');
    if (typeof supabase.createClient !== 'function') throw new Error('Supabase client export is missing');
  }
  async function get(path, accept = 'application/json') {
    const response = await fetchFn(new URL(path, base), {
      method: 'GET',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, Accept: accept },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    // Never log response bodies, headers, keys, prompts, or user data.
    if (!response.ok) throw new Error('Database readiness request failed (HTTP ' + response.status + ')');
    return response.json();
  }
  const agents = await get('/rest/v1/agents?select=id,slug,system_prompt,allowed_tools&slug=in.(chief-of-staff,research-strategy)');
  if (!Array.isArray(agents) || agents.length !== 2 || agents.some((agent) => !agent.id || !agent.system_prompt || agent.system_prompt.length < 100)) {
    throw new Error('Chief or Research configuration is missing or incomplete');
  }
  const research = agents.find((agent) => agent.slug === 'research-strategy');
  const tools = (research?.allowed_tools || []).map((tool) => String(tool).toLowerCase());
  if (!tools.includes('web_search') || !tools.includes('web_fetch')) throw new Error('Research web tools are not authorized');
  // Read the service-role API schema instead of calling the mutating claim RPC.
  const spec = await get('/rest/v1/', 'application/openapi+json');
  for (const name of ['claim_next_job', 'claim_next_task', 'create_task', 'complete_task', 'fail_task', 'requeue_stale_tasks']) {
    if (!spec.paths?.['/rpc/' + name]?.post) throw new Error(`Public ${name} RPC is not exposed to the runtime`);
  }
  await get('/rest/v1/jobs?select=id&limit=0');
  return true;
}

export async function main() {
  const deadline = setTimeout(() => {
    console.error('HEALTHCHECK FAILED: readiness deadline exceeded');
    process.exit(1);
  }, 30000);
  try {
    if (process.argv.includes('--runtime')) {
      checkRuntime(JSON.parse(readFileSync('/tmp/fahad-office-health.json', 'utf8')));
      console.log('RUNTIME HEALTHY: process and job polling are responsive');
      return;
    }
    await checkHealth();
    console.log('HEALTHCHECK PASSED: code, SDK, database, Chief/Research configuration, and workflow RPCs; no AI calls or data writes');
  } catch (error) {
    const message = String(error.message);
    console.error('HEALTHCHECK FAILED: ' + (/^(Missing or placeholder|SUPABASE_URL must|JavaScript syntax|Claude Agent SDK query|Supabase client export|Database readiness request|Chief or Research configuration|Research web tools|Public .* RPC)/.test(message) ? message : 'dependency or network check failed'));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

export function checkRuntime(state, now = Date.now(), processAlive = (pid) => process.kill(pid, 0)) {
  if (!Number.isInteger(state.pid) || state.pid < 1 || !Number.isFinite(state.updatedAt) ||
      !Number.isFinite(state.lastPollAt) || state.lastPollAt <= 0 ||
      !Number.isFinite(state.pollIntervalMs) || state.pollIntervalMs < 1000 || state.pollIntervalMs > 60000 ||
      typeof state.busy !== 'boolean' || now < state.updatedAt || now - state.updatedAt > 30000 ||
      (!state.busy && now - state.lastPollAt > Math.max(30000, state.pollIntervalMs * 3))) {
    throw new Error('Runtime heartbeat is missing, stale, or polling is failing');
  }
  processAlive(state.pid);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
