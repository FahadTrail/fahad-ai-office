import { createHash, randomUUID } from 'node:crypto';

export const PROVIDERS = Object.freeze({ OPENAI: 'openai', ANTHROPIC: 'anthropic' });
export const FAILURE = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  TRANSIENT: 'TRANSIENT',
  BILLING: 'BILLING',
  AUTH: 'AUTH',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNKNOWN: 'UNKNOWN',
});
const POC_GOAL = 'Create continuity-poc-proof.md containing a concise proof marker and no secrets. Change no other repository file.';
const POC_PROTOCOL_VERSION = 'v2';
const ALLOWED_TOOLS = Object.freeze(['git.read', 'workspace.write:continuity-poc-proof.md', 'test:node --test', 'github.branch', 'github.commit', 'github.pull_request', 'supabase.continuity_state']);
const RESTRICTED_ACTIONS = Object.freeze(['deployment', 'production_runtime_change', 'secret_access', 'shell_from_model', 'write_outside_allowed_file']);
const ACCEPTANCE_CRITERIA = Object.freeze(['GPT-5.3-Codex creates the initial proof content', 'A simulated 429 produces a durable handoff checkpoint', 'Claude Sonnet 5 preserves the initial work and completes the proof', 'Repository tests pass before and after handoff', 'One pull request is created without duplicate commits']);

export class ContinuityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContinuityError';
    Object.assign(this, details);
  }
}

export function stableHash(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    }
    return item;
  };
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}

export function classifyFailure(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const type = String(error?.type || error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (status === 401 || status === 403 || /auth|api.?key|permission/.test(type)) return FAILURE.AUTH;
  if (status === 402 || /billing|credit|spend.?limit|insufficient_quota/.test(type + ' ' + message)) return FAILURE.BILLING;
  if (status === 429) return FAILURE.RATE_LIMIT;
  if (status >= 500 || status === 408 || /timeout|network|fetch failed|overloaded|connection/.test(type + ' ' + message)) return FAILURE.TRANSIENT;
  if (status >= 400 && status < 500) return FAILURE.INVALID_REQUEST;
  return FAILURE.UNKNOWN;
}

export function retryAfterMs(error, now = Date.now()) {
  const raw = error?.retryAfter ?? error?.headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function validateTaskEnvelope(task) {
  const required = ['id', 'idempotencyKey', 'repository', 'baseBranch', 'expectedSha', 'workingBranch', 'goal', 'budgetUsd', 'currentProvider', 'currentModel', 'currentStage', 'currentCommitSha', 'currentTaskState'];
  for (const key of required) if (task[key] === undefined || task[key] === null || task[key] === '') throw new ContinuityError(`Task envelope is missing ${key}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.id)) throw new ContinuityError('Task id must be a UUID');
  if (task.repository !== 'FahadTrail/fahad-ai-office') throw new ContinuityError('Repository is outside the approved scope');
  if (task.baseBranch !== 'main') throw new ContinuityError('Only main may be used as the base branch');
  if (!/^[0-9a-f]{40}$/i.test(task.expectedSha)) throw new ContinuityError('expectedSha must be a full Git commit SHA');
  if (task.idempotencyKey !== `continuity-poc:${POC_PROTOCOL_VERSION}:${task.expectedSha}`) throw new ContinuityError('Idempotency key does not match the approved POC');
  if (task.workingBranch !== `continuity/poc-${task.id.slice(0, 8)}`) throw new ContinuityError('Working branch is outside the continuity POC namespace');
  if (task.goal !== POC_GOAL) throw new ContinuityError('Task goal is outside the approved POC');
  if (JSON.stringify(task.requirements) !== JSON.stringify(ACCEPTANCE_CRITERIA)) throw new ContinuityError('Task requirements are outside the approved POC');
  if (JSON.stringify(task.acceptanceCriteria) !== JSON.stringify(ACCEPTANCE_CRITERIA)) throw new ContinuityError('Acceptance criteria are outside the approved POC');
  if (task.riskLevel !== 'low') throw new ContinuityError('Only the low-risk POC is approved');
  if (JSON.stringify(task.allowedTools) !== JSON.stringify(ALLOWED_TOOLS)) throw new ContinuityError('Allowed tools are outside the approved POC');
  if (JSON.stringify(task.restrictedActions) !== JSON.stringify(RESTRICTED_ACTIONS)) throw new ContinuityError('Restricted actions are outside the approved POC');
  if (JSON.stringify(task.allowedFiles) !== JSON.stringify(['continuity-poc-proof.md'])) throw new ContinuityError('Allowed files are outside the approved POC');
  if (JSON.stringify(task.testCommand) !== JSON.stringify(['node', '--test'])) throw new ContinuityError('Test command is outside the approved tool policy');
  if (task.maxAttemptsPerProvider !== 2 || task.maxProviderSwitchesPerStage !== 2) throw new ContinuityError('Retry policy is outside the approved bounds');
  if (task.currentProvider !== 'openai' || task.currentModel !== 'gpt-5.3-codex' || task.currentStage !== 'prepare' || task.currentCommitSha !== task.expectedSha || task.currentTaskState !== 'created') throw new ContinuityError('Initial task state is outside the approved POC');
  if (!Number.isFinite(task.budgetUsd) || task.budgetUsd <= 0 || task.budgetUsd > 5) throw new ContinuityError('budgetUsd must be between 0 and 5');
  return task;
}

export class CostTracker {
  constructor(budgetUsd, onThreshold = async () => {}, initialSpentUsd = 0) {
    this.budgetUsd = budgetUsd;
    this.spentUsd = Number(initialSpentUsd || 0);
    this.onThreshold = onThreshold;
    this.emitted = new Set();
  }
  async add(usage) {
    this.spentUsd += Number(usage.costUsd || 0);
    const ratio = this.spentUsd / this.budgetUsd;
    for (const threshold of [0.7, 0.9, 1]) {
      if (ratio + Number.EPSILON * 8 >= threshold && !this.emitted.has(threshold)) {
        this.emitted.add(threshold);
        await this.onThreshold({ threshold, spentUsd: this.spentUsd, budgetUsd: this.budgetUsd });
      }
    }
    if (ratio + Number.EPSILON * 8 >= 1) throw new ContinuityError('Task cost budget exhausted', { code: 'BUDGET_EXHAUSTED' });
    return this.spentUsd;
  }
}

export class ProgressGuard {
  constructor(maxRepeats = 2) {
    this.maxRepeats = maxRepeats;
    this.last = null;
    this.repeats = 0;
  }
  observe(value) {
    const hash = stableHash(value);
    this.repeats = hash === this.last ? this.repeats + 1 : 0;
    this.last = hash;
    if (this.repeats >= this.maxRepeats) throw new ContinuityError('No-progress loop detected', { code: 'NO_PROGRESS' });
    return hash;
  }
}

export function newTaskEnvelope({ expectedSha, budgetUsd = 1.5 } = {}) {
  const id = randomUUID();
  return validateTaskEnvelope({
    id,
    idempotencyKey: `continuity-poc:${POC_PROTOCOL_VERSION}:${expectedSha}`,
    repository: 'FahadTrail/fahad-ai-office',
    baseBranch: 'main',
    expectedSha,
    workingBranch: `continuity/poc-${id.slice(0, 8)}`,
    goal: POC_GOAL,
    requirements: [...ACCEPTANCE_CRITERIA],
    acceptanceCriteria: [...ACCEPTANCE_CRITERIA],
    riskLevel: 'low',
    allowedTools: [...ALLOWED_TOOLS],
    restrictedActions: [...RESTRICTED_ACTIONS],
    allowedFiles: ['continuity-poc-proof.md'],
    testCommand: ['node', '--test'],
    budgetUsd,
    maxAttemptsPerProvider: 2,
    maxProviderSwitchesPerStage: 2,
    currentProvider: 'openai',
    currentModel: 'gpt-5.3-codex',
    currentStage: 'prepare',
    currentCommitSha: expectedSha,
    currentTaskState: 'created',
  });
}
