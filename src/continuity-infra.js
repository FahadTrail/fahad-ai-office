import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContinuityError } from './continuity-core.js';

export class SupabaseContinuityStore {
  constructor({ url, key, fetchFn = fetch } = {}) {
    this.url = String(url || '').replace(/\/$/, ''); this.key = key; this.fetchFn = fetchFn;
    if (!this.url || !this.key) throw new ContinuityError('Supabase server credentials are unavailable');
  }
  async request(path, { method = 'GET', body, prefer } = {}) {
    const response = await this.fetchFn(`${this.url}/rest/v1/${path}`, {
      method, headers: { apikey: this.key, authorization: `Bearer ${this.key}`, 'content-type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new ContinuityError(`Supabase continuity request failed (HTTP ${response.status})`, { status: response.status });
    if (response.status === 204) return null;
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  async createTask(task) {
    const rows = await this.request('continuity_tasks?on_conflict=idempotency_key', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: [{ id: task.id, idempotency_key: task.idempotencyKey, repository: task.repository, base_branch: task.baseBranch, expected_sha: task.expectedSha, working_branch: task.workingBranch, owner_provider: 'openai', budget_usd: task.budgetUsd, task_envelope: task }] });
    return rows?.[0] || (await this.request(`continuity_tasks?idempotency_key=eq.${encodeURIComponent(task.idempotencyKey)}&limit=1`))?.[0];
  }
  async latestCheckpoint(taskId) { return (await this.request(`continuity_checkpoints?task_id=eq.${taskId}&order=sequence.desc&limit=1`))?.[0] || null; }
  async event(taskId, type, message, payload = {}, level = 'info', provider = null) { await this.request('continuity_events', { method: 'POST', body: [{ task_id: taskId, type, level, provider, message, payload }] }); }
  async checkpoint(taskId, sequence, stage, ownerProvider, expectedSha, repoState, payload, progressHash) {
    const rows = await this.request('continuity_checkpoints?on_conflict=task_id,sequence', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: [{ task_id: taskId, sequence, stage, owner_provider: ownerProvider, expected_sha: expectedSha, repo_state: repoState, payload, progress_hash: progressHash }] });
    return rows?.[0] || (await this.request(`continuity_checkpoints?task_id=eq.${taskId}&sequence=eq.${sequence}&limit=1`))?.[0];
  }
  async acquireLease(taskId, owner, token, seconds = 300) { const rows = await this.request('rpc/continuity_acquire_lease', { method: 'POST', body: { p_task_id: taskId, p_owner: owner, p_token: token, p_seconds: seconds } }); if (!rows?.[0]) throw new ContinuityError('Task lease is held by another writer', { code: 'LOCKED' }); return rows[0]; }
  async transfer(taskId, fromOwner, toOwner, token, checkpointId, verification) { const rows = await this.request('rpc/continuity_transfer_owner', { method: 'POST', body: { p_task_id: taskId, p_from_owner: fromOwner, p_to_owner: toOwner, p_token: token, p_checkpoint_id: checkpointId, p_verification: verification } }); if (!rows?.[0]) throw new ContinuityError('Atomic ownership transfer failed', { code: 'HANDOFF_CONFLICT' }); return rows[0]; }
  async usage(taskId, provider, model, usage) { await this.request('continuity_usage?on_conflict=request_id', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: [{ task_id: taskId, provider, model, agent: usage.agent, stage: usage.stage, attempt: usage.attempt, duration_ms: usage.durationMs, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cached_input_tokens: usage.cachedInputTokens, cost_usd: usage.costUsd, request_id: usage.requestId }] }); }
  async spent(taskId) { const rows = await this.request(`continuity_usage?task_id=eq.${taskId}&select=cost_usd`); return (rows || []).reduce((total, row) => total + Number(row.cost_usd || 0), 0); }
  async finish(taskId, status, result, spentUsd, token) {
    const stage = status === 'completed' ? 'completed' : status === 'needs_human' ? 'needs_human' : 'failed';
    const rows = await this.request(`continuity_tasks?id=eq.${taskId}&lease_token=eq.${token}&status=eq.running`, { method: 'PATCH', prefer: 'return=representation', body: { status, stage, result, spent_usd: spentUsd, completed_at: status === 'needs_human' ? null : new Date().toISOString() } });
    if (!rows?.[0]) throw new ContinuityError('Stale writer could not finalize the task', { code: 'STALE_LOCK' });
  }
}

function run(command, args, cwd, timeout = 120000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new ContinuityError(`${command} ${args[0] || ''} failed`, { code: 'TOOL_FAILED', output: `${result.stdout || ''}${result.stderr || ''}`.slice(-4000) });
  return result.stdout.trim();
}

export class ControlledWorkspace {
  constructor({ root = '/app/workspace/continuity', repositoryUrl = 'https://github.com/FahadTrail/fahad-ai-office.git' } = {}) { this.root = resolve(root); this.repositoryUrl = repositoryUrl; this.repoDir = null; }
  safePath(relativePath) {
    const target = resolve(this.repoDir, relativePath);
    if (target !== this.repoDir && !target.startsWith(this.repoDir + sep)) throw new ContinuityError('Path escapes the task workspace');
    return target;
  }
  prepare(task) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.repoDir = join(this.root, task.id, 'repo');
    if (!existsSync(join(this.repoDir, '.git'))) { mkdirSync(dirname(this.repoDir), { recursive: true, mode: 0o700 }); run('git', ['clone', '--depth', '1', '--branch', task.baseBranch, this.repositoryUrl, this.repoDir], this.root); }
    const sha = run('git', ['rev-parse', 'HEAD'], this.repoDir);
    if (sha !== task.expectedSha) throw new ContinuityError('Local checkout SHA does not match task expected SHA', { code: 'STALE_SHA' });
    const branches = run('git', ['branch', '--list', task.workingBranch], this.repoDir);
    run('git', branches ? ['checkout', task.workingBranch] : ['checkout', '-b', task.workingBranch], this.repoDir);
    return this.snapshot(task, null);
  }
  writeAllowed(task, path, content) {
    if (!task.allowedFiles.includes(path)) throw new ContinuityError(`Write denied for ${path}`, { code: 'TOOL_PERMISSION_DENIED' });
    if (/\0/.test(content) || Buffer.byteLength(content, 'utf8') > 20000) throw new ContinuityError('Proposed file content is invalid or too large');
    if (/(?:sk-|ghp_|github_pat_|sb_secret_)[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(content)) throw new ContinuityError('Proposed content resembles a secret', { code: 'SECRET_DETECTED' });
    const target = this.safePath(path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, { encoding: 'utf8', mode: 0o644 });
  }
  test(task) { const result = spawnSync(task.testCommand[0], task.testCommand.slice(1), { cwd: this.repoDir, encoding: 'utf8', timeout: 180000, windowsHide: true }); return { passed: result.status === 0, exitCode: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.slice(-10000) }; }
  snapshot(task, tests) {
    const sha = run('git', ['rev-parse', 'HEAD'], this.repoDir);
    const branch = run('git', ['branch', '--show-current'], this.repoDir);
    const status = run('git', ['status', '--porcelain'], this.repoDir);
    const files = status.split('\n').filter(Boolean).map((line) => line.slice(3));
    return { repository: task.repository, branch, sha, status, files, tests };
  }
  read(path) { return readFileSync(this.safePath(path), 'utf8'); }
}

export class GitHubPublisher {
  constructor({ token, repository = 'FahadTrail/fahad-ai-office', fetchFn = fetch } = {}) { this.token = token; this.repository = repository; this.fetchFn = fetchFn; }
  async request(path, { method = 'GET', body } = {}) {
    if (!this.token) throw new ContinuityError('CONTINUITY_GITHUB_TOKEN is unavailable', { status: 401, type: 'authentication_error' });
    const response = await this.fetchFn(`https://api.github.com/repos/${this.repository}${path}`, { method, headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new ContinuityError(`GitHub API request failed (HTTP ${response.status})`, { status: response.status });
    return response.status === 204 ? null : response.json();
  }
  async publish(task, path, content, message) {
    const base = await this.request(`/git/ref/heads/${task.baseBranch}`);
    if (base.object.sha !== task.expectedSha) throw new ContinuityError('Remote base SHA changed before write', { code: 'STALE_SHA' });
    const refPath = `/git/ref/heads/${task.workingBranch.split('/').map(encodeURIComponent).join('/')}`;
    let branch;
    try {
      branch = await this.request('/git/refs', { method: 'POST', body: { ref: `refs/heads/${task.workingBranch}`, sha: task.expectedSha } });
    } catch (error) {
      if (error.status !== 422) throw error;
      branch = await this.request(refPath);
    }
    const contentPath = `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(task.workingBranch)}`;
    let existing = null;
    try { existing = await this.request(contentPath); } catch (error) { if (error.status !== 404) throw error; }
    let commitSha = branch.object.sha;
    if (existing) {
      const existingContent = Buffer.from(String(existing.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
      if (existingContent !== content) throw new ContinuityError('Working branch already contains different content', { code: 'IDEMPOTENCY_CONFLICT' });
      branch = await this.request(refPath);
      commitSha = branch.object.sha;
    } else {
      if (branch.object.sha !== task.expectedSha) throw new ContinuityError('Working branch diverged before the controlled write', { code: 'IDEMPOTENCY_CONFLICT' });
      const commit = await this.request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: { message, content: Buffer.from(content).toString('base64'), branch: task.workingBranch } });
      commitSha = commit.commit.sha;
    }
    const pulls = await this.request(`/pulls?state=open&head=${encodeURIComponent(`FahadTrail:${task.workingBranch}`)}`);
    const pr = pulls[0] || await this.request('/pulls', { method: 'POST', body: { title: 'Continuity POC: verified provider handoff', head: task.workingBranch, base: task.baseBranch, body: 'Controlled Phase 1 POC proof. GPT-5.3-Codex produced the artifact; a simulated 429 triggered a checkpointed handoff; Claude Sonnet 5 verified it; the controller ran the repository tests before this commit.' } });
    return { commitSha, pullRequestUrl: pr.html_url, pullRequestNumber: pr.number };
  }
}

export function verifyHandoff({ task, checkpoint, snapshot }) {
  const mismatches = [];
  const saved = checkpoint.repo_state || checkpoint.repoState || {};
  if (snapshot.repository !== task.repository) mismatches.push('repository');
  if (snapshot.branch !== task.workingBranch) mismatches.push('branch');
  if (snapshot.sha !== task.expectedSha) mismatches.push('sha');
  if (!snapshot.tests?.passed) mismatches.push('tests');
  if (snapshot.files.some((file) => !task.allowedFiles.includes(file))) mismatches.push('files');
  if (!['verify', 'handoff'].includes(checkpoint.stage) || checkpoint.expected_sha !== task.expectedSha) mismatches.push('checkpoint');
  if (saved.repository !== snapshot.repository || saved.branch !== snapshot.branch || saved.sha !== snapshot.sha || saved.status !== snapshot.status || JSON.stringify(saved.files) !== JSON.stringify(snapshot.files) || saved.tests?.passed !== snapshot.tests?.passed) mismatches.push('checkpoint_state');
  if (mismatches.length) throw new ContinuityError(`Handoff verification failed: ${mismatches.join(', ')}`, { code: 'HANDOFF_MISMATCH' });
  return { verifiedAt: new Date().toISOString(), repository: snapshot.repository, branch: snapshot.branch, sha: snapshot.sha, status: snapshot.status, files: snapshot.files, tests: snapshot.tests };
}

export function leaseToken() { return randomUUID(); }
