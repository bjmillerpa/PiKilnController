// Minimal Markdown → HTML renderer.
//
// Covers the subset our help docs use: headers (# .. ######), paragraphs,
// fenced code blocks (```), inline code (`x`), bold (**x**), italic (*x*),
// links ([text](url)), unordered (*, -) and ordered (1.) lists, tables
// (GFM-style with leading/trailing pipes), and blockquotes (> x).
//
// Tradeoff: not a full CommonMark implementation — no nested lists, no
// reference-style links, no setext headers. If we need those later, vendor
// `marked` instead of growing this. Goal here is small and dependency-free.
//
// All inline output passes through escapeHtml() first, so user-supplied
// markdown can't inject scripts. Code blocks similarly escape their content.

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineFormat(s) {
  let out = escapeHtml(s);
  // Inline code first — its contents must not be processed for bold/italic.
  // Use a placeholder-and-restore pattern so nested asterisks survive.
  const codeChunks = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => {
    const tok = `\x01CODE${codeChunks.length}\x01`;
    codeChunks.push(`<code>${c}</code>`);
    return tok;
  });
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic — careful to require non-word boundary so foo*bar*baz doesn't trip
  out = out.replace(/(^|[\s(\[])\*([^*\s][^*]*?)\*(?=[\s),.;:!?\]]|$)/g,
    '$1<em>$2</em>');
  // Links — open in new tab so the operator UI stays put
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Restore code chunks
  out = out.replace(/\x01CODE(\d+)\x01/g, (_m, i) => codeChunks[Number(i)]);
  return out;
}

function renderTable(rows) {
  // rows is an array of arrays of cell strings. First row is header.
  // The separator row (|---|---|) has already been consumed by the caller.
  if (rows.length === 0) return '';
  let html = '<table>\n<thead><tr>';
  for (const cell of rows[0]) html += `<th>${inlineFormat(cell)}</th>`;
  html += '</tr></thead>\n<tbody>\n';
  for (let i = 1; i < rows.length; i++) {
    html += '<tr>';
    for (const cell of rows[i]) html += `<td>${inlineFormat(cell)}</td>`;
    html += '</tr>\n';
  }
  html += '</tbody>\n</table>\n';
  return html;
}

function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|'))   s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

export function renderMarkdown(md) {
  if (typeof md !== 'string') return '';
  const lines = md.split(/\r?\n/);
  let html = '';
  let i = 0;

  function isTableSeparator(s) {
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(s);
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(.*)$/);
    if (fenceMatch) {
      const lang = fenceMatch[1].trim();
      i++;
      const code = [];
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      html += `<pre><code${lang ? ` class="lang-${lang}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>\n`;
      continue;
    }

    // Header
    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (hMatch) {
      const level = hMatch[1].length;
      html += `<h${level}>${inlineFormat(hMatch[2])}</h${level}>\n`;
      i++;
      continue;
    }

    // Table — needs a header row, separator, then data rows
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows = [parseTableRow(line)];
      i += 2; // past header and separator
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      html += renderTable(rows);
      continue;
    }

    // Blockquote (consecutive > lines)
    if (/^>\s?/.test(line)) {
      const block = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        block.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html += `<blockquote>${inlineFormat(block.join(' '))}</blockquote>\n`;
      continue;
    }

    // List (consecutive list items)
    const ulMatch = line.match(/^[*\-+]\s+(.+)$/);
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const tag = ulMatch ? 'ul' : 'ol';
      const itemRegex = ulMatch ? /^[*\-+]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      let items = '';
      while (i < lines.length && itemRegex.test(lines[i])) {
        const itemText = lines[i].match(itemRegex)[1];
        items += `<li>${inlineFormat(itemText)}</li>\n`;
        i++;
      }
      html += `<${tag}>\n${items}</${tag}>\n`;
      continue;
    }

    // Blank line — paragraph separator
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines
    const para = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') break;
      if (/^#{1,6}\s/.test(next)) break;
      if (/^```/.test(next)) break;
      if (/^[*\-+]\s/.test(next) || /^\d+\.\s/.test(next)) break;
      if (/^>\s?/.test(next)) break;
      if (next.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      para.push(next.trim());
      i++;
    }
    html += `<p>${inlineFormat(para.join(' '))}</p>\n`;
  }

  return html;
}
