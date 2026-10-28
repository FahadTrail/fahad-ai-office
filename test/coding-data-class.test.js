import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHubServer } from '../src/hub-server.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';

const WS = '22222222-2222-4222-8222-222222222222';

async function startTask(body) {
  const calls = [];
  const db = memoryPostgrest({ projects: [{ id: WS, name: 'Office', default_repository: 'FahadTrail/fahad-ai-office' }], agent_sessions: [] }, {
    rpc: { create_coding_session: (args) => { calls.push(args); return { data: [{ id: '33333333-3333-4333-8333-333333333333', title: args.p_title, status: 'queued' }], error: null }; } },
  });
  const server = createHubServer({ db, store: { createJob: async () => ({}) }, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: WS, instruction: 'Add a unit test for the route id parser', ...body }) });
    return { status: response.status, config: calls[0]?.p_config };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a Hub coding task keeps the PRIVATE default unless Fahad states the repository is public', async () => {
  const privateTask = await startTask({});
  assert.equal(privateTask.status, 201);
  assert.equal(privateTask.config.dataClass, undefined, 'unset → the controller treats the code as private');
  const publicTask = await startTask({ dataClass: 'PUBLIC' });
  assert.equal(publicTask.config.dataClass, 'PUBLIC');
  const bogus = await startTask({ dataClass: 'EVERYONE' });
  assert.equal(bogus.config.dataClass, undefined);
});

test('the coding composer offers the code-privacy choice, defaulting to private', () => {
  const ui = readFileSync(new URL('../src/hub-ui/coding.js', import.meta.url), 'utf8');
  assert.match(ui, /<select id="tDataClass" class="input"><option value="">\$\{esc\(w\.privateClass\)\}<\/option><option value="PUBLIC">/);
  assert.match(ui, /if \(\$\('#tDataClass'\)\.value === 'PUBLIC'\) body\.dataClass = 'PUBLIC';/);
});
