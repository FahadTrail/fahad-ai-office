import test from 'node:test';
import assert from 'node:assert/strict';
import { runStartupCanary } from '../src/startup-canary.js';

test('a passing startup canary is reported as verified', async () => {
  const lines = [];
  const result = await runStartupCanary({
    log: (...parts) => lines.push(parts.join(' ')),
    canary: async () => ({ workspaceId: 'w', discovered: 2, replayVerified: true, agentDenied: true,
      missingGrantDenied: true, crossWorkspaceDenied: true, budgetDeltaUsd: 0 }),
  });
  assert.equal(result.status, 'verified');
  assert.match(lines[0], /canary verified/);
});

test('a failing startup canary degrades instead of terminating the runtime', async () => {
  const lines = [];
  const result = await runStartupCanary({
    log: (...parts) => lines.push(parts.join(' ')),
    canary: async () => { throw new Error('Tool Broker canary lineage is missing'); },
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.reason, 'Tool Broker canary lineage is missing');
  assert.match(lines[0], /degraded mode/);
});
