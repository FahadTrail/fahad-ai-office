import { validateCheckpoint } from '../src/continuity/checkpoint.js';

export const DRILL_OBJECTIVE = 'Harmless Phase N drill: complete the Office -> OpenCode -> Gemini CLI chain, one short marker per worker. Execute only the current Next exact action; preserve all previous markers. Do not repeat an earlier worker step, delete files, modify source/tests, merge, or deploy. Keep the checkpoint valid and committed.';

// Facts are collected from Git commits by the live drill, not model claims.
export function checkDrillLeg({ marker, markerContent, changedFiles, priorMarkers = [], checkpoint }) {
  const failures = [];
  const allowed = new Set([marker, '.continuity/checkpoint.json']);
  if (!changedFiles.includes(marker)) failures.push('current marker was not added');
  for (const path of changedFiles) if (!allowed.has(path)) failures.push(`out-of-scope change: ${path}`);
  const lines = String(markerContent || '').trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0] || lines[0].length > 200) failures.push('marker must contain one short line');
  for (const { path, before, after } of priorMarkers) if (before !== after) failures.push(`previous marker changed: ${path}`);
  const validation = validateCheckpoint(checkpoint, { env: {} });
  if (!validation.ok) failures.push(...validation.errors.map((error) => `checkpoint: ${error}`));
  return { ok: failures.length === 0, failures };
}
