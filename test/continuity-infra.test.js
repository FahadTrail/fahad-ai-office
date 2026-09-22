import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubPublisher, verifyHandoff } from '../src/continuity-infra.js';
import { newTaskEnvelope } from '../src/continuity-core.js';

test('handoff rejects SHA, branch, file and test mismatches before ownership changes', () => {
  const task = newTaskEnvelope({ expectedSha: 'a'.repeat(40) });
  const base = { repository: task.repository, branch: task.workingBranch, sha: task.expectedSha, status: '?? continuity-poc-proof.md', files: task.allowedFiles, tests: { passed: true } };
  const checkpoint = { stage: 'verify', expected_sha: task.expectedSha, repo_state: base };
  assert.equal(verifyHandoff({ task, checkpoint, snapshot: base }).sha, task.expectedSha);
  assert.throws(() => verifyHandoff({ task, checkpoint, snapshot: { ...base, sha: 'b'.repeat(40) } }), /sha/);
  assert.throws(() => verifyHandoff({ task, checkpoint, snapshot: { ...base, tests: { passed: false } } }), /tests/);
  assert.throws(() => verifyHandoff({ task, checkpoint, snapshot: { ...base, files: ['src/index.js'] } }), /files/);
});

test('GitHub publication resumes without a duplicate commit when the controlled content already exists', async () => {
  const task = newTaskEnvelope({ expectedSha: 'a'.repeat(40) });
  const content = '# Continuity proof\n';
  const commitSha = 'b'.repeat(40);
  const calls = [];
  const responses = [
    { status: 200, body: { object: { sha: task.expectedSha } } },
    { status: 422, body: {} },
    { status: 200, body: { object: { sha: commitSha } } },
    { status: 200, body: { content: Buffer.from(content).toString('base64') } },
    { status: 200, body: { object: { sha: commitSha } } },
    { status: 200, body: [{ number: 7, html_url: 'https://github.com/FahadTrail/fahad-ai-office/pull/7' }] },
  ];
  const fetchFn = async (url, options) => {
    calls.push({ url, method: options.method });
    const next = responses.shift();
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  const publisher = new GitHubPublisher({ token: 'test-token', fetchFn });
  const result = await publisher.publish(task, 'continuity-poc-proof.md', content, 'Add proof');
  assert.equal(result.commitSha, commitSha);
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
});
