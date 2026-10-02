import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodeIntelligence } from '../src/continuity/code-intelligence.js';

test('Graphify is optional: disabled, absent graph and absent CLI never block a coding task', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fahad-code-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disabled = createCodeIntelligence({ root });
  assert.equal((await disabled.getContextForTask({ objective: 'Find supervisor' })).reason, 'DISABLED');
  const enabled = createCodeIntelligence({ root, enabled: true, binary: 'missing-graphify-cli' });
  assert.equal((await enabled.queryArchitecture('Find supervisor')).reason, 'GRAPH_MISSING');
  await mkdir(join(root, 'graphify-out'));
  await writeFile(join(root, 'graphify-out', 'graph.json'), '{}');
  assert.equal((await enabled.queryArchitecture('Find supervisor')).reason, 'GRAPHIFY_UNAVAILABLE');
});

test('Graphify file hints are bounded and exclude isolated or credential paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fahad-code-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'graphify-out'));
  await writeFile(join(root, 'graphify-out', 'graph.json'), '{}');
  const calls = [];
  const run = async (_binary, args) => {
    calls.push(args);
    return { stdout: [
      'NODE Supervisor [src=src/continuity/supervisor.js loc=L20]',
      'NODE token [src=src/credentials/token.js loc=L1]',
      'NODE isolated [src=src/hermes/adapter.js loc=L1]',
      ...Array.from({ length: 12 }, (_, i) => `NODE file${i} [src=src/continuity/file${i}.js loc=L1]`),
    ].join('\n') };
  };
  const intelligence = createCodeIntelligence({ root, enabled: true, run });
  const result = await intelligence.getContextForTask({ objective: 'Find supervisor' });
  assert.equal(result.available, true);
  assert.equal(result.files.length, 8);
  assert.equal(result.files[0], 'src/continuity/supervisor.js');
  assert.ok(result.files.every((file) => !/credential|hermes/i.test(file)));
  assert.equal(calls[0][0], 'query');
  const trace = await intelligence.traceDependency('Supervisor', 'Codex');
  assert.equal(trace.available, true);
  assert.ok(calls[1].includes('--undirected'));
});
