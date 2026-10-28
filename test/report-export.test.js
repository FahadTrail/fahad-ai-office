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

test('Word export is a real .docx package: a valid stored ZIP with the WordprocessingML parts', async () => {
  const { crc32, markdownToDocx, DOCX_TYPE } = await import('../src/hub-ui/docx.js');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const bytes = markdownToDocx('# خطة\n\nنص', { title: 'تقرير', now: new Date('2026-10-28T00:00:00Z') });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054B50, 'end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014B50);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const size = view.getUint32(at + 24, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const data = bytes.subarray(local + 30 + view.getUint16(local + 26, true), local + 30 + view.getUint16(local + 26, true) + size);
    assert.equal(crc32(data), view.getUint32(at + 16, true), `crc of ${name}`);
    names.push(name);
    at += 46 + nameLength;
  }
  assert.deepEqual(names.toSorted(), ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/numbering.xml', 'word/styles.xml']);
  assert.equal(DOCX_TYPE, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('the .docx body keeps Arabic right-to-left, tables, lists and emphasis, and escapes text', async () => {
  const { markdownToDocumentXml, inlineRuns } = await import('../src/hub-ui/docx.js');
  const body = markdownToDocumentXml('## الميزانية\n\n| البند | درهم |\n|---|---|\n| إيجار | 8000 |\n\n1. أولًا\n   - فرعي\n- English **bold**\n\n> ملاحظة\n\n```\na < b\n```', 'خطة "ندى" <script> & co');
  assert.match(body, /<w:pStyle w:val="Title"\/><w:bidi\/>/);
  assert.match(body, /<w:pStyle w:val="Heading2"\/><w:bidi\/>/);
  assert.match(body, /<w:tbl>.*<w:bidiVisual\/>.*إيجار.*<\/w:tbl>/s);
  assert.match(body, /<w:numId w:val="2"\/>.*أولًا/s);
  assert.match(body, /<w:ilvl w:val="1"\/><w:numId w:val="1"\/>/);
  assert.match(body, /<w:pStyle w:val="Quote"\/>/);
  assert.match(body, /<w:pStyle w:val="Code"\/><\/w:pPr><w:r><w:t xml:space="preserve">a &lt; b<\/w:t>/);
  assert.match(body, /&lt;script&gt; &amp; co/);
  assert.doesNotMatch(body, /<script>/);
  // An English-only paragraph stays left-to-right.
  assert.match(body, /<w:numId w:val="1"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">English <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr>/);
  assert.deepEqual(inlineRuns('see [docs](https://example.com) and `x`'), [{ text: 'see docs (https://example.com) and ' }, { text: 'x', code: true }]);
  // Control characters XML cannot carry are dropped, not written.
  assert.doesNotMatch(markdownToDocumentXml('bad \u0001 char'), /\u0001/);
});

test('the Word button downloads a .docx, not an HTML .doc', () => {
  const source = readFileSync(new URL('../src/hub-ui/export.js', import.meta.url), 'utf8');
  assert.match(source, /reportFileName\(title, 'docx'\)/);
  assert.match(source, /markdownToDocx/);
  assert.doesNotMatch(source, /application\/msword/);
});
