export async function runCompletionGates({ commands = ['node --test'], run, readCi, gitStatus, acceptance = [] } = {}) {
  if (typeof run !== 'function' || typeof gitStatus !== 'function') throw new TypeError('Completion gates require command and git status runners');
  const checks = [];
  for (const command of commands) {
    const outcome = await run(command);
    checks.push({ kind: 'command', name: command, ok: outcome?.ok === true, detail: outcome?.detail || null });
  }
  for (const gate of acceptance) {
    const outcome = await gate.check();
    checks.push({ kind: 'acceptance', name: gate.name, ok: outcome === true || outcome?.ok === true, detail: outcome?.detail || null });
  }
  if (readCi) {
    const ci = await readCi();
    checks.push({ kind: 'ci', name: 'pushed head', ok: ci?.status === 'success', detail: ci?.status || 'none' });
  }
  const status = await gitStatus();
  checks.push({ kind: 'git', name: 'clean working tree', ok: Boolean(status?.clean), detail: status?.detail || null });
  const failed = checks.filter((check) => !check.ok);
  return { ok: failed.length === 0, checks, failed, nextExactAction: failed.length ? `Fix completion gate: ${failed[0].name}` : null };
}
