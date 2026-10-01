// Coding Continuity Supervisor: continuity.checkpoint.v1
// (docs/CODING-CONTINUITY-SUPERVISOR.md section 5.2). Pure functions; the
// database (save_continuity_checkpoint) re-checks schema, commits and secrets.
import { findSecretMaterial } from '../coding-agent/policy.js';
import { STATES } from './states.js';

export const CHECKPOINT_SCHEMA = 'continuity.checkpoint.v1';
export const BASES = Object.freeze(['MEASURED', 'PROVIDER_REPORTED', 'ESTIMATED', 'UNKNOWN']);
const AGENT_TYPES = ['native', 'cli', 'manual'];
const CI_STATUSES = ['success', 'failure', 'pending', 'none'];
const COMMIT = /^[0-9a-f]{40}$/;
const REQUIRED_TEXT = ['timestamp', 'repository', 'branch', 'agent_id', 'session_id', 'objective', 'phase', 'tests_run', 'next_exact_action'];
const COMMITS = ['base_commit', 'last_commit', 'rollback_commit'];
const LISTS = ['files_changed', 'decisions', 'constraints', 'errors', 'unresolved_items'];

const text = (value) => typeof value === 'string' && value.trim().length > 0;

// Returns { ok, errors }. Every error names the field so an agent can fix it.
export function validateCheckpoint(obj, { env = process.env } = {}) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['checkpoint: not an object'] };
  if (obj.schema !== CHECKPOINT_SCHEMA) errors.push(`schema: must be ${CHECKPOINT_SCHEMA}`);
  for (const field of REQUIRED_TEXT) if (!text(obj[field])) errors.push(`${field}: required`);
  for (const field of COMMITS) if (!COMMIT.test(String(obj[field] ?? ''))) errors.push(`${field}: must be a 40-character lowercase git commit`);
  if (text(obj.repository) && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(obj.repository)) errors.push('repository: must be owner/repo');
  if (text(obj.timestamp) && Number.isNaN(Date.parse(obj.timestamp))) errors.push('timestamp: must be ISO-8601');
  if (!AGENT_TYPES.includes(obj.agent_type)) errors.push(`agent_type: one of ${AGENT_TYPES.join(', ')}`);
  if (!STATES.includes(obj.status)) errors.push('status: unknown state');
  if (!CI_STATUSES.includes(obj.ci_status)) errors.push(`ci_status: one of ${CI_STATUSES.join(', ')}`);
  if (!Array.isArray(obj.files_changed)) errors.push('files_changed: required list');
  for (const field of LISTS) if (obj[field] !== undefined && !Array.isArray(obj[field])) errors.push(`${field}: must be a list`);
  for (const field of ['tests_passed', 'tests_failed']) {
    if (obj[field] !== undefined && obj[field] !== null && !(Number.isInteger(obj[field]) && obj[field] >= 0)) errors.push(`${field}: non-negative integer or null`);
  }
  if (!obj.quota_state || typeof obj.quota_state !== 'object') errors.push('quota_state: required');
  else {
    if (!BASES.includes(obj.quota_state.basis)) errors.push(`quota_state.basis: one of ${BASES.join(', ')}`);
    // A percentage without a measured or reported source would be invented.
    if (obj.quota_state.basis === 'UNKNOWN' && obj.quota_state.used_pct != null) errors.push('quota_state.used_pct: must be null when basis is UNKNOWN');
  }
  const secret = findSecretMaterial(JSON.stringify(obj), env);
  if (secret) errors.push(`secret: ${secret} found; remove it`);
  return { ok: errors.length === 0, errors };
}

const list = (items) => (Array.isArray(items) && items.length ? items.map((item) => `- ${item}`).join('\n') : '- none');

export function checkpointToMarkdown(obj) {
  const quota = obj.quota_state || {};
  const tests = obj.tests_passed == null ? obj.tests_run : `${obj.tests_run} → ${obj.tests_passed} passed, ${obj.tests_failed ?? 0} failed`;
  return [
    `## Continuity checkpoint — ${obj.repository} @ ${obj.branch}`,
    '',
    `* **Agent:** ${obj.agent_id} (${obj.agent_type}), session ${obj.session_id}`,
    `* **Phase / status:** ${obj.phase} / ${obj.status}`,
    `* **Objective:** ${obj.objective}`,
    `* **Commits:** base \`${obj.base_commit}\`, last \`${obj.last_commit}\`, rollback \`${obj.rollback_commit}\``,
    `* **Tests:** ${tests}`,
    `* **CI:** ${obj.ci_status}`,
    `* **Quota:** ${quota.used_pct == null ? 'unknown' : `${quota.used_pct}%`} (${quota.basis || 'UNKNOWN'})`,
    `* **Time:** ${obj.timestamp}`,
    '',
    `**Next exact action:** ${obj.next_exact_action}`,
    '',
    '### Files changed', list(obj.files_changed),
    '### Decisions', list(obj.decisions),
    '### Unresolved', list(obj.unresolved_items),
    '### Errors', list(obj.errors),
  ].join('\n');
}
