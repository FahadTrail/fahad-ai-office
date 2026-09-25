// Minimal GitHub REST client for controller-owned operations. The token is
// held by the controller only; responses are reduced to the fields the
// agent needs and log output is redacted before it reaches a model.

import { redact } from './policy.js';

export class GitHubClient {
  constructor({ token, repository, fetchFn = fetch, apiBase = 'https://api.github.com', env = process.env }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new TypeError('A GitHub repository (owner/name) is required');
    this.token = token;
    this.repository = repository;
    this.fetchFn = fetchFn;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.env = env;
  }

  async request(path, { method = 'GET', body = null, raw = false } = {}) {
    if (!this.token) throw githubError('GITHUB_TOKEN_UNAVAILABLE', 'No GitHub credential is configured for the Coding Agent', 401);
    const response = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json())?.message || ''; } catch {}
      throw githubError(`GITHUB_HTTP_${response.status}`, `GitHub ${method} ${path.split('?')[0]} failed (HTTP ${response.status})${message ? `: ${redact(message, this.env, 300)}` : ''}`, response.status);
    }
    if (raw) return response.text();
    if (response.status === 204) return null;
    return response.json();
  }

  repoPath(suffix = '') {
    return `/repos/${this.repository}${suffix}`;
  }

  async findPullRequest(branch) {
    const owner = this.repository.split('/')[0];
    const pulls = await this.request(this.repoPath(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`));
    return pulls[0] ? summarizePull(pulls[0]) : null;
  }

  async createPullRequest({ branch, base, title, body }) {
    const existing = await this.findPullRequest(branch);
    if (existing) return { ...existing, reused: true };
    const pull = await this.request(this.repoPath('/pulls'), { method: 'POST', body: { title, head: branch, base, body, draft: false } });
    return { ...summarizePull(pull), reused: false };
  }

  async getPullRequest(number) {
    return summarizePull(await this.request(this.repoPath(`/pulls/${Number(number)}`)));
  }

  // Combined CI verdict for a commit: GitHub Actions check runs plus legacy
  // commit statuses. "pending" until every reported check has completed.
  async ciStatus(sha) {
    const [checks, statuses] = await Promise.all([
      this.request(this.repoPath(`/commits/${sha}/check-runs?per_page=100`)),
      this.request(this.repoPath(`/commits/${sha}/status`)),
    ]);
    const runs = (checks.check_runs || []).map((run) => ({
      id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url,
    }));
    const contexts = (statuses.statuses || []).map((status) => ({ name: status.context, state: status.state, url: status.target_url }));
    const failing = [
      ...runs.filter((run) => run.status === 'completed' && !['success', 'neutral', 'skipped'].includes(run.conclusion)),
      ...contexts.filter((status) => ['failure', 'error'].includes(status.state)),
    ];
    const pending = runs.some((run) => run.status !== 'completed') || contexts.some((status) => status.state === 'pending');
    const total = runs.length + contexts.length;
    return {
      sha,
      state: failing.length ? 'failure' : pending || total === 0 ? 'pending' : 'success',
      total,
      runs,
      statuses: contexts,
      failing: failing.map((item) => item.name),
    };
  }

  // Excerpt of a failed Actions job's log, redacted, for debugging: the
  // failure lines with context (test runners print them long before the end
  // of the log) followed by the tail.
  async jobLogTail(jobId, lines = 150) {
    const text = await this.request(this.repoPath(`/actions/jobs/${Number(jobId)}/logs`), { raw: true });
    return redact(ciLogExcerpt(text, { tailLines: lines }), this.env, 30_000);
  }

  async mergePullRequest({ number, sha, method = 'merge' }) {
    const result = await this.request(this.repoPath(`/pulls/${Number(number)}/merge`), {
      method: 'PUT', body: { sha, merge_method: method },
    });
    return { merged: Boolean(result?.merged), sha: result?.sha || null };
  }

  async workflowRunsForCommit({ workflow, sha }) {
    const result = await this.request(this.repoPath(`/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=5`));
    return (result.workflow_runs || []).map((run) => ({
      id: run.id, status: run.status, conclusion: run.conclusion, url: run.html_url, createdAt: run.created_at,
    }));
  }
}

const FAILURE_LINE = /^\s*not ok\b|\bAssertionError\b|^\s*(?:Error|TypeError|ReferenceError|SyntaxError):|##\[error\]|\bFAIL\b|^\s*✖|\bfailing\b|^# fail [1-9]/;

export function ciLogExcerpt(text, { tailLines = 150, context = 12, maxFailureLines = 160 } = {}) {
  const lines = String(text || '').split('\n').map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, ''));
  const keep = new Set();
  for (let index = 0; index < lines.length && keep.size < maxFailureLines; index += 1) {
    if (!FAILURE_LINE.test(lines[index])) continue;
    for (let offset = -2; offset <= context; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length - tailLines) keep.add(target);
    }
  }
  const failures = [...keep].sort((left, right) => left - right).slice(0, maxFailureLines);
  const excerpt = [];
  let previous = -1;
  for (const index of failures) {
    if (index !== previous + 1) excerpt.push('…');
    excerpt.push(lines[index]);
    previous = index;
  }
  const tail = lines.slice(-tailLines);
  return (excerpt.length ? ['--- failure lines ---', ...excerpt, '--- end of log ---'] : []).concat(tail).join('\n');
}

function summarizePull(pull) {
  return {
    number: pull.number,
    url: pull.html_url,
    state: pull.state,
    merged: Boolean(pull.merged || pull.merged_at),
    mergeCommitSha: pull.merged || pull.merged_at ? pull.merge_commit_sha || null : null,
    mergeable: pull.mergeable ?? null,
    mergeableState: pull.mergeable_state || null,
    headSha: pull.head?.sha || null,
    headRef: pull.head?.ref || null,
    baseRef: pull.base?.ref || null,
  };
}

function githubError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
