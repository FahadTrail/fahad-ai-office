// Version reporting (the runtime used to report the PREVIOUS commit after every
// release) and the native Coding worker's presence (health "unknown", no
// last_seen_at, forever).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideVersion, recordRuntimeStart } from '../src/ops/runtime-started.js';
import { OFFLINE_AFTER_MS, presencePatch, startPresence, workerLiveStatus } from '../src/coding-agent/presence.js';
import { workerTruth } from '../src/hub-continuity.js';

const OLD = 'c339c90ef4b7366192c54ad763930fee473928a5';
const NEW = '17b5f3ce15ae6ff914585aeb7875c57bb148464b';

test('a deployed-sha file older than the process (written by the previous deploy) is never reported', () => {
  const started = Date.parse('2026-10-09T10:47:53Z');
  const stale = decideVersion({ fileVersion: OLD.slice(0, 12), fileWrittenAt: started - 86_400_000, processStartedAt: started, fingerprint: 'new-fp', known: [] });
  assert.equal(stale.confirmed, false);
  assert.equal(stale.version, null);
  assert.equal(stale.stale, OLD.slice(0, 12));
  // The deploy writes the file after the container is healthy: newer than the process.
  const fresh = decideVersion({ fileVersion: NEW.slice(0, 12), fileWrittenAt: started + 18_000, processStartedAt: started, fingerprint: 'new-fp', known: [] });
  assert.deepEqual(fresh, { version: NEW.slice(0, 12), confirmed: true, source: 'deployment' });
  // A plain restart of the same code: the file is older, but this fingerprint was confirmed at this commit.
  const restart = decideVersion({ fileVersion: NEW.slice(0, 12), fileWrittenAt: started - 3600_000, processStartedAt: started, fingerprint: 'new-fp', known: [{ fingerprint: 'new-fp', version: NEW.slice(0, 12) }] });
  assert.equal(restart.source, 'restart');
  // The same commit confirmed for a DIFFERENT fingerprint is not enough.
  assert.equal(decideVersion({ fileVersion: NEW.slice(0, 12), fileWrittenAt: 0, processStartedAt: started, fingerprint: 'other', known: [{ fingerprint: 'new-fp', version: NEW.slice(0, 12) }] }).confirmed, false);
});

test('PRODUCTION REGRESSION: the runtime waits for the deploy to write the new commit, then records it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sha-'));
  const path = join(dir, 'deployed-sha');
  writeFileSync(path, `${OLD}\n`);
  const startedAt = Date.now();
  utimesSync(path, new Date(startedAt - 86_400_000), new Date(startedAt - 86_400_000));
  const inserted = [];
  const db = { from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; }, select: () => { throw new Error('no history'); } }) };
  let polls = 0;
  const sleep = async () => { polls += 1; if (polls === 2) writeFileSync(path, `${NEW}\n`); };
  assert.equal(await recordRuntimeStart(db, () => {}, { fingerprint: 'fp', pid: 7, path, processStartedAt: startedAt, waitMs: 60_000, sleep }), true);
  assert.equal(inserted.length, 1, 'one event, after the version is known');
  assert.equal(inserted[0].payload.version, NEW.slice(0, 12));
  assert.equal(inserted[0].payload.versionConfirmed, true);
  assert.equal(inserted[0].payload.versionSource, 'deployment');
  const { runtimeVersion } = await import('../src/ops/runtime-started.js');
  assert.equal(runtimeVersion({ path }), NEW.slice(0, 12), '/healthz reports the confirmed commit');
});

test('when no deployment ever confirms, the stale commit is recorded as stale, not as the version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sha-'));
  const path = join(dir, 'deployed-sha');
  writeFileSync(path, `${OLD}\n`);
  utimesSync(path, new Date(0), new Date(0));
  const inserted = [];
  const db = { from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; }, select: () => { throw new Error('none'); } }) };
  let clock = 0;
  await recordRuntimeStart(db, () => {}, { fingerprint: 'fp', pid: 1, path, processStartedAt: 1000, waitMs: 10, pollMs: 5, sleep: async () => { clock += 5; }, now: () => clock });
  assert.equal(inserted[0].payload.version, null);
  assert.equal(inserted[0].payload.staleVersion, OLD.slice(0, 12));
  assert.equal(inserted[0].payload.versionConfirmed, false);
});

test('the native Coding worker stamps its registry row with a measured heartbeat', async () => {
  const updates = [];
  const db = { from: (table) => ({ update: (patch) => ({ eq: async (column, value) => { updates.push({ table, patch, column, value }); return { error: null }; } }) }) };
  const presence = startPresence({ db, key: 'office', intervalMs: 3_600_000, now: () => new Date('2026-10-09T12:00:00Z') });
  await new Promise((resolve) => setImmediate(resolve));
  presence.stop();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { table: 'coding_workers', column: 'key', value: 'office', patch: presencePatch(new Date('2026-10-09T12:00:00Z')) });
  assert.equal(updates[0].patch.health, 'healthy');
  assert.equal(updates[0].patch.health_basis, 'MEASURED');
  // A failing write never throws.
  const broken = startPresence({ db: { from: () => { throw new Error('offline'); } }, intervalMs: 3_600_000 });
  broken.stop();
});

test('worker live status: DISABLED · UNKNOWN · OFFLINE · BLOCKED · ACTIVE · IDLE, only from measured facts', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const seen = (ms) => new Date(now - ms).toISOString();
  assert.equal(workerLiveStatus({ enabled: false, lastSeenAt: seen(1000), now }).status, 'DISABLED');
  assert.equal(workerLiveStatus({ enabled: true, lastSeenAt: null, now }).status, 'UNKNOWN');
  assert.equal(workerLiveStatus({ enabled: true, lastSeenAt: seen(OFFLINE_AFTER_MS + 1), running: 1, now }).status, 'OFFLINE', 'a stale heartbeat is offline even with a running row');
  assert.equal(workerLiveStatus({ enabled: true, lastSeenAt: seen(30_000), running: 1, now }).status, 'ACTIVE');
  assert.equal(workerLiveStatus({ enabled: true, lastSeenAt: seen(30_000), blocked: 2, now }).status, 'BLOCKED');
  assert.equal(workerLiveStatus({ enabled: true, lastSeenAt: seen(30_000), now }).status, 'IDLE');
  const truth = workerTruth({ key: 'office', kind: 'native', enabled: true, lastSeenAt: seen(20_000) }, { activity: { running: 0, blocked: 0 }, now });
  assert.equal(truth.class, 'ACTIVE');
  assert.equal(truth.status, 'IDLE');
  assert.equal(workerTruth({ key: 'codex', kind: 'cli', enabled: false }, { now }).status, 'DISABLED');
});
