import { validateCheckpoint } from './checkpoint.js';

const list = (value) => Array.isArray(value) && value.length ? value.join('; ') : 'none';

export function buildContinuationPacket(checkpoint, { doNotTouch = [] } = {}) {
  const validation = validateCheckpoint(checkpoint, { env: {} });
  if (!validation.ok) throw new Error(`CONTINUATION_CHECKPOINT_INVALID: ${validation.errors.join('; ')}`);
  return [
    `You are continuing work on ${checkpoint.repository} as part of the Fahad AI Office coding stack.`,
    'Do not restart or redesign. GitHub is the source of truth.',
    '',
    'Read first, in order: AGENTS.md, docs/DEVELOPMENT-CONTRACT.md, docs/HANDOVER.md,',
    'then the checkpoint below.',
    '',
    `Branch: ${checkpoint.branch}   (you hold the write lease; do not push elsewhere)`,
    `Base commit: ${checkpoint.base_commit}   Last commit: ${checkpoint.last_commit}`,
    `Objective: ${checkpoint.objective}`,
    `Phase: ${checkpoint.phase}`,
    `Done so far: ${checkpoint.summary_md || checkpoint.diff_summary || 'none'}`,
    `Tests: ${checkpoint.tests_run} → ${checkpoint.tests_passed ?? 'UNKNOWN'} passed, ${checkpoint.tests_failed ?? 'UNKNOWN'} failed. CI: ${checkpoint.ci_status}`,
    `Unresolved: ${list(checkpoint.unresolved_items)}`,
    `Constraints: ${list(checkpoint.constraints)}`,
    `Data class: ${checkpoint.data_class || 'NORMAL'}`,
    `Privacy requirements: ${list(checkpoint.privacy_requirements)}`,
    `Do not touch: ${list(doNotTouch)}`,
    '',
    `Next exact action: ${checkpoint.next_exact_action}`,
    '',
    'Rules: commit small steps; run `node --test` before each push; update',
    '.continuity/checkpoint.json with every commit; when asked to stop, finish the',
    'current step, write a checkpoint and exit. Never claim success; the',
    'Supervisor runs the completion gates.',
  ].join('\n');
}
export function verifyResume(checkpoint, target) {
  const mismatches = [];
  const expected = {
    repository: checkpoint.repository,
    branch: checkpoint.branch,
    objective: checkpoint.objective,
    last_commit: checkpoint.last_commit,
    next_exact_action: checkpoint.next_exact_action,
    data_class: checkpoint.data_class || 'NORMAL',
  };
  for (const [field, value] of Object.entries(expected)) if (target?.[field] !== value) mismatches.push(field);
  if (JSON.stringify(target?.unresolved_items || []) !== JSON.stringify(checkpoint.unresolved_items || [])) mismatches.push('unresolved_items');
  if (JSON.stringify(target?.files_changed || []) !== JSON.stringify(checkpoint.files_changed || [])) mismatches.push('files_changed');
  return { ok: mismatches.length === 0, mismatches };
}
