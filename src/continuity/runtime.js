import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { ContinuityStore } from './store.js';
import { ContinuitySupervisor, supervisorEnabled } from './supervisor.js';
import { OfficeContinuityAdapter } from './adapters/office.js';
import { CodexContinuityAdapter } from './adapters/codex.js';
import { ClaudeCodeContinuityAdapter } from './adapters/claude-code.js';
import { antigravityAdapter } from './adapters/antigravity.js';
import { openCodeAdapter } from './adapters/opencode.js';
import { kiloAdapter } from './adapters/kilo.js';
import { freebuffAdapter } from './adapters/freebuff.js';
import { runCompletionGates } from './gates.js';
import { WorktreeManager } from './worktree.js';

const runFile = promisify(execFile);
const enabled = (value) => /^(1|true|yes)$/i.test(String(value || ''));
async function runTestCommand(worktree, command) {
  if (command !== 'node --test') return { ok: false, detail: 'command not allowlisted' };
  try { await runFile(process.execPath, ['--test'], { cwd: worktree, windowsHide: true, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 }); return { ok: true }; }
  catch (error) { return { ok: false, detail: String(error?.stderr || error?.message || error).slice(-4000) }; }
}
export function createContinuityRuntime({ db, env = process.env, log = () => {} } = {}) {
  if (!supervisorEnabled(env)) return null;
  if (!env.CONTINUITY_WORKSPACE_ROOT || !env.CONTINUITY_WORKTREES_ROOT) throw new Error('Continuity activation requires CONTINUITY_WORKSPACE_ROOT and CONTINUITY_WORKTREES_ROOT');
  const store = new ContinuityStore(db);
  const worktrees = new WorktreeManager({ repositoryRoot: env.CONTINUITY_WORKSPACE_ROOT, worktreesRoot: env.CONTINUITY_WORKTREES_ROOT });
  const inspectCheckpoint = async ({ session, context }) => {
    const lastCommit = await worktrees.head(session.worktree);
    const files = await worktrees.changedSince(session.worktree, context?.checkpoint?.base_commit);
    return {
      ...context.checkpoint,
      timestamp: new Date().toISOString(),
      last_commit: lastCommit,
      files_changed: files,
      diff_summary: files.length ? `${files.length} file(s) differ from the checkpoint base.` : 'No file differences from the checkpoint base.',
    };
  };
  const codex = new CodexContinuityAdapter({ enabled: enabled(env.CONTINUITY_CODEX_ENABLED), inspectCheckpoint });
  const claude = new ClaudeCodeContinuityAdapter({ enabled: enabled(env.CONTINUITY_CLAUDE_ENABLED), inspectCheckpoint });
  const adapters = [new OfficeContinuityAdapter({ db }), claude, codex, antigravityAdapter, openCodeAdapter, kiloAdapter, freebuffAdapter];
  return new ContinuitySupervisor({
    store,
    adapters,
    mirrorPath: resolve(env.CONTINUITY_WORKSPACE_ROOT, '.continuity', 'checkpoint.json'),
    mirrorPathForSession: (lease) => resolve(env.CONTINUITY_WORKTREES_ROOT, '.continuity', `${lease.session_id}.json`),
    verifyBranch: (lease, checkpoint) => worktrees.verifyAgainstCheckpoint({ worktree: lease.worktree, checkpoint }),
    confirmStopped: async ({ session }) => {
      // Only the native Office worker has a durable session status that can
      // prove termination after a Supervisor restart. An orphaned external
      // CLI process cannot be inferred dead from a clean Git worktree.
      if (session?.worker_key !== 'office' || !session.native_session_id) return false;
      const { data, error } = await db.from('agent_sessions').select('status').eq('id', session.native_session_id).maybeSingle();
      return !error && ['completed', 'failed', 'cancelled'].includes(data?.status);
    },
    prepareWorktree: ({ session, task }) => worktrees.create({ path: resolve(env.CONTINUITY_WORKTREES_ROOT, session.id), branch: task.branch, repository: task.repository, refresh: true }),
    prepareTransfer: async ({ runtime, checkpoint }) => {
      if (runtime.adapter.capabilities().worktreeManagement !== 'supervisor') return;
      const verification = await worktrees.verifyAgainstCheckpoint({ worktree: runtime.task.worktree, checkpoint });
      if (!verification.ok || verification.head !== checkpoint.last_commit) throw new Error('CONTINUITY_HANDOFF_WORKTREE_UNSAFE');
      await worktrees.publish(runtime.task.worktree, checkpoint.branch);
      await worktrees.remove(runtime.task.worktree);
    },
    releaseWorktree: (path) => worktrees.remove(path),
    gates: ({ worktree, ciStatus = 'none', acceptance = [] } = {}) => runCompletionGates({
      run: (command) => runTestCommand(worktree, command),
      gitStatus: () => worktrees.status(worktree),
      readCi: async () => ({ status: ciStatus }),
      acceptance,
    }),
    doNotTouch: ['src/model-gateway/', 'src/hub-capacity.js', 'src/office/finance.js', 'V4/V5 UI', 'Dockerfile', 'docker-compose.yml', 'ops/deploy.sh', 'systems outside this repository'],
    events: undefined,
  });
}
