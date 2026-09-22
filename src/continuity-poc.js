import { newTaskEnvelope, ContinuityError } from './continuity-core.js';
import { OpenAIAdapter, AnthropicAdapter, SimulatedFailureAdapter } from './continuity-providers.js';
import { SupabaseContinuityStore, ControlledWorkspace, GitHubPublisher } from './continuity-infra.js';
import { ContinuityController } from './continuity-controller.js';

async function githubBaseSha(token) {
  const response = await fetch('https://api.github.com/repos/FahadTrail/fahad-ai-office/git/ref/heads/main', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new ContinuityError(`Could not read GitHub base SHA (HTTP ${response.status})`);
  return (await response.json()).object.sha;
}

export async function main(env = process.env) {
  const required = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CONTINUITY_GITHUB_TOKEN', 'SUPABASE_URL'];
  for (const name of required) if (!env[name]) throw new ContinuityError(`Missing secure server setting: ${name}`, { code: 'NEEDS_HUMAN_APPROVAL' });
  const supabaseKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) throw new ContinuityError('Missing secure server setting: SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY', { code: 'NEEDS_HUMAN_APPROVAL' });
  const expectedSha = await githubBaseSha(env.CONTINUITY_GITHUB_TOKEN);
  const task = newTaskEnvelope({ expectedSha, budgetUsd: Number(env.CONTINUITY_POC_BUDGET_USD || 1.5) });
  const openai = new OpenAIAdapter({ apiKey: env.OPENAI_API_KEY });
  const providers = {
    openai: new SimulatedFailureAdapter(openai, { stage: 'verify', count: 2, status: 429, retryAfter: '0' }),
    anthropic: new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY }),
  };
  const controller = new ContinuityController({
    store: new SupabaseContinuityStore({ url: env.SUPABASE_URL, key: supabaseKey }),
    workspace: new ControlledWorkspace({ root: env.CONTINUITY_WORKSPACE || '/app/workspace/continuity' }),
    publisher: new GitHubPublisher({ token: env.CONTINUITY_GITHUB_TOKEN }),
    providers,
  });
  const result = await controller.run(task);
  console.log(JSON.stringify({ ok: true, taskId: task.id, pullRequestUrl: result.pullRequestUrl, commitSha: result.commitSha, spentUsd: result.spentUsd }));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) main().catch((error) => { console.error(JSON.stringify({ ok: false, code: error.code || 'FAILED', message: error.message })); process.exit(1); });
