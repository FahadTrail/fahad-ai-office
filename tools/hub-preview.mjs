#!/usr/bin/env node
// Local UI preview for design work and visual QA: the REAL Hub server and API
// handlers over an in-memory copy of fictional Office data
// (testing/fixtures/hub-preview-data.js). Never talks to Supabase, models or
// GitHub. Loopback only, no login.
//
//   node tools/hub-preview.mjs [port]      → http://127.0.0.1:4173/
import { createHubServer } from '../src/hub-server.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { previewTables } from '../testing/fixtures/hub-preview-data.js';

export function startPreview({ port = 4173, now = Date.now() } = {}) {
  const db = memoryPostgrest(previewTables(now));
  const store = {
    createJob: async ({ title, goal, projectId, conversationId }) => {
      const job = { id: crypto.randomUUID(), title, goal, project_id: projectId, conversation_id: conversationId || null, status: 'planning', progress: 0, created_at: new Date().toISOString() };
      db.tables.jobs.push(job);
      return job;
    },
  };
  const server = createHubServer({ db, store, host: '127.0.0.1', port, accessToken: '', authEnabled: false });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, db, url: `http://127.0.0.1:${server.address().port}/` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startPreview({ port: Number(process.argv[2] || 4173) });
  console.log(`Hub preview (fictional data): ${url}`);
}
