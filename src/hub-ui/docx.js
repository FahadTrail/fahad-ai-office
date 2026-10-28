// Markdown report → a real Word document (.docx, Office Open XML), built in
// the browser with no dependency: a minimal WordprocessingML body packed in
// an uncompressed ("stored") ZIP. Word, Word mobile, Google Docs/Drive, Pages
// and LibreOffice open it without the "format does not match the extension"
// warning an HTML .doc triggers.
//
// Supported: headings (#–######), paragraphs, bold/italic/strike, inline and
// fenced code, bullet and numbered lists (one indent level per two spaces),
// blockquotes, tables and horizontal rules; an ```artifact block (a Hub card)
// becomes a titled list or table. Links keep their text and show the
// address after it. Every paragraph whose text contains Arabic is laid out
// right-to-left (w:bidi) and its runs marked complex-script (w:rtl), so mixed
// Arabic/English reports read correctly in both directions.

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const encoder = new TextEncoder();

// ------------------------------------------------------------------ zip (store)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// files: [[name, string]] → Uint8Array of a ZIP archive (method 0, UTF-8 names).
export function zipStore(files, date = new Date(Date.UTC(2026, 0, 1))) {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014B50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true); central.setUint16(10, 0, true); central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true); central.setUint32(16, crc, true); central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true); central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// ------------------------------------------------------------------ inline runs
const xml = (value) => String(value ?? '')
  // Characters XML 1.0 cannot carry are dropped rather than corrupting the file.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

// Text with Markdown emphasis → [{ text, bold, italic, strike, code }].
export function inlineRuns(text) {
  const runs = [];
  const source = String(text ?? '')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/gi, (_, label, url) => `${label} (${url})`);
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) runs.push({ text: source.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('**') || token.startsWith('__')) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('~~')) runs.push({ text: token.slice(2, -2), strike: true });
    else runs.push({ text: token.slice(1, -1), italic: true });
    last = match.index + token.length;
  }
  if (last < source.length) runs.push({ text: source.slice(last) });
  return runs.filter((run) => run.text);
}

function runXml(run, rtl, extra = '') {
  const props = [
    run.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '',
    run.bold ? '<w:b/><w:bCs/>' : '', run.italic ? '<w:i/><w:iCs/>' : '', run.strike ? '<w:strike/>' : '',
    extra, rtl || run.rtlText ? '<w:rtl/>' : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
}

function paragraph(text, { style = null, rtl = ARABIC.test(text), numbering = null, runs = null, runProps = '', keepText = false } = {}) {
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    numbering ? `<w:numPr><w:ilvl w:val="${numbering.level}"/><w:numId w:val="${numbering.id}"/></w:numPr>` : '',
    rtl ? '<w:bidi/>' : '',
  ].join('');
  const body = (runs || (keepText ? [{ text }] : inlineRuns(text))).map((run) => runXml(run, rtl, runProps)).join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`;
}

// ------------------------------------------------------------------ blocks
const isDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

function table(header, rows) {
  const width = Math.max(header.length, ...rows.map((row) => row.length));
  const rtl = ARABIC.test([header, ...rows].flat().join(' '));
  const cell = (text, head) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F4"/>' : ''}</w:tcPr>${paragraph(text, { rtl: rtl || ARABIC.test(text), runs: head ? inlineRuns(text).map((run) => ({ ...run, bold: true })) : null })}</w:tc>`;
  const row = (cells, head) => `<w:tr>${Array.from({ length: width }, (_, index) => cell(cells[index] ?? '', head)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="ReportTable"/><w:tblW w:w="5000" w:type="pct"/>${rtl ? '<w:bidiVisual/>' : ''}</w:tblPr>`
    + `<w:tblGrid>${Array.from({ length: width }, () => `<w:gridCol w:w="${Math.floor(9000 / width)}"/>`).join('')}</w:tblGrid>`
    + `${row(header, true)}${rows.map((cells) => row(cells, false)).join('')}</w:tbl>${paragraph('')}`;
}

const ITEM_TEXT = ['text', 'title', 'label', 'name', 'requirement', 'risk', 'item', 'claim', 'hook', 'milestone'];
function artifactBlocks(source) {
  let data;
  try { data = JSON.parse(source); } catch { return []; }
  if (!data || typeof data !== 'object') return [];
  const blocks = data.title ? [paragraph(String(data.title), { style: 'Heading3' })] : [];
  if (Array.isArray(data.columns) && Array.isArray(data.rows)) return [...blocks, table(data.columns.map(String), data.rows.map((row) => (Array.isArray(row) ? row : []).map((cell) => String(cell ?? ''))))];
  const list = [data.items, data.entries, data.findings, data.claims, data.steps].find(Array.isArray) || [];
  for (const entry of list) {
    const key = entry && typeof entry === 'object' ? ITEM_TEXT.find((name) => typeof entry[name] === 'string' && entry[name].trim()) : null;
    const text = typeof entry === 'string' ? entry : key ? entry[key] : '';
    if (text) pushItem(blocks, text, entry);
  }
  return blocks;
}
function pushItem(blocks, text, entry) {
  const owner = entry && typeof entry === 'object' && typeof entry.owner === 'string' && entry.owner ? ` — ${entry.owner}` : '';
  blocks.push(paragraph(`${text}${owner}`, { numbering: { id: 1, level: 0 } }));
}

export function markdownToDocumentXml(markdown, title = '') {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  if (title) out.push(paragraph(title, { style: 'Title', keepText: true }));
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) { body.push(lines[index]); index += 1; }
      index += 1;
      // A structured artifact (drawn as a card in the Hub) becomes a titled
      // list or table, never raw JSON; anything unreadable is left out.
      if (fence[2] === 'artifact') { out.push(...artifactBlocks(body.join('\n'))); continue; }
      for (const code of body) out.push(paragraph(code, { style: 'Code', rtl: false, runs: [{ text: code, rtlText: ARABIC.test(code) }] }));
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { out.push(paragraph(heading[2], { style: `Heading${Math.min(heading[1].length, 3)}` })); index += 1; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C8C8CC"/></w:pBdr></w:pPr></w:p>'); index += 1; continue; }
    if (line.includes('|') && index + 1 < lines.length && isDivider(lines[index + 1])) {
      const header = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(splitRow(lines[index])); index += 1; }
      out.push(table(header, rows));
      continue;
    }
    if (/^\s*>/.test(line)) {
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        out.push(paragraph(lines[index].replace(/^\s*>\s?/, ''), { style: 'Quote' }));
        index += 1;
      }
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      while (index < lines.length) {
        const entry = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!entry) break;
        const level = Math.min(Math.floor(entry[1].replace(/\t/g, '  ').length / 2), 2);
        out.push(paragraph(entry[3], { numbering: { id: /\d/.test(entry[2]) ? 2 : 1, level } }));
        index += 1;
      }
      continue;
    }
    // A paragraph: consecutive plain lines, joined with a space.
    const text = [];
    while (index < lines.length && lines[index].trim() && !/^\s*(#{1,6}\s|```|~~~|>|([-*+]|\d+[.)])\s)/.test(lines[index])
      && !(lines[index].includes('|') && index + 1 < lines.length && isDivider(lines[index + 1]))) {
      text.push(lines[index].trim());
      index += 1;
    }
    if (!text.length) { out.push(paragraph(line.trim())); index += 1; continue; }
    out.push(paragraph(text.join(' ')));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${out.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

// ------------------------------------------------------------------ package
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:bidi="ar-AE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="C8C8CC"/></w:pBdr></w:pPr><w:rPr><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="F5F5F7"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="ReportTable"><w:name w:val="Report Table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="C8C8CC"/><w:left w:val="single" w:sz="4" w:color="C8C8CC"/><w:bottom w:val="single" w:sz="4" w:color="C8C8CC"/><w:right w:val="single" w:sz="4" w:color="C8C8CC"/><w:insideH w:val="single" w:sz="4" w:color="C8C8CC"/><w:insideV w:val="single" w:sz="4" w:color="C8C8CC"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const level = (format, text, ilvl) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (ilvl + 1) + 360}" w:hanging="360"/></w:pPr></w:lvl>`;
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">${[0, 1, 2].map((ilvl) => level('bullet', ['•', '◦', '▪'][ilvl], ilvl)).join('')}</w:abstractNum>
<w:abstractNum w:abstractNumId="1">${[0, 1, 2].map((ilvl) => level(['decimal', 'lowerLetter', 'lowerRoman'][ilvl], `%${ilvl + 1}.`, ilvl)).join('')}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
const core = (title, at) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Fahad AI Office</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function markdownToDocx(markdown, { title = '', now = new Date() } = {}) {
  return zipStore([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['word/document.xml', markdownToDocumentXml(markdown, title)],
    ['word/_rels/document.xml.rels', DOCUMENT_RELS],
    ['word/styles.xml', STYLES],
    ['word/numbering.xml', NUMBERING],
    ['docProps/core.xml', core(title, now)],
  ], now);
}
