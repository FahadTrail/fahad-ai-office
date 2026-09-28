// Turn expectations by task size (Coding Agent). Production (2026-09-25..27):
// small doc/test tasks took 9–15 turns — and one JSDoc-only change took 34
// turns and 621K tokens. Good work is never failed for exceeding a number:
// at the expected count the controller compacts the transcript and asks for a
// re-plan; at twice the count it asks the model to finish or escalate to
// Fahad. The hard iteration limit (DEFAULT_LIMITS.maxIterations) is unchanged.

export const EXPECTED_TURNS = Object.freeze({ small: 18, medium: 40, large: 80 });

const SMALL = /\b(doc(s|umentation|string)?|jsdoc|comment|readme|typo|rename|glossary|changelog|bullet|single test|one test|add (a )?test|small (fix|helper|bug)|lint)\b/i;
const LARGE = /\b(refactor|architecture|migrat(e|ion)|redesign|rewrite|integration|multi-?provider|audit|across the (codebase|repo)|end-to-end)\b/i;

export function taskSize(text) {
  const value = String(text || '');
  if (LARGE.test(value)) return 'large';
  if (SMALL.test(value) && value.length < 600) return 'small';
  return 'medium';
}

// What the controller should do after `iteration` turns ({ action, note }),
// at most once per threshold (`done` records what already fired).
export function turnBudgetAction(iteration, size, done = {}) {
  const expected = EXPECTED_TURNS[size] || EXPECTED_TURNS.medium;
  if (iteration >= expected * 2 && !done.escalate) {
    return { action: 'escalate', expected, note: `Controller note: this ${size.toUpperCase()} task has used ${iteration} model turns (expected about ${expected}). Finish now if the objective is met and verified, or call request_human with the exact blocker. Do not start new exploration.` };
  }
  if (iteration >= expected && !done.replan) {
    return { action: 'replan', expected, note: `Controller note: this ${size.toUpperCase()} task has used ${iteration} model turns (expected about ${expected}). The transcript was compacted. Re-plan in one short list: what is done, what remains (at most 5 steps), then execute only those steps.` };
  }
  return null;
}
