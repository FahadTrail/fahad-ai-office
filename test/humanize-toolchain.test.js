import test from 'node:test';
import assert from 'node:assert/strict';
import { humanError } from '../src/hub-ui/humanize.js';

const toolchainMsg = 'The Coding Agent worker cannot run `go test ./...`: `go` is not installed in the worker image. Node.js and Python projects are supported.';

test('humanError returns the correct sentence for TOOLCHAIN_MISSING in English', () => {
  const expected = 'This project needs a toolchain the Coding Agent does not have (only Node.js and Python are installed). Run it on a Node.js or Python repository, or ask for the toolchain to be added.';
  assert.equal(humanError(toolchainMsg, 'en'), expected);
  assert.equal(humanError('TOOLCHAIN_MISSING', 'en'), expected);
});

test('humanError returns the correct sentence for TOOLCHAIN_MISSING in Arabic', () => {
  const expected = 'هذا المشروع يحتاج أدوات برمجة غير مثبتة عند وكيل البرمجة (المثبت فقط Node.js و Python). شغّله على مستودع Node.js أو Python، أو اطلب إضافة الأدوات.';
  assert.equal(humanError(toolchainMsg, 'ar'), expected);
});

test('humanError does not match unrelated messages', () => {
  const unrelated = 'Test gate failed (npm test, exit 1)';
  // Should not return the toolchain sentence in either language
  assert.notEqual(humanError(unrelated, 'en'), 'This project needs a toolchain the Coding Agent does not have (only Node.js and Python are installed). Run it on a Node.js or Python repository, or ask for the toolchain to be added.');
  assert.notEqual(humanError(unrelated, 'ar'), 'هذا المشروع يحتاج أدوات برمجة غير مثبتة عند وكيل البرمجة (المثبت فقط Node.js و Python). شغّله على مستودع Node.js أو Python، أو اطلب إضافة الأدوات.');
});