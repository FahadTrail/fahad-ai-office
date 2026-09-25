// Isolated-mode sandboxes all run as the same unprivileged uid, and after
// every command the sandbox kills every leftover process of that uid (so a
// session cannot leave processes behind for the next one). Production runs
// one session at a time per worker; test files run in parallel, so tests that
// use isolated mode take this cross-process lock to not kill each other.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK = join(tmpdir(), 'fahad-sandbox-uid-tests.lock');

function holderAlive() {
  try {
    const pid = Number(readFileSync(join(LOCK, 'pid'), 'utf8'));
    if (!pid) return true; // being created right now
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM' || error?.code === 'ENOENT' ? error.code === 'EPERM' : false;
  }
}

export async function withIsolatedSandboxLock(fn, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!holderAlive()) { rmSync(LOCK, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error('Timed out waiting for the isolated sandbox test lock');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
