// Coding Agent tool catalog. Every real action goes through the Tool Broker
// (workspace grant + agent permission + risk floor + audit ledger); the
// handlers below run in an in-process MCP server bound to one session.
//
// Model-facing tools use portable names (read_file, run_command, ...).
// Controller-owned tools (commit, push, PR, CI, merge, deploy) are never
// offered to the model; the controller calls them itself, through the same
// broker, so they are audited and policy-checked identically.

import { McpClientAdapter, InMemoryMcpTransport } from '../tool-broker/mcp-client.js';
import { truncate } from '../model-gateway/agentic/conversation.js';

export const CODING_BROKER = 'coding';
export const CODING_SERVER = 'coding-sandbox';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

const GITHUB = 'env://CODING_GITHUB_TOKEN';
const SUPABASE = 'env://CODING_SUPABASE_ACCESS_TOKEN';

// name, action, scopes, risk, secretRef, timeoutMs, input schema, model tool (optional)
const DEFINITIONS = [
  { name: 'repo.list', action: 'read', scopes: ['sandbox:read'], risk: 'low', timeoutMs: 60_000,
    input: object({ path: str('Directory relative to the repository root'), max: int('Maximum entries', { minimum: 1, maximum: 2000 }) }),
    model: { name: 'list_files', description: 'List files (respecting .gitignore) under a repository directory.' } },
  { name: 'repo.read', action: 'read', scopes: ['sandbox:read'], risk: 'low', timeoutMs: 30_000, maxOutputBytes: 400_000,
    input: object({ path: str('File path relative to the repository root'), start_line: int('First line (1-based)', { minimum: 1 }), end_line: int('Last line', { minimum: 1 }) }, ['path']),
    model: { name: 'read_file', description: 'Read a text file with line numbers. Use start_line/end_line for large files.' } },
  { name: 'repo.search', action: 'read', scopes: ['sandbox:read'], risk: 'low', timeoutMs: 60_000,
    input: object({ pattern: str('Regular expression (ripgrep syntax)'), path: str('Directory or file to search'), glob: str('Optional glob filter, e.g. *.js') }, ['pattern']),
    model: { name: 'search_code', description: 'Search the repository with ripgrep and return matching lines.' } },
  { name: 'repo.write', action: 'write', scopes: ['sandbox:write'], risk: 'low', timeoutMs: 30_000, maxInputBytes: 1_048_576,
    input: object({ path: str('File path relative to the repository root'), content: str('Complete new file content') }, ['path', 'content']),
    model: { name: 'write_file', description: 'Create or overwrite a file with the complete content.' } },
  { name: 'repo.edit', action: 'write', scopes: ['sandbox:write'], risk: 'low', timeoutMs: 30_000, maxInputBytes: 1_048_576,
    input: object({ path: str('File path'), old_text: str('Exact existing text to replace'), new_text: str('Replacement text'), replace_all: { type: 'boolean', description: 'Replace every occurrence' } }, ['path', 'old_text', 'new_text']),
    model: { name: 'edit_file', description: 'Replace an exact text span in a file. old_text must match exactly once unless replace_all is true.' } },
  { name: 'shell.run', action: 'execute', scopes: ['sandbox:execute'], risk: 'medium', timeoutMs: 1_800_000, maxOutputBytes: 400_000,
    input: object({ command: str('Shell command executed with bash in the repository root'), timeout_seconds: int('Timeout in seconds (default 300, max 1800)', { minimum: 5, maximum: 1800 }) }, ['command']),
    model: { name: 'run_command', description: 'Run a shell command in the isolated sandbox (install dependencies, build, test, lint, inspect). Publishing and remote access are controller-owned.' } },
  { name: 'git.status', action: 'read', scopes: ['sandbox:read'], risk: 'low', timeoutMs: 60_000,
    input: object({}), model: { name: 'git_status', description: 'Show the work branch, head commit and changed files.' } },
  { name: 'git.diff', action: 'read', scopes: ['sandbox:read'], risk: 'low', timeoutMs: 60_000, maxOutputBytes: 400_000,
    input: object({ path: str('Optional file path') }), model: { name: 'git_diff', description: 'Show the uncommitted diff of the working tree.' } },
  { name: 'git.commit', action: 'write', scopes: ['sandbox:write'], risk: 'low', timeoutMs: 120_000,
    input: object({ message: str('Commit message') }, ['message']) },
  { name: 'git.push', action: 'publish', scopes: ['github:branch'], risk: 'medium', timeoutMs: 600_000, secretRef: GITHUB,
    input: object({ branch: str('Work branch'), expected_head: str('Tested head commit'), previous_head: str('Head this session pushed before, if any') }, ['branch', 'expected_head']) },
  { name: 'github.pr_create', action: 'publish', scopes: ['github:pull_request'], risk: 'medium', timeoutMs: 60_000, secretRef: GITHUB,
    input: object({ branch: str('Head branch'), base: str('Base branch'), title: str('Title'), body: str('Body') }, ['branch', 'base', 'title', 'body']) },
  { name: 'github.pr_status', action: 'read', scopes: ['github:read'], risk: 'low', timeoutMs: 60_000, secretRef: GITHUB,
    input: object({ number: int('Pull request number', { minimum: 1 }) }, ['number']) },
  { name: 'github.ci_status', action: 'read', scopes: ['github:read'], risk: 'low', timeoutMs: 60_000, secretRef: GITHUB,
    input: object({ sha: str('Commit SHA') }, ['sha']) },
  { name: 'github.ci_logs', action: 'read', scopes: ['github:read'], risk: 'low', timeoutMs: 120_000, secretRef: GITHUB, maxOutputBytes: 200_000,
    input: object({ job_id: int('Actions job id', { minimum: 1 }) }, ['job_id']) },
  { name: 'github.pr_merge', action: 'merge', scopes: ['github:merge'], risk: 'medium', timeoutMs: 120_000, secretRef: GITHUB,
    input: object({ number: int('Pull request number', { minimum: 1 }), sha: str('Expected head SHA') }, ['number', 'sha']) },
  { name: 'deploy.status', action: 'read', scopes: ['github:read'], risk: 'low', timeoutMs: 60_000, secretRef: GITHUB,
    input: object({ workflow: str('Workflow file name'), sha: str('Commit SHA') }, ['workflow', 'sha']) },
  { name: 'verify.http', action: 'read', scopes: ['network:https'], risk: 'low', timeoutMs: 60_000,
    input: object({ url: str('HTTPS URL on an allowlisted host') }, ['url']),
    model: { name: 'verify_url', description: 'Fetch an allowlisted HTTPS URL (for example a deployed health endpoint) and return status and body excerpt.' } },
  { name: 'supabase.query_read', action: 'read', scopes: ['supabase:read'], risk: 'medium', timeoutMs: 120_000, secretRef: SUPABASE, maxOutputBytes: 300_000,
    input: object({ project_ref: str('Supabase project reference'), sql: str('Single read-only SELECT/WITH statement') }, ['project_ref', 'sql']),
    model: { name: 'supabase_query', description: 'Run one read-only SQL query against an allowlisted Supabase project.' } },
  { name: 'supabase.query_write', action: 'write', scopes: ['supabase:write'], risk: 'high', timeoutMs: 120_000, secretRef: SUPABASE,
    input: object({ project_ref: str('Supabase project reference'), sql: str('SQL that changes data'), reason: str('Why this change is needed') }, ['project_ref', 'sql', 'reason']),
    model: { name: 'supabase_execute', description: 'Run data-changing SQL on an allowlisted Supabase project. Always requires owner approval.' } },
  { name: 'supabase.migration_apply', action: 'write', scopes: ['supabase:migration'], risk: 'high', timeoutMs: 300_000, secretRef: SUPABASE,
    input: object({ project_ref: str('Supabase project reference'), name: str('snake_case migration name'), sql: str('Migration SQL'), reason: str('Why') }, ['project_ref', 'name', 'sql', 'reason']),
    model: { name: 'supabase_apply_migration', description: 'Apply a schema migration to an allowlisted Supabase project. Always requires owner approval.' } },
];

export const CODING_TOOL_DEFINITIONS = Object.freeze(DEFINITIONS.map((definition) => Object.freeze({
  broker: CODING_BROKER,
  server: CODING_SERVER,
  name: definition.name,
  action: definition.action,
  description: definition.model?.description || `Controller-owned ${definition.name}`,
  risk: definition.risk,
  scopes: definition.scopes,
  agentPermission: definition.name,
  secretRef: definition.secretRef || null,
  inputSchema: definition.input,
  timeoutMs: definition.timeoutMs,
  maxRetries: 0,
  retrySafe: false,
  estimatedCostUsd: 0,
  maxInputBytes: definition.maxInputBytes || 131_072,
  maxOutputBytes: definition.maxOutputBytes || 131_072,
})));

export const CODING_SECRET_REFERENCES = Object.freeze([GITHUB, SUPABASE]);

// Tools the controller handles itself (state updates and loop control).
export const CONTROL_TOOLS = Object.freeze([
  { name: 'update_plan', description: 'Record the current plan and the next intended action. Call it after understanding the task and whenever the plan changes.',
    inputSchema: object({
      steps: { type: 'array', description: 'Ordered plan steps', items: object({ title: str('Step'), status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, ['title', 'status']) },
      next_action: str('The next concrete action'),
    }, ['steps', 'next_action']) },
  { name: 'record_note', description: 'Persist an important discovery (root cause, constraint, decision) so it survives restarts and model switches.',
    inputSchema: object({ note: str('The discovery, one or two sentences') }, ['note']) },
  { name: 'finish', description: 'Declare the implementation complete. The controller then runs the test gate, security checks, commits, publishes and follows CI.',
    inputSchema: object({ summary: str('What was changed and why'), tests_run: str('Commands you ran and their outcome') }, ['summary']) },
  { name: 'request_human', description: 'Stop and ask the owner only when genuinely blocked (missing credential, ambiguous product decision, destructive action). Not for routine choices.',
    inputSchema: object({ reason: str('Why progress is impossible without a human'), question: str('The precise question or action needed') }, ['reason', 'question']) },
]);

export function modelToolSpecs({ supabase = false } = {}) {
  const specs = DEFINITIONS.filter((definition) => definition.model)
    .filter((definition) => supabase || !definition.name.startsWith('supabase.'))
    .map((definition) => ({ name: definition.model.name, description: definition.model.description, inputSchema: definition.input }));
  return [...specs, ...CONTROL_TOOLS];
}

export const MODEL_TOOL_TO_BROKER = Object.freeze(Object.fromEntries(
  DEFINITIONS.filter((definition) => definition.model).map((definition) => [definition.model.name, { tool: definition.name, action: definition.action }]),
));

// Handlers are bound to one session's sandbox and integrations.
export function createCodingToolServer({ sandbox, github, supabase, verifyHosts = [], fetchFn = fetch, maxShellMs = 1_800_000, pushUrl = null }) {
  const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
  const result = (structured, rendered = null) => ({ ...text(rendered ?? structured), structuredContent: structured });
  const githubWith = (credential) => github(credential);
  const supabaseWith = (credential) => supabase(credential);
  const handlers = {
    'repo.list': async (args) => {
      const listing = await sandbox.listFiles(args.path || '.', { max: args.max || 400 });
      return result(listing, `${listing.files.join('\n')}${listing.truncated ? `\n… ${listing.total - listing.files.length} more` : ''}`);
    },
    'repo.read': async (args) => {
      const file = await sandbox.readFile(args.path, { startLine: args.start_line, endLine: args.end_line });
      const header = file.binary ? `${file.path}: binary file (${file.bytes} bytes)`
        : `${file.path} (lines ${file.startLine}-${file.endLine} of ${file.totalLines}${file.truncated ? ', file truncated at 400 KB' : ''})`;
      return result({ path: file.path, startLine: file.startLine, endLine: file.endLine, totalLines: file.totalLines }, `${header}\n${file.content}`);
    },
    'repo.search': async (args) => {
      const found = await sandbox.search(args.pattern, { path: args.path || '.', glob: args.glob || null });
      return result({ total: found.total, truncated: found.truncated }, found.matches.length ? found.matches.join('\n') : 'No matches.');
    },
    'repo.write': async (args) => result(await sandbox.writeFile(args.path, args.content)),
    'repo.edit': async (args) => result(await sandbox.editFile(args.path, args.old_text, args.new_text, { replaceAll: args.replace_all === true })),
    'shell.run': async (args) => {
      const timeoutMs = Math.min(maxShellMs, (args.timeout_seconds || 300) * 1000);
      const run = await sandbox.shell(args.command, { timeoutMs });
      const rendered = [
        `exit_code: ${run.exitCode}${run.timedOut ? ' (timed out)' : ''} duration_ms: ${run.durationMs}`,
        run.stdout ? `--- stdout ---\n${truncate(run.stdout, 16_000)}` : '',
        run.stderr ? `--- stderr ---\n${truncate(run.stderr, 8_000)}` : '',
      ].filter(Boolean).join('\n');
      return result({ exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs }, rendered);
    },
    'git.status': async () => {
      const state = await sandbox.gitState();
      return result(state, `branch ${state.branch} at ${state.head}\n${state.changed.map((entry) => `${entry.status} ${entry.path}`).join('\n') || 'clean'}`);
    },
    'git.diff': async (args) => {
      const diff = await sandbox.diff({ path: args.path || null });
      return result({ truncated: diff.truncated }, diff.diff || 'No changes.');
    },
    'git.commit': async (args) => result(await sandbox.commitAll(args.message)),
    'git.push': async (args, { credential }) => result(await sandbox.publishBranch({
      repository: github(credential).repository, branch: args.branch, token: credential, expectedHead: args.expected_head, previousHead: args.previous_head || null, pushUrl,
    })),
    'github.pr_create': async (args, { credential }) => result(await githubWith(credential).createPullRequest(args)),
    'github.pr_status': async (args, { credential }) => result(await githubWith(credential).getPullRequest(args.number)),
    'github.ci_status': async (args, { credential }) => result(await githubWith(credential).ciStatus(args.sha)),
    'github.ci_logs': async (args, { credential }) => {
      const log = await githubWith(credential).jobLogTail(args.job_id);
      return result({ jobId: args.job_id }, log);
    },
    'github.pr_merge': async (args, { credential }) => result(await githubWith(credential).mergePullRequest({ number: args.number, sha: args.sha })),
    'deploy.status': async (args, { credential }) => {
      const runs = await githubWith(credential).workflowRunsForCommit({ workflow: args.workflow, sha: args.sha });
      return result({ runs });
    },
    'verify.http': async (args) => result(await verifyHttp(args.url, { hosts: verifyHosts, fetchFn })),
    'supabase.query_read': async (args, { credential }) => {
      const rows = await supabaseWith(credential).queryReadOnly(args.project_ref, args.sql);
      return result({ rowCount: rows.rowCount }, truncate(JSON.stringify(rows.rows, null, 2), 40_000));
    },
    'supabase.query_write': async (args, { credential }) => result(await supabaseWith(credential).execute(args.project_ref, args.sql)),
    'supabase.migration_apply': async (args, { credential }) => result(await supabaseWith(credential).applyMigration(args.project_ref, args.name, args.sql)),
  };
  // Handler failures are returned to the model as structured tool errors (for
  // example "old_text was not found") rather than aborting the session.
  const guarded = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args, options) => {
    try {
      return await handler(args, options);
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code || '') ? error.code : 'TOOL_FAILED';
      return { content: [{ type: 'text', text: `${code}: ${String(error?.message || 'tool failed').slice(0, 2000)}` }], structuredContent: { error: code }, isError: false, _meta: { toolError: code } };
    }
  }]));
  const transport = new InMemoryMcpTransport({
    serverInfo: { name: CODING_SERVER, version: '1.0.0' },
    tools: CODING_TOOL_DEFINITIONS.map((definition) => ({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema })),
    handlers: guarded,
  });
  return new McpClientAdapter({ name: CODING_SERVER, transport });
}

export async function verifyHttp(url, { hosts = [], fetchFn = fetch } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw Object.assign(new Error('Invalid URL'), { code: 'VERIFY_URL_INVALID' }); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Object.assign(new Error('Only credential-free HTTPS URLs are allowed'), { code: 'VERIFY_URL_INVALID' });
  if (!hosts.includes(parsed.hostname)) throw Object.assign(new Error(`${parsed.hostname} is not an allowlisted verification host`), { code: 'VERIFY_HOST_NOT_ALLOWED' });
  const startedAt = Date.now();
  const response = await fetchFn(parsed.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return {
    url: parsed.href,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    json: json && typeof json === 'object' ? json : null,
    body: body.slice(0, 2000),
  };
}
