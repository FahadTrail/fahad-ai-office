import { randomUUID } from 'node:crypto';
import { chmod, lchown, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_MODEL,
  resolveDevelopmentProviderRoute,
  assertContainedPath,
  assertNoSecretMaterial,
  assertSafeChangedPaths,
  buildAgentPrompt,
  buildModelEnvironment,
  buildTestEnvironment,
  createOpenCodeConfig,
  parseOpenCodeEvents,
  redact,
  safeTaskSlug,
  summarizeOpenCodeUsage,
  validateObjective,
} from './policy.js';

const REPOSITORY = 'FahadTrail/fahad-ai-office';
export const MAIN_REMOTE_REFSPEC = '+refs/heads/main:refs/remotes/origin/main';
const MODEL_IDENTITY = Object.freeze({ uid: 1000, gid: 1000 });
const TEST_IDENTITY = Object.freeze({ uid: 65534, gid: 65534 });
const ORIGIN_URLS = new Set([
  `https://github.com/${REPOSITORY}.git`,
  `git@github.com:${REPOSITORY}.git`,
]);

export async function runDevelopmentObjective({
  objective,
  sourceRepository,
  isolatedRoot,
  opencodeBin = 'opencode',
  model = DEFAULT_MODEL,
  env = process.env,
  fetchFn = fetch,
  run = runCommand,
  maxRepairRounds = 2,
  publish = true,
} = {}) {
  objective = validateObjective(objective);
  const providerRoute = resolveDevelopmentProviderRoute({ env, model, requiresPrivateData: true });
  if (publish) assertSecret(env.CONTINUITY_GITHUB_TOKEN, 'CONTINUITY_GITHUB_TOKEN');
  sourceRepository = resolve(sourceRepository);
  isolatedRoot = resolve(isolatedRoot);
  const taskId = randomUUID();
  const budgetLimitUsd = readDevelopmentBudget(env.DEVELOPMENT_MAX_COST_USD);
  const branch = `automation/dev-${safeTaskSlug(objective)}-${taskId.slice(0, 8)}`;
  const worktree = assertContainedPath(isolatedRoot, join(isolatedRoot, 'worktrees', taskId));
  const controlDirectory = assertContainedPath(isolatedRoot, join(isolatedRoot, 'control', taskId));
  const secretFile = join(controlDirectory, 'provider.key');
  const configFile = join(controlDirectory, 'opencode.json');
  const modelHome = join(controlDirectory, 'home');

  const git = async (args, options = {}) => checked(run, 'git', args, { cwd: sourceRepository, timeoutMs: 120000, ...options });
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim()) throw new Error('Source repository must be clean before an isolated task starts');
  const origin = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
  if (!ORIGIN_URLS.has(origin)) throw new Error('Development escape route is restricted to the Fahad AI Office repository');

  await mkdir(dirname(worktree), { recursive: true, mode: 0o711 });
  await chmod(dirname(worktree), 0o711);
  await mkdir(modelHome, { recursive: true, mode: 0o700 });
  await chmod(dirname(controlDirectory), 0o711);
  await chmod(controlDirectory, 0o711);
  await prepareModelOwnedPath(modelHome);

  try {
    // Use an explicit remote-tracking refspec so the controller also works
    // from a shallow or single-branch source clone used by isolated runners.
    await checked(run, 'git', [
      'fetch', '--no-tags', 'origin',
      MAIN_REMOTE_REFSPEC,
    ], { cwd: sourceRepository, timeoutMs: 120000 });
    await checked(run, 'git', ['worktree', 'add', '-b', branch, worktree, 'origin/main'], { cwd: sourceRepository, timeoutMs: 120000 });
    await prepareModelOwnedPath(worktree, { recursive: true });
    await assertNoTrackedOpenCodeOverrides(run, worktree);

    const modelEnv = buildModelEnvironment({ hostEnv: env, configPath: configFile, isolatedHome: modelHome });
    let lastEvents = [];
    let cumulativeUsage = emptyUsage();
    let modelDurationMs = 0;
    let selectedProvider = null;
    let selectedModel = null;
    const providerAttempts = [];
    let tests = null;
    for (let round = 0; round <= maxRepairRounds; round += 1) {
      assertNoOpenCodeOverrides(await changedPaths(run, worktree));
      const prompt = buildAgentPrompt(objective, tests?.error || null);
      try {
        const modelRun = await runOpenCodeProviderRoute({
          run, opencodeBin, providerRoute, worktree, modelEnv, prompt, env, secretFile, configFile,
        });
        lastEvents = modelRun.events;
        cumulativeUsage = mergeUsage(cumulativeUsage, modelRun.usage);
        modelDurationMs += modelRun.durationMs;
        providerAttempts.push(...modelRun.providerAttempts);
        selectedProvider = modelRun.provider;
        selectedModel = modelRun.model;
        assertDevelopmentBudget(cumulativeUsage.costUsd, budgetLimitUsd);
      } finally {
        // No provider key remains on disk while generated code or tests execute.
        await Promise.all([unlink(secretFile).catch(() => {}), unlink(configFile).catch(() => {})]);
      }

      const paths = assertSafeChangedPaths(await changedPaths(run, worktree));
      if (!paths.length) throw new Error('Coding agent completed without a repository change');
      const diff = await checked(run, 'git', safeGitArgs(worktree, ['diff', '--no-ext-diff', '--binary', '--']), { cwd: worktree, timeoutMs: 120000, maxOutputBytes: 5_000_000 });
      assertNoSecretMaterial(diff.stdout);
      const diffCheck = await run('git', safeGitArgs(worktree, ['diff', '--check']), { cwd: worktree, timeoutMs: 120000 });
      if (diffCheck.code !== 0) {
        tests = { ok: false, error: redact(diffCheck.stderr || diffCheck.stdout, providerSecrets(env)) };
        continue;
      }
      await makeTreeReadableForTests(worktree);
      tests = await runValidation(run, worktree, env);
      if (tests.ok) break;
    }
    if (!tests?.ok) throw new Error('Coding agent exhausted repair rounds without passing validation');

    await checked(run, 'git', safeGitArgs(worktree, ['add', '--all']), { cwd: worktree, timeoutMs: 120000 });
    await checked(run, 'git', safeGitArgs(worktree, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fahad AI Office', '-c', 'user.email=automation@users.noreply.github.com',
      'commit', '-m', `Development objective: ${safeTaskSlug(objective)}`]), { cwd: worktree, timeoutMs: 120000 });
    const commitSha = (await checked(run, 'git', safeGitArgs(worktree, ['rev-parse', 'HEAD']), { cwd: worktree })).stdout.trim();

    let pullRequestUrl = null;
    if (publish) {
      await pushWithAskPass({ run, worktree, branch, token: env.CONTINUITY_GITHUB_TOKEN, controlDirectory });
      pullRequestUrl = await createPullRequest({ fetchFn, token: env.CONTINUITY_GITHUB_TOKEN, branch, objective, commitSha, provider: selectedProvider, model: selectedModel });
    }
    return {
      ok: true, taskId, branch, commitSha, pullRequestUrl, tests: tests.summary,
      model: selectedModel, provider: selectedProvider, providerAttempts,
      harness: 'opencode', eventCount: lastEvents.length, worktree,
      usage: { ...cumulativeUsage, durationMs: modelDurationMs, limitUsd: budgetLimitUsd },
    };
  } finally {
    // Remove temporary provider material even when a model or test fails.
    await Promise.all([
      unlink(secretFile).catch(() => {}),
      unlink(configFile).catch(() => {}),
      unlink(join(controlDirectory, 'git-askpass.sh')).catch(() => {}),
    ]);
  }
}

async function runOpenCodeProviderRoute({ run, opencodeBin, providerRoute, worktree, modelEnv, prompt, env, secretFile, configFile }) {
  const providerAttempts = [];
  let routeUsage = emptyUsage();
  let lastError;
  for (const profile of providerRoute) {
    const startedAt = Date.now();
    try {
      await writeFile(secretFile, env[profile.apiKeyEnv].trim(), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await writeFile(configFile, JSON.stringify(createOpenCodeConfig({ secretFile, profile })), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await prepareModelOwnedPath(secretFile);
      await prepareModelOwnedPath(configFile);
      const result = await runOpenCodeWithRetry({ run, opencodeBin, model: profile.model, pricing: profile.pricing, worktree, modelEnv, prompt });
      routeUsage = mergeUsage(routeUsage, result.usage);
      providerAttempts.push({ provider: profile.provider, model: profile.modelId, status: 'succeeded', usage: result.usage, durationMs: Date.now() - startedAt });
      return { ...result, usage: routeUsage, provider: profile.provider, model: profile.model, providerAttempts };
    } catch (error) {
      lastError = error;
      if (error.usage) routeUsage = mergeUsage(routeUsage, error.usage);
      providerAttempts.push({ provider: profile.provider, model: profile.modelId, status: 'failed', reason: 'provider_execution_failed', usage: error.usage || null, durationMs: Date.now() - startedAt });
    } finally {
      await Promise.all([unlink(secretFile).catch(() => {}), unlink(configFile).catch(() => {})]);
    }
  }
  const error = new Error(`All authorized development providers failed safely: ${lastError?.message || 'unknown failure'}`);
  error.providerAttempts = providerAttempts;
  error.usage = routeUsage;
  throw error;
}

async function runOpenCodeWithRetry({ run, opencodeBin, model, pricing, worktree, modelEnv, prompt }) {
  let lastError;
  const allEvents = [];
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const execution = await run(opencodeBin, [
      'run', '--model', model, '--agent', 'build', '--format', 'json', '--dir', worktree, prompt,
    ], { cwd: worktree, env: modelEnv, timeoutMs: 1800000, maxOutputBytes: 4_000_000, executionIdentity: 'model' });
    try {
      if (execution.code !== 0) throw new Error(`OpenCode execution exited ${execution.code}`);
      const events = parseOpenCodeEvents(execution.stdout);
      allEvents.push(...events);
      return { events, usage: summarizeOpenCodeUsage(allEvents, pricing), durationMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      try { allEvents.push(...parseOpenCodeEvents(execution.stdout)); } catch {}
      if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }
  const error = new Error(`OpenCode execution failed safely after automatic retry: ${lastError?.message || 'unknown failure'}`);
  try { error.usage = summarizeOpenCodeUsage(allEvents, pricing); } catch {}
  throw error;
}

function readDevelopmentBudget(value) {
  const budget = Number(value || 2);
  if (!Number.isFinite(budget) || budget < 0.01 || budget > 20) {
    throw new Error('DEVELOPMENT_MAX_COST_USD must be between 0.01 and 20');
  }
  return budget;
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, steps: 0 };
}

function mergeUsage(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, key === 'costUsd'
    ? Number((left[key] + right[key]).toFixed(8))
    : left[key] + right[key]]));
}

function assertDevelopmentBudget(spentUsd, limitUsd) {
  if (spentUsd <= limitUsd) return;
  const error = new Error('NEEDS HUMAN APPROVAL: development model cost exceeded its controller budget');
  error.code = 'NEEDS_HUMAN_APPROVAL';
  throw error;
}

async function runValidation(run, worktree, env) {
  const secrets = providerSecrets(env);
  const commands = [
    ['node', ['--test']],
    ['git', safeGitArgs(worktree, ['diff', '--check'])],
  ];
  const testEnv = buildTestEnvironment({ hostEnv: env, isolatedHome: env.TMPDIR || env.TEMP || '/tmp' });
  for (const [command, args] of commands) {
    const result = await run(command, args, {
      cwd: worktree, env: testEnv, timeoutMs: 600000, maxOutputBytes: 2_000_000,
      executionIdentity: command === 'node' ? 'test' : null,
    });
    if (result.code !== 0) return { ok: false, error: redact(result.stderr || result.stdout, secrets) };
  }
  return { ok: true, summary: ['node --test', 'git diff --check'] };
}

function providerSecrets(env) {
  return [env.DEEPSEEK_API_KEY, env.QWEN_API_KEY, env.KIMI_API_KEY, env.ZHIPU_API_KEY,
    env.MINIMAX_API_KEY, env.CONTINUITY_GITHUB_TOKEN, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY];
}

async function changedPaths(run, worktree) {
  const tracked = await checked(run, 'git', safeGitArgs(worktree, ['diff', '--name-only', '-z', '--']), { cwd: worktree, timeoutMs: 120000 });
  const untracked = await checked(run, 'git', safeGitArgs(worktree, ['ls-files', '--others', '--exclude-standard', '-z']), { cwd: worktree, timeoutMs: 120000 });
  return [...new Set((tracked.stdout + untracked.stdout).split('\0').filter(Boolean))];
}

async function assertNoTrackedOpenCodeOverrides(run, worktree) {
  const result = await checked(run, 'git', safeGitArgs(worktree, ['ls-files', '-z', '--', 'opencode.json', 'opencode.jsonc', '.opencode']), { cwd: worktree, timeoutMs: 120000 });
  if (result.stdout) throw new Error('Repository-local OpenCode configuration cannot override the managed controller policy');
}

function assertNoOpenCodeOverrides(paths) {
  const blocked = paths.filter((path) => /(^|[\\/])(?:opencode\.jsonc?|\.opencode(?:[\\/]|$))/i.test(path));
  if (blocked.length) throw new Error('Repository-local OpenCode overrides are prohibited by the development controller');
}

async function pushWithAskPass({ run, worktree, branch, token, controlDirectory }) {
  const askPass = join(controlDirectory, 'git-askpass.sh');
  await writeFile(askPass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$CONTINUITY_GITHUB_TOKEN" ;; esac\n', { encoding: 'utf8', mode: 0o700, flag: 'wx' });
  const pushEnv = {
    PATH: process.env.PATH,
    GIT_ASKPASS: askPass,
    GIT_ASKPASS_REQUIRE: 'force',
    GIT_TERMINAL_PROMPT: '0',
    CONTINUITY_GITHUB_TOKEN: token,
  };
  const result = await run('git', safeGitArgs(worktree, ['-c', 'core.hooksPath=/dev/null', 'push', '--set-upstream', 'origin', branch]), { cwd: worktree, env: pushEnv, timeoutMs: 300000 });
  if (result.code !== 0) throw new Error('GitHub branch publication failed');
}

async function checked(run, command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const operation = command === 'git'
      ? `git ${args.find((arg) => ['status', 'remote', 'fetch', 'worktree', 'diff', 'ls-files', 'add', 'commit', 'rev-parse', 'push'].includes(arg)) || 'operation'}`
      : command;
    const detail = redact(result.stderr || result.stdout).split(/\r?\n/).find(Boolean);
    throw new Error(`${operation} failed safely (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function safeGitArgs(worktree, args) {
  return ['-c', `safe.directory=${resolve(worktree)}`, ...args];
}

async function createPullRequest({ fetchFn, token, branch, objective, commitSha, provider, model }) {
  const response = await fetchFn(`https://api.github.com/repos/${REPOSITORY}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({
      title: `Development: ${safeTaskSlug(objective).replaceAll('-', ' ')}`,
      head: branch,
      base: 'main',
      body: `Automated isolated development result.\n\n- External coding provider: ${provider} via OpenCode\n- Model: ${model}\n- Controller-side tests: passed\n- Commit: \`${commitSha}\`\n- Merge and deployment remain approval-gated.`,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub pull request creation failed (HTTP ${response.status})`);
  const body = await response.json();
  if (typeof body.html_url !== 'string' || !body.html_url.startsWith(`https://github.com/${REPOSITORY}/pull/`)) throw new Error('GitHub returned an invalid pull request URL');
  return body.html_url;
}

export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 120000, maxOutputBytes = 2_000_000, executionIdentity = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const identity = resolveExecutionIdentity(executionIdentity);
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...identity });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const append = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) > maxOutputBytes) overflow = true;
      return next.slice(-maxOutputBytes);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, String(chunk)); });
    let hardKill;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(hardKill); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      if (overflow) return reject(new Error('Child process output exceeded the safety limit'));
      resolvePromise({ code: Number(code ?? 1), signal, stdout, stderr });
    });
  });
}

function resolveExecutionIdentity(executionIdentity) {
  if (!executionIdentity || process.platform === 'win32') return {};
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('The isolated development controller must run as container root so child processes can drop privileges');
  }
  if (executionIdentity === 'model') return MODEL_IDENTITY;
  if (executionIdentity === 'test') return TEST_IDENTITY;
  throw new Error('Unknown isolated execution identity');
}

async function prepareModelOwnedPath(path, { recursive = false } = {}) {
  if (process.platform === 'win32') return;
  if (recursive) await chownTree(path, MODEL_IDENTITY.uid, MODEL_IDENTITY.gid);
  else await lchown(path, MODEL_IDENTITY.uid, MODEL_IDENTITY.gid);
}

async function chownTree(path, uid, gid) {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    for (const entry of await readdir(path)) await chownTree(join(path, entry), uid, gid);
  }
  await lchown(path, uid, gid);
}

async function makeTreeReadableForTests(path) {
  if (process.platform === 'win32') return;
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, metadata.mode | 0o005);
    for (const entry of await readdir(path)) await makeTreeReadableForTests(join(path, entry));
  } else if (!metadata.isSymbolicLink()) {
    await chmod(path, metadata.mode | 0o004);
  }
}

function assertSecret(value, name) {
  if (typeof value !== 'string' || value.trim().length < 12 || /PASTE_HERE|YOUR_.*KEY/i.test(value)) throw new Error(`Missing or placeholder setting: ${name}`);
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('A controller-owned objective JSON path is required');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const result = await runDevelopmentObjective({
    objective: input.objective,
    sourceRepository: process.env.DEVELOPMENT_SOURCE_REPOSITORY,
    isolatedRoot: process.env.DEVELOPMENT_ISOLATION_ROOT,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'DEVELOPMENT_FAILED', message: redact(error.message) }));
    process.exitCode = 1;
  });
}
