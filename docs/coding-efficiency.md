# Coding efficiency: test-output compaction (prepared during the burn-in)

## Problem

The Coding Agent's test runs (`node --test`, TAP) were sent to the model in full, capped at 20,000 characters (head 60 % + tail 40 %).

In TAP, every passing test carries a YAML block (`duration_ms`, `type`). A test result stays in the transcript for about 4 turns before elision (`context-budget.js`), and the whole transcript is re-sent every turn.

Gemma 26B, the main free coding route, allows 16,000 input tokens per minute (provider-reported). The test output alone could take a third of that.

## Change

`compactTestOutput()` in `src/coding-agent/context-budget.js` runs on test commands (`looksLikeTest`) and on the finish-gate failure text:

* Passing results collapse into one line: `[controller: N passing result(s) omitted; failures and totals kept]`.
* Every `not ok` block keeps:
  * location, error, code and operator;
  * `expected`/`actual`, unless the error already shows the `+ actual - expected` diff;
  * at most 4 stack frames outside Node internals.
* Console output, stderr, `# SKIP`/`# TODO` lines and the totals (`# tests/pass/fail …`) stay.
* Output that is not TAP (jest, pytest, …) is left unchanged.
* The failure count used by the controller (`reportedTestFailures`) still reads the raw output.

## BEFORE / AFTER

Characters are MEASURED on real `node --test` runs in this repository (Node 22).

| Output | Before (chars sent) | After | Reduction |
|---|---|---|---|
| One passing file (`test/capacity-model.test.js`, 12 tests) | 3,474 | 169 | −95 % |
| A failing file (14 passing, 2 failing, incl. a deep-equal diff) | 4,033 | 1,471 | −64 % |
| Full suite (`node --test`, 469 tests) | 106,448 → 20,000 after the cap (middle lost) | 174 | −99 % of what was sent; no failure can fall into the cut middle any more |

ESTIMATED effect per job:
* Assumptions: ≈ 4 chars/token; a test result resident for ≈ 4–5 turns; 3–6 test runs per small or medium job.
* Small benchmark job (a new 5–10 test file, ≈ 1.5–3.5K chars per run): about 4–10K fewer input tokens, i.e. 5–10 % of the measured 87–98K.
* Medium job (two files, ≈ 5K chars per run, plus a full-suite run): about 20–40K fewer input tokens, i.e. 10–20 % of the measured 210K.
* Any job whose agent runs the full suite: about 5K tokens fewer per resident turn for each full run.

MEASURED after deploy: `session.state.efficiency.testCompactedChars`, exposed as `testOutputSavedChars` in the Hub workspace session API.

## Not changed

Routing, provider selection, qualification, capacity math and the test gate are unchanged. The finish gate still runs the full test command and decides on its exit code.
