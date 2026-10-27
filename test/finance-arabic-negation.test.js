import test from 'node:test';
import assert from 'node:assert/strict';
import { proseClaims } from '../src/office/finance.js';

const breakEven = (text) => proseClaims(text).filter((claim) => claim.label === 'break-even month').map((claim) => [claim.kind, claim.value]);

// Production acceptance run 2026-10-27 (job ace99f39…): «لن» inside «النقدي»
// read as a negation, so a correct month-6 statement was sent back as
// "not reached" and cost a needless revision round.
test('Arabic break-even statements are negated only by a whole negation word', () => {
  assert.deepEqual(breakEven('**النتيجة:** - **التعادل النقدي التراكمي: الشهر 6** - **إجمالي الإيرادات (12 شهر): 594,000 درهم**'), [['break_even', 6]]);
  assert.deepEqual(breakEven('التعادل في الشهر 6 خلال السنة الأولى'), [['break_even', 6]]);
  assert.deepEqual(breakEven('نقطة التعادل لا تتحقق حتى الشهر 12'), [['break_even_not', 12]]);
  assert.deepEqual(breakEven('لن نصل إلى التعادل قبل الشهر 12'), [['break_even_not', 12]], 'negation placed before the phrase');
  assert.deepEqual(breakEven('We do not break even by month 12.'), [['break_even_not', 12]]);
  assert.deepEqual(breakEven('Break-even in month 7.'), [['break_even', 7]]);
});
