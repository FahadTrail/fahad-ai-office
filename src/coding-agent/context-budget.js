// Context budget for the Coding Agent transcript.
//
// Measured on real sessions (e.g. the Qwen key repair, 2.6M input tokens over
// 46 turns): the transcript was re-sent in full on every turn, and most of it
// was old exploration output (file reads, searches, test logs) that the agent
// had already acted on. Two controls keep the context small without losing
// the task:
//
//   * Batched elision: large tool results older than the most recent turns are
//     cut to a short head plus a note. It runs only when enough old output has
//     accumulated, so the prompt prefix stays byte-identical (and cacheable)
//     between batches instead of changing every turn.
//   * Unchanged re-reads: reading the same file range again while its earlier
//     result is still in context returns a short "unchanged" note. The file is
//     still read and hashed, so any change (edits, shell commands) is seen.
//
// Durable task state (plan, notes, files changed, last test, gate failures)
// is never elided; it lives in session state and continuation messages.

import { createHash } from 'node:crypto';

export const ELISION_MARKER = '[controller: ';

export const CONTEXT_DEFAULTS = Object.freeze({
  keepRecentTurns: 4,
  minResultChars: 1_200,
  batchChars: 30_000,
  headChars: 500,
});

export function isElided(content) {
  return String(content || '').includes(`${ELISION_MARKER}older output removed`);
}

// Elides old, large tool results in place. Returns { results, savedChars }.
export function elideOldToolResults(messages, options = {}) {
  const { keepRecentTurns, minResultChars, batchChars, headChars } = { ...CONTEXT_DEFAULTS, ...options };
  const userIndexes = [];
  messages.forEach((message, index) => {
    if (message.role === 'user' && message.content.some((block) => block.type === 'tool_result')) userIndexes.push(index);
  });
  const cutoff = userIndexes.length > keepRecentTurns ? userIndexes[userIndexes.length - keepRecentTurns] : -1;
  if (cutoff < 0) return { results: 0, savedChars: 0 };
  const candidates = [];
  for (let index = 0; index < cutoff; index += 1) {
    for (const block of messages[index].content) {
      if (block.type === 'tool_result' && block.content.length > minResultChars && !isElided(block.content)) candidates.push(block);
    }
  }
  const eligible = candidates.reduce((sum, block) => sum + block.content.length - headChars, 0);
  if (eligible < batchChars) return { results: 0, savedChars: 0 };
  let savedChars = 0;
  for (const block of candidates) {
    const before = block.content.length;
    block.content = `${block.content.slice(0, headChars)}\n…${ELISION_MARKER}older output removed to save context (${before - headChars} characters). `
      + 'Call the tool again if you need it.]';
    savedChars += before - block.content.length;
  }
  return { results: candidates.length, savedChars };
}

export function contentHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

// Remembers file reads so an identical re-read can point back to the result
// already in the conversation.
export class ReadTracker {
  constructor() {
    this.reads = new Map();
  }

  static key(args) {
    return `${String(args.path || '').replace(/^\.\//, '')}:${args.start_line || ''}:${args.end_line || ''}`;
  }

  // Returns the call id of an earlier identical read whose full result is
  // still in the transcript, or null. Records this read otherwise.
  check(args, text, callId, messages) {
    const key = ReadTracker.key(args);
    const hash = contentHash(text);
    const previous = this.reads.get(key);
    if (previous && previous.hash === hash && resultStillPresent(messages, previous.callId)) return previous.callId;
    this.reads.set(key, { hash, callId });
    return null;
  }
}

function resultStillPresent(messages, callId) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const block of messages[index].content) {
      if (block.type === 'tool_result' && block.callId === callId) return !isElided(block.content);
    }
  }
  return false;
}

// Input characters each model turn would send for a transcript size profile,
// with and without the budget controls. Used by tests and the efficiency
// report; profile entries are { role, results: [chars...], other: chars }.
export function simulateInputChars(profile, { systemChars = 24_000, budget = true, options = {} } = {}) {
  const messages = [];
  const perTurn = [];
  let id = 0;
  for (const entry of profile) {
    if (entry.role === 'assistant') {
      if (budget) elideOldToolResults(messages, options);
      perTurn.push(systemChars + messages.reduce((sum, message) => sum + message.content.reduce((inner, block) => inner + (block.content?.length ?? block.text?.length ?? 0), 0), 0));
    }
    const content = [];
    if (entry.other) content.push({ type: 'text', text: 'x'.repeat(entry.other) });
    for (const size of entry.results || []) content.push({ type: 'tool_result', callId: `c${id += 1}`, name: 'tool', content: 'x'.repeat(size) });
    if (!content.length) content.push({ type: 'text', text: '' });
    messages.push({ role: entry.role, content });
  }
  return { perTurn, total: perTurn.reduce((sum, value) => sum + value, 0) };
}

// Test-runner output (node --test TAP) is mostly passing-test diagnostics:
// every `ok` line carries a YAML block with its duration. The model needs the
// failures and the totals, so passing tests collapse into one count line,
// failures keep their assertion details and only stack frames outside Node's
// own internals, and every non-TAP line (console output, stderr) stays.
// Output that is not TAP is returned unchanged.
const TAP_RESULT = /^(\s*)(not ok|ok) \d+ - /;
const TAP_SUMMARY = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
const FAILURE_NOISE = /^\s*(duration_ms|type|failureType):/;
const INTERNAL_FRAME = /\(node:|^\s*node:|^\s*(new Promise|new SafePromise|Array\.map|async Promise\.all) /;

export function compactTestOutput(text, { maxStackFrames = 4 } = {}) {
  const source = String(text || '');
  if (!/^TAP version \d+/m.test(source) || !/^\s*(not ok|ok) \d+ - /m.test(source)) return { text: source, omittedPassing: 0 };
  const lines = source.split('\n');
  const out = [];
  let omittedPassing = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*# Subtest: /.test(line) || /^\s*1\.\.\d+\s*$/.test(line) || /^TAP version /.test(line)) continue;
    const result = line.match(TAP_RESULT);
    if (!result) { out.push(line); continue; }
    const indent = result[1].length;
    // The YAML block that follows a result: "---" … "..." one level deeper.
    let end = index;
    const block = [];
    if (lines[index + 1]?.trim() === '---') {
      end = index + 1;
      while (end + 1 < lines.length && !(lines[end + 1].trim() === '...' && lines[end + 1].length - lines[end + 1].trimStart().length === indent + 2)) {
        end += 1;
        block.push(lines[end]);
      }
      end += 1;
    }
    index = end;
    if (result[2] === 'ok') {
      if (!/# SKIP|# TODO/.test(line)) { omittedPassing += 1; continue; }
      out.push(line);
      continue;
    }
    out.push(line);
    // When the error already shows the "+ actual - expected" diff, the
    // expected:/actual: YAML trees repeat it.
    const diffShown = block.some((detail) => detail.includes('+ actual - expected'));
    let frames = 0;
    let inStack = false;
    let skipDeeperThan = -1;
    for (const detail of block) {
      const depth = detail.length - detail.trimStart().length;
      if (skipDeeperThan >= 0) {
        if (depth > skipDeeperThan && detail.trim()) continue;
        skipDeeperThan = -1;
      }
      if (diffShown && /^\s*(expected|actual):\s*$/.test(detail)) { skipDeeperThan = depth; continue; }
      if (FAILURE_NOISE.test(detail)) continue;
      if (/^\s*stack: \|-?\s*$/.test(detail)) { inStack = true; out.push(detail); continue; }
      if (inStack && /^\s+\S/.test(detail) && !/^\s*[a-zA-Z]+:( |$)/.test(detail.trim() + ' ')) {
        if (INTERNAL_FRAME.test(detail) || frames >= maxStackFrames) continue;
        frames += 1;
        out.push(detail);
        continue;
      }
      inStack = false;
      out.push(detail);
    }
  }
  const compacted = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const note = omittedPassing ? `[controller: ${omittedPassing} passing result(s) omitted; failures and totals kept]\n` : '';
  return { text: `${note}${compacted}`, omittedPassing };
}
