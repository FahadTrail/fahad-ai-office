// Verifies, inside the runtime image and as container root, that the Coding
// Agent sandbox drops to an unprivileged uid which cannot read the
// controller's environment. Used by CI and by the coding-worker install.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_IDENTITY, runProcess } from './sandbox.js';
import { sandboxEnvironment } from './policy.js';

if (process.platform !== 'linux' || process.getuid() !== 0) {
  throw new Error('Sandbox isolation verification must run as container root on Linux');
}

const home = mkdtempSync(join(tmpdir(), 'fahad-isolation-'));
try {
  const secret = join(home, 'controller-secret');
  writeFileSync(secret, 'controller-only', { mode: 0o600 });
  const options = { cwd: '/', env: sandboxEnvironment({ home }), identity: SANDBOX_IDENTITY, timeoutMs: 10_000 };
  const uid = await runProcess('id', ['-u'], options);
  assert.equal(uid.stdout.trim(), String(SANDBOX_IDENTITY.uid));
  const environ = await runProcess('sh', ['-c', `cat /proc/${process.pid}/environ >/dev/null 2>&1 && echo readable || echo denied`], options);
  assert.equal(environ.stdout.trim(), 'denied');
  const file = await runProcess('sh', ['-c', `cat ${secret} >/dev/null 2>&1 && echo readable || echo denied`], options);
  assert.equal(file.stdout.trim(), 'denied');
  const env = await runProcess('env', [], options);
  assert.doesNotMatch(env.stdout, /SERVICE_ROLE|_API_KEY=|GITHUB_TOKEN=/);
  console.log(JSON.stringify({ ok: true, sandboxUid: SANDBOX_IDENTITY.uid, controllerEnvironReadable: false }));
} finally {
  rmSync(home, { recursive: true, force: true });
}
