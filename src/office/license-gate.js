// Open-source license gate. Permissive licenses pass; anything else (copyleft,
// source-available, proprietary, unclear) goes to LEGAL and needs a recorded
// decision: APPROVED / APPROVED WITH CONDITIONS / REVIEW REQUIRED / DO NOT USE.

export const PERMISSIVE = Object.freeze(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']);
export const DECISIONS = Object.freeze(['APPROVED', 'APPROVED WITH CONDITIONS', 'REVIEW REQUIRED', 'DO NOT USE']);
const COPYLEFT = /\b(A?GPL|LGPL|MPL|EUPL|SSPL|CC-BY-SA|OSL)\b/i;
const SOURCE_AVAILABLE = /\b(BUSL|Business Source|Elastic|Commons Clause|SEE LICENSE|UNLICENSED|proprietary)\b/i;

export function classifyLicense(license) {
  const value = String(license || '').trim();
  if (!value || value === 'UNKNOWN') return { gate: 'LEGAL', reason: 'No license declared' };
  const parts = value.replace(/[()]/g, '').split(/\s+OR\s+/i);
  if (parts.some((part) => PERMISSIVE.includes(part.trim()))) return { gate: 'PASS', reason: 'Permissive license' };
  if (COPYLEFT.test(value)) return { gate: 'LEGAL', reason: 'Copyleft license: obligations depend on how it is used and distributed' };
  if (SOURCE_AVAILABLE.test(value)) return { gate: 'LEGAL', reason: 'Source-available or proprietary terms' };
  return { gate: 'LEGAL', reason: 'License is not on the permissive list' };
}

// Every package of a lockfile → pass, decided (with its decision) or open.
export function auditLockfile(lock, decisions = []) {
  const results = [];
  for (const [path, entry] of Object.entries(lock?.packages || {})) {
    if (!path) continue;
    const name = path.replace(/^.*node_modules\//, '');
    const license = entry.license || 'UNKNOWN';
    const verdict = classifyLicense(license);
    if (verdict.gate === 'PASS') { results.push({ name, license, status: 'PASS' }); continue; }
    const decision = decisions.find((entry) => new RegExp(entry.match).test(name));
    results.push(decision && DECISIONS.includes(decision.decision)
      ? { name, license, status: decision.decision, conditions: decision.conditions || '' }
      : { name, license, status: 'OPEN — send to LEGAL', reason: verdict.reason });
  }
  return results;
}
