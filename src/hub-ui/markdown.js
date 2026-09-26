// Small, safe Markdown renderer for Office answers (no dependencies, no DOM).
// Everything is HTML-escaped first; only a fixed set of constructs is turned
// back into markup, and links are limited to http(s) and mailto. Supports
// headings, paragraphs, bold/italic/strike, inline code, fenced code blocks,
// lists (nested by indentation), blockquotes, tables and horizontal rules.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeUrl(url) {
  const clean = String(url || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(clean) ? clean : null;
}

export function renderInline(text) {
  const codes = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const safe = safeUrl(url.replace(/&amp;/g, '&'));
      return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : match;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderList(lines) {
  // lines: [{ indent, ordered, text }]
  let html = '';
  const stack = [];
  for (const item of lines) {
    while (stack.length && item.indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
    const top = stack.at(-1);
    if (!top || item.indent > top.indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      stack.push({ indent: item.indent, tag });
      html += `<${tag}><li>${renderInline(item.text)}`;
    } else {
      html += `</li><li>${renderInline(item.text)}`;
    }
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : '';
      out.push(`<pre${lang}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { flush(); out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flush();
      const head = splitRow(line);
      index += 2;
      const body = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) body.push(splitRow(lines[index++]));
      index -= 1;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${
        body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      index -= 1;
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      flush();
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!match) break;
        items.push({ indent: match[1].replace(/\t/g, '  ').length, ordered: /\d/.test(match[2]), text: match[3] });
        index += 1;
      }
      index -= 1;
      out.push(renderList(items));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out.join('\n');
}
