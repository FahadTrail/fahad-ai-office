import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reportDocument, reportFileName } from '../src/hub-ui/export.js';
import { renderMarkdown } from '../src/hub-ui/markdown.js';

test('a report becomes a Word-readable document that keeps Arabic right-to-left and escapes its title', () => {
  const markdown = '# خطة الإطلاق\n\n| البند | درهم |\n|---|---|\n| إيجار | 8000 |';
  const html = reportDocument('خطة "ندى" <script>', renderMarkdown(markdown), { text: markdown });
  assert.match(html, /^<!doctype html><html lang="ar" dir="rtl">/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(reportDocument('Launch plan', renderMarkdown('# Plan'), { text: '# Plan' }), /dir="ltr"/);
  assert.equal(reportFileName('خطة: الإطلاق / 2026', 'doc'), 'خطة-الإطلاق-2026.doc');
});

test('the deliverables drawer and the job page both offer Word, PDF and Markdown for full reports', () => {
  const drawer = readFileSync(new URL('../src/hub-ui/deliverables.js', import.meta.url), 'utf8');
  const job = readFileSync(new URL('../src/hub-ui/screens.js', import.meta.url), 'utf8');
  for (const format of ['word', 'pdf', 'md']) {
    assert.match(drawer, new RegExp(`data-report-export="${format}"`));
    assert.match(job, new RegExp(`data-download-final="${format}"`));
  }
});
