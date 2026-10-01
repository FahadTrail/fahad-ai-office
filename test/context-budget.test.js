import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ReadTracker, compactTestOutput, elideOldToolResults, isElided, simulateInputChars } from '../src/coding-agent/context-budget.js';

const result = (id, size, name = 'read_file') => ({ type: 'tool_result', callId: id, name, content: `HEAD-${id}-`.padEnd(size, 'x'), isError: false });
const call = (id) => ({ role: 'assistant', content: [{ type: 'tool_call', id, name: 'read_file', arguments: { path: 'a.js' } }] });

function transcript(turns, size) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'objective' }] }];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(call(`c${turn}`));
    messages.push({ role: 'user', content: [result(`c${turn}`, size)] });
  }
  return messages;
}

test('old large tool results are elided in one batch; recent turns and the objective stay intact', () => {
  const messages = transcript(12, 8_000);
  const { results, savedChars } = elideOldToolResults(messages);
  assert.equal(results, 8, 'everything before the last 4 tool turns');
  assert.ok(savedChars > 50_000);
  const blocks = messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_result');
  assert.ok(blocks.slice(0, 8).every((block) => isElided(block.content) && block.content.startsWith('HEAD-')), 'a head is kept');
  assert.ok(blocks.slice(8).every((block) => !isElided(block.content) && block.content.length === 8_000));
  assert.equal(messages[0].content[0].text, 'objective');
});

test('elision is batched so the cached prompt prefix does not change every turn', () => {
  const messages = transcript(6, 3_000);
  assert.equal(elideOldToolResults(messages).results, 0, 'too little old output: nothing changes');
  const snapshot = JSON.stringify(messages);
  messages.push(call('c6'), { role: 'user', content: [result('c6', 3_000)] });
  elideOldToolResults(messages);
  assert.ok(JSON.stringify(messages).startsWith(snapshot.slice(0, -1)), 'prefix unchanged below the batch threshold');
  // Already-elided results are never touched again.
  const big = transcript(12, 8_000);
  elideOldToolResults(big);
  const again = elideOldToolResults(big);
  assert.equal(again.results, 0);
});

test('an unchanged re-read points back to the earlier result; a changed or elided one is returned in full', () => {
  const tracker = new ReadTracker();
  const messages = [{ role: 'user', content: [{ type: 'tool_result', callId: 'r1', name: 'read_file', content: 'file v1', isError: false }] }];
  assert.equal(tracker.check({ path: 'a.js' }, 'file v1', 'r1', messages), null);
  assert.equal(tracker.check({ path: './a.js' }, 'file v1', 'r2', messages), 'r1');
  assert.equal(tracker.check({ path: 'a.js', start_line: 1, end_line: 5 }, 'file v1', 'r3', messages), null, 'a different range is a different read');
  assert.equal(tracker.check({ path: 'a.js' }, 'file v2', 'r4', messages), null, 'changed content is returned');
  messages.push({ role: 'user', content: [{ type: 'tool_result', callId: 'r4', name: 'read_file', content: 'x …[controller: older output removed to save context (9 characters). Call the tool again if you need it.]', isError: false }] });
  assert.equal(tracker.check({ path: 'a.js' }, 'file v2', 'r5', messages), null, 'the earlier result was elided, so the content is sent again');
});

test('efficiency evidence: the real Qwen-repair transcript profile needs about half the input', () => {
  const profile = JSON.parse(readFileSync(new URL('../testing/fixtures/transcript-profile-bff739a0.json', import.meta.url), 'utf8')).messages;
  const before = simulateInputChars(profile, { budget: false });
  const after = simulateInputChars(profile, { budget: true });
  const reduction = 1 - after.total / before.total;
  assert.ok(reduction > 0.45, `input reduced by ${(reduction * 100).toFixed(1)}%`);
  assert.ok(Math.max(...after.perTurn) < Math.max(...before.perTurn) * 0.55, 'peak context roughly halved');
});

// node --test TAP (format captured from Node 22): passing blocks collapse,
// failure details and totals stay, Node-internal stack frames go.
const TAP_SAMPLE = [
  'TAP version 13',
  '# Subtest: adds numbers',
  'ok 1 - adds numbers',
  '  ---',
  '  duration_ms: 1.2',
  "  type: 'test'",
  '  ...',
  '# Subtest: sumEven',
  '    # Subtest: skips odd values',
  '    not ok 1 - skips odd values',
  '      ---',
  '      duration_ms: 1.22',
  "      type: 'test'",
  "      location: '/repo/test/sum.test.js:6:3'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        Expected values to be strictly equal:',
  '',
  '        4 !== 6',
  "      code: 'ERR_ASSERTION'",
  '      expected: 6',
  '      actual: 4',
  '      stack: |-',
  '        TestContext.<anonymous> (file:///repo/test/sum.test.js:6:40)',
  '        Test.runInAsyncScope (node:async_hooks:214:14)',
  '        node:internal/test_runner/test:1440:71',
  '      ...',
  '    # Subtest: handles empty',
  '    ok 2 - handles empty',
  '      ---',
  '      duration_ms: 0.1',
  '      ...',
  '    1..2',
  'not ok 2 - sumEven',
  '  ---',
  "  type: 'suite'",
  "  error: '1 subtest failed'",
  '  ...',
  'console output from a test',
  'ok 3 - pending thing # SKIP not ready',
  '1..3',
  '# tests 4',
  '# pass 2',
  '# fail 1',
  '# skipped 1',
].join('\n');

test('test output compaction keeps failures, totals and console lines, drops passing diagnostics', () => {
  const { text, omittedPassing } = compactTestOutput(TAP_SAMPLE);
  assert.equal(omittedPassing, 2);
  assert.match(text, /^\[controller: 2 passing result\(s\) omitted/);
  for (const kept of ['not ok 1 - skips odd values', '4 !== 6', 'expected: 6', 'actual: 4', "location: '/repo/test/sum.test.js:6:3'",
    'file:///repo/test/sum.test.js:6:40', 'not ok 2 - sumEven', 'console output from a test', 'ok 3 - pending thing # SKIP', '# tests 4', '# fail 1']) {
    assert.ok(text.includes(kept), `kept: ${kept}`);
  }
  for (const dropped of ['ok 1 - adds numbers', 'handles empty', 'duration_ms', 'node:async_hooks', 'node:internal', '# Subtest', 'TAP version', 'failureType']) {
    assert.ok(!text.includes(dropped), `dropped: ${dropped}`);
  }
  assert.ok(text.length < TAP_SAMPLE.length / 1.5);
});

test('test output compaction: a shown diff replaces expected/actual trees; non-TAP output is unchanged', () => {
  const diff = ['TAP version 13', 'not ok 1 - deep', '  ---', '  error: |-', '    + actual - expected', '    -     4', '    +     3', '  expected:', '    a:', '      0: 4', '  actual:', '    a:', '      0: 3', "  operator: 'deepStrictEqual'", '  ...', '# fail 1'].join('\n');
  const { text } = compactTestOutput(diff);
  assert.ok(text.includes('+ actual - expected') && text.includes("operator: 'deepStrictEqual'"));
  assert.ok(!/^\s*(expected|actual):/m.test(text) && !text.includes('0: 4'));
  const jest = 'PASS src/a.test.js\nFAIL src/b.test.js\n  ● adds\nTests: 1 failed, 1 passed';
  assert.deepEqual(compactTestOutput(jest), { text: jest, omittedPassing: 0 });
});
