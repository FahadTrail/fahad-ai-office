import test from 'node:test';
import { withIsolatedSandboxLock } from '../testing/fixtures/uid-lock.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sandbox, resolveSandboxMode } from '../src/coding-agent/sandbox.js';
import {
  assertWritablePath, checkCommand, classifyChangedPaths, findSecretMaterial, normalizeRepoPath, redact, sandboxEnvironment,
} from '../src/coding-agent/policy.js';
import { SupabaseManagementClient, assertReadOnlySql } from '../src/coding-agent/supabase.js';
import { verifyHttp } from '../src/coding-agent/tools.js';
import { createFixtureRepo } from '../testing/fixtures/coding-agent-harness.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0 && process.platform === 'linux';

async function preparedSandbox(mode = 'unisolated') {
  const root = mkdtempSync(join(tmpdir(), 'fahad-sandbox-'));
  if (mode === 'isolated') chmodSync(root, 0o755);
  const { bare } = createFixtureRepo(root);
  const sandbox = new Sandbox({ root: join(root, 'work'), sessionId: randomUUID(), mode });
  await sandbox.prepare({ repository: 'FahadTrail/demo-app', baseBranch: 'main', workBranch: 'fahad/test', fetchUrl: bare });
  return { root, sandbox };
}

test('repository paths cannot escape the worktree or touch git metadata', () => {
  assert.equal(normalizeRepoPath('./src//a.js'), 'src/a.js');
  for (const path of ['../x', '/etc/passwd', 'src/../../x', '.git/config', 'C:/x']) {
    assert.throws(() => normalizeRepoPath(path), /Paths may not leave|relative|metadata/);
  }
});

test('Hermes and protected paths are enforced', () => {
  assert.throws(() => assertWritablePath('hermes/agent.js'), (error) => error.code === 'HERMES_PROTECTED');
  assert.throws(() => assertWritablePath('services/Hermes/x.py'), (error) => error.code === 'HERMES_PROTECTED');
  assert.throws(() => assertWritablePath('.github/workflows/deploy.yml'), (error) => error.code === 'PROTECTED_PATH');
  assert.throws(() => assertWritablePath('.env.production'), (error) => error.code === 'PROTECTED_PATH');
  assert.equal(assertWritablePath('.github/workflows/deploy.yml', { allowProtected: true }), '.github/workflows/deploy.yml');
  assert.throws(() => assertWritablePath('hermes/x', { allowProtected: true }), (error) => error.code === 'HERMES_PROTECTED');
  assert.deepEqual(classifyChangedPaths(['src/a.js', 'Hermes/b.js', 'ops/deploy.sh']), { hermes: ['Hermes/b.js'], protected: ['ops/deploy.sh'] });
});

test('command policy blocks controller-owned and host-level actions', () => {
  for (const command of ['git push origin main', 'sudo rm x', 'ssh host', 'docker ps', 'cat /proc/1/environ', 'rm -rf /', 'git remote set-url origin x', 'ls hermes/']) {
    assert.throws(() => checkCommand(command), /not|refusing|Hermes|controller/i, command);
  }
  for (const command of ['npm ci && npm test', 'node --test', 'rm -rf node_modules', 'git status && git diff', 'grep -r push src']) {
    assert.equal(checkCommand(command), command);
  }
});

test('secret detection and redaction cover configured values and token shapes', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-configured-value-123456789' };
  assert.equal(findSecretMaterial('const k = "sk-ant-configured-value-123456789"', env), 'configured credential value');
  assert.equal(findSecretMaterial('token ghp_abcdefghijklmnopqrstuvwxyz0123', {}), 'credential-shaped token');
  assert.equal(findSecretMaterial('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.payload', {}), 'credential-shaped token');
  assert.equal(findSecretMaterial('export function add(a, b) { return a + b; }', env), null);
  assert.doesNotMatch(redact('key sk-ant-configured-value-123456789 and Bearer abcdefghijk', env), /configured-value|abcdefghijk/);
  const sandboxEnv = sandboxEnvironment({ home: '/tmp/h' });
  for (const name of ['ANTHROPIC_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CODING_GITHUB_TOKEN']) assert.equal(sandboxEnv[name], undefined);
});

test('read-only Supabase SQL rejects writes, multiple statements and data-modifying CTEs', () => {
  assert.equal(assertReadOnlySql('select * from jobs where title = \'drop table x\';'), "select * from jobs where title = 'drop table x'");
  for (const sql of ['delete from jobs', 'select 1; drop table jobs', 'with x as (delete from jobs returning *) select * from x', 'update jobs set a=1', 'copy jobs to stdout']) {
    assert.throws(() => assertReadOnlySql(sql), /read-only|single statement|modifying/i, sql);
  }
});

test('verification only fetches allowlisted credential-free HTTPS hosts', async () => {
  await assert.rejects(verifyHttp('http://office.example.test/healthz', { hosts: ['office.example.test'] }), /HTTPS/);
  await assert.rejects(verifyHttp('https://evil.example/healthz', { hosts: ['office.example.test'] }), /allowlisted/);
  const result = await verifyHttp('https://office.example.test/healthz', {
    hosts: ['office.example.test'], fetchFn: async () => new Response('{"ok":true,"version":"abc1234"}', { status: 200 }),
  });
  assert.equal(result.json.version, 'abc1234');
});

test('sandbox file operations stay inside the worktree even through symlinks', async () => {
  const { root, sandbox } = await preparedSandbox();
  try {
    const outside = join(root, 'outside-secret.txt');
    writeFileSync(outside, 'TOP SECRET');
    symlinkSync(outside, join(sandbox.repoDir, 'link.txt'));
    symlinkSync(root, join(sandbox.repoDir, 'linkdir'));
    await assert.rejects(sandbox.readFile('link.txt'), (error) => error.code === 'PATH_ESCAPE');
    await assert.rejects(sandbox.readFile('linkdir/outside-secret.txt'), (error) => error.code === 'PATH_ESCAPE');
    await assert.rejects(sandbox.writeFile('link.txt', 'overwrite'), (error) => ['SYMLINK_WRITE', 'PATH_ESCAPE'].includes(error.code));
    await assert.rejects(sandbox.writeFile('linkdir/new.txt', 'x'), (error) => ['SYMLINK_WRITE', 'PATH_ESCAPE'].includes(error.code));
    assert.equal(readFileSync(outside, 'utf8'), 'TOP SECRET');
    await sandbox.writeFile('src/new/deep.js', 'export const x = 1;\n');
    assert.match((await sandbox.readFile('src/new/deep.js')).content, /export const x/);
    await assert.rejects(sandbox.editFile('src/math.js', 'not present', 'y'), (error) => error.code === 'EDIT_NOT_FOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated mode is refused without root and unisolated mode is refused in production', () => {
  if (!isRoot) assert.throws(() => resolveSandboxMode({ CODING_AGENT_SANDBOX: 'isolated' }), (error) => error.code === 'SANDBOX_UNAVAILABLE');
  assert.throws(() => resolveSandboxMode({ CODING_AGENT_SANDBOX: 'unisolated', NODE_ENV: 'production' }), (error) => error.code === 'SANDBOX_UNSAFE');
});

test('isolated mode runs agent commands as an unprivileged uid that cannot read controller secrets', { skip: !isRoot && 'requires container root on Linux' }, () => withIsolatedSandboxLock(async () => {
  const { root, sandbox } = await preparedSandbox('isolated');
  try {
    const secret = join(root, 'controller-secret');
    writeFileSync(secret, 'CONTROLLER ONLY', { mode: 0o600 });
    const whoami = await sandbox.shell('id -u');
    assert.equal(whoami.stdout.trim(), '1000');
    const attempt = await sandbox.shell(`cat ${secret}`);
    assert.notEqual(attempt.exitCode, 0);
    assert.doesNotMatch(attempt.stdout, /CONTROLLER ONLY/);
    // The command policy blocks obvious probes; the OS boundary must hold even
    // when the probe is obfuscated past that hygiene layer.
    assert.throws(() => checkCommand('cat /proc/1/environ'), /not readable/);
    const environ = await sandbox.shell(`p=/proc/${process.pid}; cat "$p/env""iron" > /dev/null 2>&1 && echo READABLE || echo DENIED`);
    assert.match(environ.stdout, /DENIED/);
    const own = await sandbox.shell('env');
    assert.doesNotMatch(own.stdout, /SERVICE_ROLE|API_KEY=|GITHUB_TOKEN=|GH_TOKEN=/);
    // Background processes do not survive the tool call.
    const started = Date.now();
    const background = await sandbox.shell('(sleep 30 &) ; echo started');
    assert.match(background.stdout, /started/);
    assert.ok(Date.now() - started < 10_000, 'a background process cannot hold the tool call open');
    const leftovers = await sandbox.shell("for s in /proc/[0-9]*/status; do awk '/^Name:/{n=$2} /^State:/{st=$2} /^Uid:/{u=$2} END{if (n==\"sleep\" && st!=\"Z\" && u==1000) print \"alive\"}' $s 2>/dev/null; done; echo checked");
    assert.doesNotMatch(leftovers.stdout, /alive/);
    // Controller-written files are handed to the sandbox identity.
    await sandbox.writeFile('src/owned.js', 'x');
    assert.equal(statSync(join(sandbox.repoDir, 'src/owned.js')).uid, 1000);
    const test = await sandbox.shell('npm test');
    assert.equal(test.exitCode, 1, 'the fixture test fails before the fix');
    assert.match(test.stdout + test.stderr, /add sums numbers/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}));

test('Supabase reads run through the read-only database role; writes never take that path', async () => {
  const calls = [];
  let readOnlyAvailable = true;
  const fetchFn = async (url, init) => {
    calls.push(new URL(url).pathname);
    if (String(url).endsWith('/read-only') && !readOnlyAvailable) return new Response('{"message":"not found"}', { status: 404 });
    return new Response(JSON.stringify([{ rows: [{ n: 1 }] }]), { status: 201 });
  };
  const ref = 'zkzibipinjeswhdxnfgf';
  const client = new SupabaseManagementClient({ token: 'sbp_test_token_0123456789abcdef', allowedProjects: [ref], fetchFn, apiBase: 'https://api.supabase.test' });
  assert.deepEqual(await client.queryReadOnly(ref, 'select 1 as n'), { rows: [{ n: 1 }], rowCount: 1 });
  assert.deepEqual(calls, [`/v1/projects/${ref}/database/query/read-only`]);
  readOnlyAvailable = false;
  calls.length = 0;
  await client.queryReadOnly(ref, 'select 1 as n');
  assert.deepEqual(calls, [`/v1/projects/${ref}/database/query/read-only`, `/v1/projects/${ref}/database/query`], 'validated fallback only on 404');
  calls.length = 0;
  await assert.rejects(client.queryReadOnly(ref, 'delete from agent_events'), /SQL_NOT_READ_ONLY|must start with/);
  await assert.rejects(client.queryReadOnly('abcdefghijklmnopqrst', 'select 1'), /not in this session's allowlist/);
  await assert.rejects(new SupabaseManagementClient({ token: null, allowedProjects: [ref], fetchFn }).queryReadOnly(ref, 'select 1'), /No Supabase access token/);
  assert.deepEqual(calls, [], 'refusals happen before the network');
});
