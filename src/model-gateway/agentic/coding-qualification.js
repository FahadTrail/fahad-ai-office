// Coding qualification suite (Capacity V2, Part 9).
//
// The general qualification (qualification.js) proves a free model can follow
// instructions, call a tool and read a snippet. Autonomous coding needs more,
// so a model that passed it runs this suite before it may take coding work.
// Twelve checks, all on small synthetic PUBLIC code (never a real repository),
// graded deterministically — no model grades another model:
//
//   A read      predict the output of a snippet
//   B fix       repair a buggy function (executed against tests)
//   C implement write a function from a spec (executed against tests)
//   D edge      handle edge cases and invalid input (executed)
//   E tests     write correct test cases that cover the boundaries
//   F diff      produce a minimal unified diff
//   G security  name the vulnerability and write the safe line
//   H async     event-loop ordering
//   I plan      a structured file plan (create / modify / delete)
//   J scope     edit the source, not the correct test
//   K tools     read_file → write_file loop that fixes a file (executed)
//   L context   find one fact in a long file (only where the route's
//               context and rate limits allow; otherwise not tested)
//
// Grades: CODING_PRIMARY (large and critical jobs), CODING_SECONDARY (medium),
// CODING_SMALL_TASKS (small jobs), NOT_CODING_APPROVED.
//
// Model-written code is executed only in a child Node process under the
// permission model (no file system, no child processes, no workers), with an
// empty environment (no credentials) and a hard timeout, inside a vm context.

import { spawnSync } from 'node:child_process';
import { assertFreeRouteHonest, FREE_ROUTE_INCIDENTS } from './free-guard.js';

export const CODING_SUITE_VERSION = 'c2-2026-09';
export const CODING_QUALIFICATION_MAX_AGE_MS = 30 * 24 * 3600_000;
export const CODING_CHECKS = Object.freeze(['read', 'fix', 'implement', 'edge', 'tests', 'diff', 'security', 'async', 'plan', 'scope', 'tools', 'context']);
export const CODING_GRADES = Object.freeze(['NOT_CODING_APPROVED', 'CODING_SMALL_TASKS', 'CODING_SECONDARY', 'CODING_PRIMARY']);

// Minimum grade a free route needs per coding job size (Part 12). Critical
// work additionally needs a route approved for private data.
export const CODING_SUITE_MAIN_TIMEOUT_MS = 300_000;

export const CODING_TIERS = Object.freeze({
  small: 'CODING_SMALL_TASKS',
  medium: 'CODING_SECONDARY',
  large: 'CODING_PRIMARY',
  critical: 'CODING_PRIMARY',
});

const SYSTEM = 'You are a senior software engineer being evaluated. Answer exactly in the requested format.';

const MAIN_PROMPT = String.raw`Reply with ONE JSON object and nothing else (no markdown fences, no prose). Keys exactly: read, fix, implement, edge, tests, diff, security, async, plan, scope.

read: what does this JavaScript print? Give the exact printed string.
  const m = new Map([['a', 1], ['b', 2]]); let s = ''; for (const [k, v] of m) s += k.repeat(v); console.log(s.length + s);

fix: this function has bugs. Return the complete corrected function source as a string. It must not modify its input and must work for numbers.
  function median(values) {
    const sorted = values.sort();
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid] + sorted[mid + 1]) / 2;
  }

implement: return the source of a JavaScript function slugify(text): lowercase; every run of characters other than a-z and 0-9 becomes ONE "-"; no leading or trailing "-". Example: slugify("Hello, World!") === "hello-world".

edge: return the source of a JavaScript function chunk(array, size) that splits array into consecutive arrays of length size (the last may be shorter). chunk([], 2) returns []. It throws a RangeError when size is not a positive integer.

tests: clamp(value, min, max) returns value limited to [min, max]. Return an array of at least 4 test cases, each [value, min, max, expected], covering a value below min, above max, inside, and exactly equal to a bound.

diff: the file src/config.js contains exactly these 3 lines:
  export const HOST = 'localhost';
  const TIMEOUT_MS = 5000;
  export default { HOST, TIMEOUT_MS };
Return a unified diff (as a string with \n line breaks) that changes the timeout to 10000 and nothing else, with ---/+++ headers for a/src/config.js and b/src/config.js.

security: const rows = await db.query("SELECT * FROM users WHERE email = '" + email + "'");
Return an object {"vuln": the vulnerability name, "fixed": the single safe replacement line using a parameterized query with $1}.

async: in what order are the digits printed? Give them as one string.
  console.log('1'); setTimeout(() => console.log('2'), 0); Promise.resolve().then(() => console.log('3')); queueMicrotask(() => console.log('4')); console.log('5');

plan: task: "add a --verbose flag to the CLI in src/cli.js, cover it in the existing test/cli.test.js, and delete the unused src/legacy.js". Return {"files": [{"path", "action"}]} with action one of create, modify, delete, listing only the files to touch.

scope: CI fails with "test/price.test.js: expected 10.5, got 10". The test is correct; the rounding bug is in src/price.js. Which ONE file should be edited? Give the path.`;

const TOOLS = [
  { name: 'read_file', description: 'Read a file of the repository.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Replace the complete contents of a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
];
const TOOL_PROMPT = 'Fix the bug in src/sum.js so that sumEven([1, 2, 3, 4]) returns 6 (the sum of the even numbers). First call read_file, then call write_file with the COMPLETE corrected file. Do not edit any other file.';
const SUM_FILE = [
  'export function sumEven(values) {',
  '  let total = 0;',
  '  for (let i = 0; i <= values.length; i++) if (values[i] % 2 === 1) total += values[i];',
  '  return total;',
  '}',
  '',
].join('\n');

const text = (value) => ({ role: 'user', content: [{ type: 'text', text: value }] });
const replyText = (result) => (result?.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('').trim();

function parseObject(raw) {
  const output = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const value = JSON.parse(output); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch {}
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { const value = JSON.parse(match[0]); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}

// ------------------------------------------------------------ execution
// Runs `source` (which must define `fn`) against cases in an isolated child.
// Each case: { args, expect } | { args, throws: 'RangeError' } | { args, expect, unchanged: true }.
const CHILD = String.raw`
const vm = require('node:vm');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const { source, fn, cases } = JSON.parse(input);
  const out = [];
  try {
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(source.replace(/^\s*export\s+(default\s+)?/gm, '') + '\n;globalThis.__fn = ' + fn + ';', context, { timeout: 1000 });
    for (const test of cases) {
      const args = vm.runInContext('(' + JSON.stringify(test.args) + ')', context);
      const before = JSON.stringify(args);
      try {
        const value = vm.runInContext('__fn', context)(...args);
        if (test.throws) out.push(false);
        else out.push(JSON.stringify(value) === JSON.stringify(test.expect) && (!test.unchanged || JSON.stringify(args) === before));
      } catch (error) {
        out.push(Boolean(test.throws) && error && error.name === test.throws);
      }
    }
  } catch { out.length = 0; }
  process.stdout.write(JSON.stringify(out));
});`;

export function runCodeCases(source, fn, cases, { timeoutMs = 5_000 } = {}) {
  if (typeof source !== 'string' || !source.trim() || source.length > 20_000) return false;
  const child = spawnSync(process.execPath, ['--permission', '-e', CHILD], {
    input: JSON.stringify({ source, fn, cases }), env: {}, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  if (child.status !== 0) return false;
  try {
    const results = JSON.parse(child.stdout || '[]');
    return results.length === cases.length && results.every(Boolean);
  } catch { return false; }
}

// ------------------------------------------------------------ graders
const MEDIAN_CASES = [
  { args: [[10, 2, 3]], expect: 3 },
  { args: [[1, 2, 3, 4]], expect: 2.5 },
  { args: [[10, 9, 1, 100]], expect: 9.5, unchanged: true },
  { args: [[7]], expect: 7 },
];
const SLUG_CASES = [
  { args: ['Hello, World!'], expect: 'hello-world' },
  { args: ['  Fahad  AI--Office '], expect: 'fahad-ai-office' },
  { args: ['***'], expect: '' },
  { args: ['Q3 Report (final).pdf'], expect: 'q3-report-final-pdf' },
];
const CHUNK_CASES = [
  { args: [[1, 2, 3, 4, 5], 2], expect: [[1, 2], [3, 4], [5]] },
  { args: [[], 2], expect: [] },
  { args: [[1, 2, 3], 3], expect: [[1, 2, 3]] },
  { args: [[1, 2, 3], 0], throws: 'RangeError' },
  { args: [[1, 2, 3], 1.5], throws: 'RangeError' },
  { args: [[1, 2, 3], -1], throws: 'RangeError' },
];
const SUM_CASES = [
  { args: [[1, 2, 3, 4]], expect: 6 },
  { args: [[]], expect: 0 },
  { args: [[2, -4, 5]], expect: -2 },
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
function gradeTests(cases) {
  if (!Array.isArray(cases) || cases.length < 4) return false;
  const valid = cases.every((test) => Array.isArray(test) && test.length === 4 && test.every((item) => typeof item === 'number' && Number.isFinite(item)) && test[1] <= test[2]);
  if (!valid || !cases.every(([value, min, max, expected]) => clamp(value, min, max) === expected)) return false;
  const covers = (predicate) => cases.some(predicate);
  return covers(([value, min]) => value < min) && covers(([value, , max]) => value > max)
    && covers(([value, min, max]) => value > min && value < max) && covers(([value, min, max]) => value === min || value === max);
}

function gradeDiff(diff) {
  const lines = String(diff || '').split('\n').map((line) => line.replace(/\r$/, ''));
  const has = (pattern) => lines.some((line) => pattern.test(line));
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---'));
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  return has(/^--- (a\/)?src\/config\.js/) && has(/^\+\+\+ (b\/)?src\/config\.js/) && has(/^@@ /)
    && removed.length === 1 && added.length === 1
    && /^-\s*const TIMEOUT_MS = 5000;\s*$/.test(removed[0]) && /^\+\s*const TIMEOUT_MS = 10_?000;\s*$/.test(added[0]);
}

function gradeSecurity(answer) {
  const vuln = String(answer?.vuln || '');
  const fixed = String(answer?.fixed || '');
  return /sql\s*injection/i.test(vuln) && /\$1/.test(fixed) && /\[\s*email\s*\]/.test(fixed) && !/\+\s*email|email\s*\+|\$\{\s*email/.test(fixed);
}

function gradePlan(plan) {
  const files = Array.isArray(plan?.files) ? plan.files : null;
  if (!files || files.length !== 3) return false;
  const actions = Object.fromEntries(files.map((file) => [String(file?.path || '').replace(/^\.\//, ''), String(file?.action || '').toLowerCase()]));
  return actions['src/cli.js'] === 'modify' && actions['test/cli.test.js'] === 'modify' && actions['src/legacy.js'] === 'delete';
}

// Grades the one-call answer (A–J). Exported for tests.
export function gradeCodingAnswer(raw) {
  const answer = parseObject(raw);
  if (!answer) return Object.fromEntries(CODING_CHECKS.slice(0, 10).map((check) => [check, false]));
  const source = (value) => (typeof value === 'string' ? value : '');
  return {
    read: String(answer.read ?? '').trim() === '3abb',
    fix: runCodeCases(source(answer.fix), 'median', MEDIAN_CASES),
    implement: runCodeCases(source(answer.implement), 'slugify', SLUG_CASES),
    edge: runCodeCases(source(answer.edge), 'chunk', CHUNK_CASES),
    tests: gradeTests(answer.tests),
    diff: gradeDiff(answer.diff),
    security: gradeSecurity(answer.security),
    async: String(answer.async ?? '').replace(/[\s,]/g, '') === '15342',
    plan: gradePlan(answer.plan),
    scope: String(answer.scope ?? '').trim().replace(/^\.\//, '') === 'src/price.js',
  };
}

export function gradeToolFix(writes) {
  const others = writes.filter((write) => String(write?.path || '').replace(/^\.\//, '') !== 'src/sum.js');
  const target = writes.findLast((write) => String(write?.path || '').replace(/^\.\//, '') === 'src/sum.js');
  return !others.length && Boolean(target) && runCodeCases(String(target.content || ''), 'sumEven', SUM_CASES);
}

// A long synthetic module with one fact in the middle and decoys around it.
export function longContextFixture(targetChars = 60_000) {
  const block = (index) => [
    `// src/net/module-${index}.js`,
    `export const RETRY_LIMIT_${index} = ${(index % 9) + 1}; // not the policy value`,
    `export function handler${index}(request) {`,
    `  const attempts = Math.min(request.attempts ?? 0, ${index + 3});`,
    `  return { id: ${index}, attempts, ok: attempts < ${index + 5} };`,
    '}',
    '',
  ].join('\n');
  const parts = [];
  let length = 0;
  for (let index = 0; length < targetChars; index += 1) { const part = block(index); parts.push(part); length += part.length; }
  const middle = Math.floor(parts.length / 2);
  parts.splice(middle, 0, "// src/net/policy.js\n// Old value was 3; changed after the incident review.\nexport const RETRY_LIMIT = 7;\n");
  return parts.join('\n');
}
const CONTEXT_QUESTION = 'Above is a repository dump. What is the value of RETRY_LIMIT exported from src/net/policy.js? Reply with the number only.';

export function contextTestable(route) {
  return Number(route?.contextWindow || 0) >= 64_000 && !route?.requestTokenLimit;
}

// A grade from the check results (context: true / false / null = not tested).
export function codingGrade(checks) {
  const core = CODING_CHECKS.filter((check) => check !== 'context');
  const passed = core.filter((check) => checks?.[check] === true).length;
  const has = (...names) => names.every((name) => checks?.[name] === true);
  if (has('fix', 'implement', 'edge', 'tools') && passed >= 10 && checks?.context === true) return 'CODING_PRIMARY';
  if (has('fix', 'implement', 'tools') && passed >= 8) return 'CODING_SECONDARY';
  if ((checks?.fix === true || checks?.implement === true) && passed >= 6) return 'CODING_SMALL_TASKS';
  return 'NOT_CODING_APPROVED';
}

function errorCode(error) {
  const code = String(error?.code || '').replace(/[^A-Z0-9_]/gi, '').slice(0, 60);
  return code || (error?.status ? `HTTP_${error.status}` : 'CODING_QUALIFICATION_CALL_FAILED');
}

// Runs the suite against one route (3–6 short calls; the long-context check
// adds one call of about 15K input tokens where the route allows it).
export async function qualifyCodingRoute(route, { now = () => Date.now(), maxOutputTokens = 3_000 } = {}) {
  const startedAt = now();
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const call = async (input) => {
    const result = await route.protocolClient.turn({ provider: route.provider, model: route.model, maxOutputTokens, ...input });
    assertFreeRouteHonest(route, result);
    usage.inputTokens += result?.usage?.inputTokens || 0;
    usage.outputTokens += result?.usage?.outputTokens || 0;
    usage.costUsd += result?.usage?.costUsd || 0;
    return result;
  };
  const base = { routeId: route.id, provider: route.provider, model: route.model, suiteVersion: CODING_SUITE_VERSION, kind: 'coding', testedAt: new Date(startedAt).toISOString() };
  let checks;
  let diagnostics = null;
  try {
    // The one-call answer holds several functions and a diff: reasoning-by-
    // default models (e.g. GLM Flash) need room to finish the JSON, within
    // the route's per-request token limit (Groq free: 8K tokens/minute).
    const mainBudget = Math.max(2_000, Math.min(8_000, route.requestTokenLimit ? route.requestTokenLimit - 2_000 : 8_000));
    // The ten answers arrive in ONE call (≈ ten agent turns of output), so it
    // gets twice a free route's per-turn timeout: a slow reasoning model is
    // graded on its answers, not on a timeout no real turn would hit.
    const main = await call({ system: SYSTEM, messages: [text(MAIN_PROMPT)], tools: [], maxOutputTokens: mainBudget, timeoutMs: CODING_SUITE_MAIN_TIMEOUT_MS });
    const answer = replyText(main);
    checks = { ...gradeCodingAnswer(answer), tools: false, context: null };
    // Metadata only (never the model output): tells a parse failure apart
    // from ten wrong answers.
    diagnostics = { answerParsed: parseObject(answer) !== null, mainOutputTokens: main?.usage?.outputTokens ?? null, mainBudget };
    // K: a bounded read → write loop.
    const messages = [text(TOOL_PROMPT)];
    const writes = [];
    for (let step = 0; step < 4 && !writes.length; step += 1) {
      const result = await call({ system: SYSTEM, messages, tools: TOOLS });
      const toolCalls = (result.message?.content || []).filter((block) => block.type === 'tool_call');
      if (!toolCalls.length) break;
      messages.push(result.message);
      const results = toolCalls.map((toolCall) => {
        const args = toolCall.arguments || {};
        if (toolCall.name === 'write_file') writes.push({ path: args.path, content: args.content });
        const content = toolCall.name === 'read_file'
          ? (String(args.path || '').replace(/^\.\//, '') === 'src/sum.js' ? SUM_FILE : 'ERROR: file not found')
          : JSON.stringify({ ok: true });
        return { type: 'tool_result', callId: toolCall.id, name: toolCall.name, content };
      });
      messages.push({ role: 'user', content: results });
    }
    checks.tools = gradeToolFix(writes);
    // L: long context, only where the route's window and rate limits allow.
    if (contextTestable(route)) {
      const long = await call({ system: SYSTEM, messages: [text(`${longContextFixture()}\n\n${CONTEXT_QUESTION}`)], tools: [], maxOutputTokens: 1_000 });
      checks.context = /^\D*7\D*$/.test(replyText(long));
    }
  } catch (error) {
    return { ...base, status: 'error', errorCode: errorCode(error), durationMs: now() - startedAt, usage, incident: FREE_ROUTE_INCIDENTS.has(error?.type) ? error.type : null, error };
  }
  const grade = codingGrade(checks);
  const passed = CODING_CHECKS.filter((check) => checks[check] === true).length;
  const tested = CODING_CHECKS.filter((check) => checks[check] !== null).length;
  return { ...base, status: grade === 'NOT_CODING_APPROVED' ? 'failed' : 'qualified', grade, checks, passed, tested, diagnostics, durationMs: now() - startedAt, usage };
}

export function codingQualificationValid(record, now = Date.now()) {
  return Boolean(record) && record.suiteVersion === CODING_SUITE_VERSION && record.status !== 'error'
    && now - Date.parse(record.testedAt) < CODING_QUALIFICATION_MAX_AGE_MS;
}

// Why a free route may not take a coding job of this tier (Part 12). Paid
// routes are governed by their own quality floor and budget, not this suite.
export function codingTierGaps(route, tier, codingQualifications, now = Date.now()) {
  if (route.billingClass === 'paid') return [];
  const needed = CODING_TIERS[tier] || CODING_TIERS.medium;
  const record = codingQualifications?.get?.(route.id);
  if (!codingQualificationValid(record, now)) return ['CODING_NOT_QUALIFIED'];
  if (CODING_GRADES.indexOf(record.grade) < CODING_GRADES.indexOf(needed)) return ['CODING_GRADE_TOO_LOW'];
  if (tier === 'critical' && !route.privacyApproved) return ['CRITICAL_NEEDS_PRIVATE_ROUTE'];
  return [];
}

// Which routes run the coding suite next: non-paid routes that passed the
// general qualification with the coding and tools skills, have no valid
// coding result and are not backing off from a recent failure.
export function codingCandidates(pool, { qualifications, now = Date.now(), backoffUntil = () => null, maxRoutes = 1 } = {}) {
  const coding = qualifications?.coding;
  return pool
    .filter((route) => route.billingClass !== 'paid' && route.protocolClient && !route.unavailableReasons?.length && route.toolCalling !== false)
    .filter((route) => {
      const general = qualifications?.get?.(route.id);
      return general?.status === 'qualified' && general.skills?.coding && general.skills?.tools;
    })
    .filter((route) => !codingQualificationValid(coding?.get?.(route.id), now))
    .filter((route) => !backoffUntil(coding?.errors?.get?.(route.id), now))
    .toSorted((left, right) => (right.capabilities?.coding || 0) - (left.capabilities?.coding || 0) || left.id.localeCompare(right.id))
    .slice(0, maxRoutes);
}
