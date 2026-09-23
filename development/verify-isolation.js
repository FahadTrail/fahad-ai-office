import assert from 'node:assert/strict';
import { runCommand } from './escape-route.js';

if (process.platform !== 'linux' || process.getuid() !== 0) {
  throw new Error('Privilege-separation verification must run as container root on Linux');
}

const options = {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH },
  timeoutMs: 5000,
  maxOutputBytes: 1024,
};

const model = await runCommand('id', ['-u'], { ...options, executionIdentity: 'model' });
const test = await runCommand('id', ['-u'], { ...options, executionIdentity: 'test' });

assert.equal(model.code, 0);
assert.equal(model.stdout.trim(), '1000');
assert.equal(test.code, 0);
assert.equal(test.stdout.trim(), '65534');
assert.notEqual(model.stdout.trim(), test.stdout.trim());

console.log(JSON.stringify({ ok: true, modelUid: 1000, testUid: 65534 }));
