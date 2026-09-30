/*
 * Design Bytes Markdown — a small, dependency-free Markdown renderer.
 * Runs in the browser (window.DBMarkdown) and in Node (require).
 *
 * Supports: ATX/setext headings, paragraphs, emphasis, strong, strikethrough,
 * inline code, fenced code, links, images, autolinks, blockquotes, nested
 * ordered/unordered/task lists, tables, horizontal rules and hard breaks.
 * Raw HTML is escaped, so rendered output is always safe to inject.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBMarkdown = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const WORDS_PER_MINUTE = 238;

  const RE = {
    fence: /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/,
    atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
    hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
    quote: /^ {0,3}> ?/,
    list: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/,
    setext1: /^ {0,3}=+[ \t]*$/,
    setext2: /^ {0,3}-+[ \t]*$/,
    tableDelim: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  };

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const isBlank = (line) => /^\s*$/.test(line);
  const indentOf = (line) => line.match(/^ */)[0].length;

  function plainText(html) {
    return String(html)
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }

  function slugify(text) {
    return plainText(text)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
  }

  function isListStart(line, interruptsParagraph) {
    const m = line.match(RE.list);
    if (!m) return false;
    if (!interruptsParagraph) return true;
    // CommonMark: only non-empty items, and ordered lists starting at 1, may interrupt a paragraph.
    if (!m[3]) return false;
    return !/\d/.test(m[2]) || parseInt(m[2], 10) === 1;
  }

  function startsBlock(line) {
    return RE.fence.test(line) || RE.atx.test(line) || RE.hr.test(line) ||
      RE.quote.test(line) || isListStart(line, true);
  }

  // ---------------------------------------------------------------------------
  // Front matter: an optional block of "key: value" lines at the top of a file.
  //
  //   ---
  //   status: published
  //   ---

  const STATUSES = ['backlog', 'editing', 'final', 'published'];
  const DEFAULT_STATUS = 'backlog';
  const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
  const META_LINE = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/;

  // Returns { data, body, end, lines }: `end` is the character offset where the
  // body starts and `lines` how many lines the front matter occupies.
  function frontMatter(src) {
    const text = String(src == null ? '' : src);
    const m = text.match(FRONT);
    const inner = m ? m[1].split(/\r?\n/) : [];
    // Only treat it as front matter if every line is "key: value" (or blank / a comment),
    // so an article that happens to start with a --- divider isn't swallowed.
    if (!m || !inner.every((l) => !l.trim() || l.trim().startsWith('#') || META_LINE.test(l))) {
      return { data: {}, body: text, end: 0, lines: 0 };
    }
    const data = {};
    for (const line of inner) {
      const kv = line.match(META_LINE);
      if (kv) data[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    return { data, body: text.slice(m[0].length), end: m[0].length, lines: (m[0].match(/\n/g) || []).length };
  }

  // Returns src with `key` set to `value` in its front matter (adding the block if needed).
  function setMeta(src, key, value) {
    const text = String(src == null ? '' : src);
    const fm = frontMatter(text);
    const line = `${key}: ${value}`;
    if (!fm.end) return `---\n${line}\n---\n\n${text.replace(/^\s*\n/, '')}`;
    const inner = text.match(FRONT)[1].split(/\r?\n/);
    const at = inner.findIndex((l) => l.startsWith(`${key}:`));
    if (at > -1) inner[at] = line;
    else inner.push(line);
    return `---\n${inner.filter((l) => l.trim()).join('\n')}\n---\n${fm.body}`;
  }

  // Markdown ready to paste into a publishing system such as Ghost: no front
  // matter, links that were pasted twice repaired, and (by default) without the
  // title heading, since the publishing system has its own title field.
  function forPublishing(src, { includeTitle = false } = {}) {
    let body = frontMatter(src).body.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '');
    if (!includeTitle) {
      body = body.replace(/^ {0,3}#{1,6}[ \t]+.*\n?/, '').replace(/^\S.*\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/, '');
    }
    body = body.replace(/\]\(\[[^\]]*\]\(([^()\s]+)\)\)/g, ']($1)');
    return body.replace(/^\s*\n/, '').replace(/\s*$/, '\n');
  }

  function status(src) {
    const value = String(frontMatter(src).data.status || '').toLowerCase();
    return STATUSES.includes(value) ? value : DEFAULT_STATUS;
  }

  // ---------------------------------------------------------------------------
  // Block level

  function render(src) {
    const text = frontMatter(src).body
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/\u0000/g, '�');
    return parseBlocks(text.split('\n'), { slugs: new Map() }, false);
  }

  function parseBlocks(lines, ctx, tight) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      let m;

      if (isBlank(line)) { i++; continue; }

      if ((m = line.match(RE.fence))) {
        const fence = m[1];
        const lang = m[2];
        const indent = indentOf(line);
        const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
        const body = [];
        i++;
        while (i < lines.length && !closing.test(lines[i])) {
          body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
          i++;
        }
        i++;
        const cls = lang ? ` class="language-${esc(lang)}"` : '';
        out.push(`<pre><code${cls}>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }

      if ((m = line.match(RE.atx))) {
        out.push(heading(m[1].length, m[2] || '', ctx));
        i++;
        continue;
      }

      if (RE.hr.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      if (RE.quote.test(line)) {
        const body = [];
        while (i < lines.length && !isBlank(lines[i])) {
          if (RE.quote.test(lines[i])) body.push(lines[i].replace(RE.quote, ''));
          else if (!startsBlock(lines[i])) body.push(lines[i]); // lazy continuation
          else break;
          i++;
        }
        out.push(`<blockquote>\n${parseBlocks(body, ctx, false)}\n</blockquote>`);
        continue;
      }

      if (isListStart(line, false)) {
        const list = parseList(lines, i, ctx);
        out.push(list.html);
        i = list.next;
        continue;
      }

      if (isTableStart(lines, i)) {
        const table = parseTable(lines, i);
        out.push(table.html);
        i = table.next;
        continue;
      }

      // Paragraph (or setext heading)
      const para = [line.replace(/^ +/, '')];
      let setext = 0;
      i++;
      while (i < lines.length && !isBlank(lines[i])) {
        const l = lines[i];
        if (RE.setext1.test(l)) { setext = 1; i++; break; }
        if (RE.setext2.test(l)) { setext = 2; i++; break; }
        if (startsBlock(l) || isTableStart(lines, i)) break;
        para.push(l.replace(/^ +/, ''));
        i++;
      }
      if (setext) {
        out.push(heading(setext, para.join(' '), ctx));
      } else {
        const html = inline(para.join('\n').replace(/[ \t]+$/, ''));
        out.push(tight ? html : `<p>${html}</p>`);
      }
    }

    return out.join('\n');
  }

  function heading(level, text, ctx) {
    const html = inline(text.trim());
    const base = slugify(html) || 'section';
    const seen = ctx.slugs.get(base) || 0;
    ctx.slugs.set(base, seen + 1);
    const id = seen ? `${base}-${seen}` : base;
    return `<h${level} id="${esc(id)}">${html}</h${level}>`;
  }

  function parseList(lines, start, ctx) {
    const first = lines[start].match(RE.list);
    const ordered = /\d/.test(first[2]);
    const delimiter = first[2].slice(-1);
    const sameList = (m) => m && /\d/.test(m[2]) === ordered && m[2].slice(-1) === delimiter;
    const items = [];
    let loose = false;
    let i = start;

    while (i < lines.length) {
      const m = lines[i].match(RE.list);
      if (!sameList(m) || m[1].length > first[1].length + 1) break;

      const gap = m[3].length === 0 || m[3].length > 4 ? 1 : m[3].length;
      const indent = m[1].length + m[2].length + gap;
      const body = [lines[i].slice(m[0].length)];
      i++;

      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && indentOf(lines[j]) >= indent) {
            for (; i < j; i++) body.push('');
            loose = true;
            continue;
          }
          break;
        }
        const ind = indentOf(l);
        if (ind >= indent) { body.push(l.slice(indent)); i++; continue; }
        // A nested list indented less than the content column (e.g. "1. a\n  - b").
        if (ind > m[1].length && RE.list.test(l)) { body.push(l.slice(ind)); i++; continue; }
        if (startsBlock(l) || RE.list.test(l)) break;
        body.push(l.replace(/^ +/, '')); // lazy continuation
        i++;
      }

      items.push(body);

      if (i < lines.length && isBlank(lines[i])) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        const next = j < lines.length && lines[j].match(RE.list);
        if (sameList(next) && next[1].length <= first[1].length + 1) { loose = true; i = j; }
        else break;
      }
    }

    let hasTasks = false;
    const lis = items.map((body) => {
      const task = body[0].match(/^\[([ xX])\][ \t]+/);
      if (task) body[0] = body[0].slice(task[0].length);
      let inner = parseBlocks(body, ctx, !loose);
      if (!task) return `<li>${inner}</li>`;
      hasTasks = true;
      const box = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
      inner = inner.startsWith('<p>') ? `<p>${box}${inner.slice(3)}` : box + inner;
      return `<li class="task">${inner}</li>`;
    });

    const tag = ordered ? 'ol' : 'ul';
    const from = ordered ? parseInt(first[2], 10) : 1;
    const attrs = (ordered && from !== 1 ? ` start="${from}"` : '') + (hasTasks ? ' class="tasks"' : '');
    return { html: `<${tag}${attrs}>\n${lis.join('\n')}\n</${tag}>`, next: i };
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
      if (s[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[k];
    }
    cells.push(cur.trim());
    return cells;
  }

  function isTableStart(lines, i) {
    const head = lines[i];
    const delim = lines[i + 1];
    if (!head || !delim || !head.includes('|') || !delim.includes('|') || !RE.tableDelim.test(delim)) return false;
    return splitRow(head).length === splitRow(delim).length;
  }

  function parseTable(lines, i) {
    const head = splitRow(lines[i]);
    const align = splitRow(lines[i + 1]).map((d) => {
      const left = d.startsWith(':');
      const right = d.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
    const cell = (tag, text, k) =>
      `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(text || '')}</${tag}>`;

    let j = i + 2;
    const rows = [];
    while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|') && !startsBlock(lines[j])) {
      rows.push(splitRow(lines[j]));
      j++;
    }

    const thead = `<thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>`;
    const tbody = rows.length
      ? `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('')}</tbody>`
      : '';
    return { html: `<div class="table-wrap"><table>${thead}${tbody}</table></div>`, next: j };
  }

  // ---------------------------------------------------------------------------
  // Inline level
  //
  // Finished HTML fragments are "held" in a stash and replaced by \u0000n\u0000
  // placeholders so later passes (escaping, emphasis) never touch them.

  function inline(text) {
    const stash = [];
    return restore(inlineInto(text, stash), stash);
  }

  function restore(s, stash) {
    let prev;
    do {
      prev = s;
      s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[+n]);
    } while (s !== prev);
    return s;
  }

  function inlineInto(text, stash) {
    const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let s = text;

    s = s.replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
      const body = code.replace(/\n/g, ' ');
      return hold(`<code>${esc(/^ .* $/.test(body) ? body.slice(1, -1) : body)}</code>`);
    });
    s = s.replace(/\\\n/g, () => hold('<br>\n'));
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, (_, c) => hold(esc(c)));
    s = s.replace(/<((?:https?|mailto):[^\s<>]+)>/gi, (_, url) =>
      hold(`<a href="${esc(url)}">${esc(url)}</a>`));
    s = linksAndImages(s, stash, hold);
    s = esc(s);
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;!?'")\]])/g, (_, pre, url) =>
      pre + hold(`<a href="${url.startsWith('www.') ? 'https://' : ''}${url}">${url}</a>`));

    s = s.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>');
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
    s = s.replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(/ {2,}\n/g, '<br>\n');
    return s;
  }

  function matching(s, openIndex, open, close) {
    let depth = 0;
    for (let k = openIndex; k < s.length; k++) {
      if (s[k] === open) depth++;
      else if (s[k] === close && --depth === 0) return k;
    }
    return -1;
  }

  function destination(raw) {
    let href = raw.trim();
    let title = '';
    const titled = href.match(/^(<[^>]*>|\S+)\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/);
    if (titled) {
      href = titled[1];
      title = titled[2] ?? titled[3] ?? titled[4] ?? '';
    }
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
    // A link pasted over an existing link — [text]([url](url)) — use the inner URL.
    const nested = href.match(/^\[[^\]]*\]\(([^()\s]+)\)$/);
    if (nested) href = nested[1];
    return { href: href.replace(/ /g, '%20'), title };
  }

  function safeUrl(url) {
    const u = url.replace(/[\u0000-\u001F\u007F\s]/g, '');
    if (/^(javascript|vbscript|file):/i.test(u)) return '#';
    if (/^data:/i.test(u) && !/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(u)) return '#';
    return url;
  }

  function linksAndImages(s, stash, hold) {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const isImage = s[i] === '!' && s[i + 1] === '[';
      const open = isImage ? i + 1 : i;
      if (s[open] === '[') {
        const close = matching(s, open, '[', ']');
        if (close > -1 && s[close + 1] === '(') {
          const end = matching(s, close + 1, '(', ')');
          if (end > -1) {
            const label = s.slice(open + 1, close);
            const { href, title } = destination(restore(s.slice(close + 2, end), stash).replace(/<[^>]*>/g, ''));
            const t = title ? ` title="${esc(title)}"` : '';
            if (isImage) {
              const alt = plainText(restore(label, stash)).replace(/[*_`]/g, '');
              out += hold(`<img src="${esc(safeUrl(href))}" alt="${esc(alt)}"${t} loading="lazy">`);
            } else {
              out += hold(`<a href="${esc(safeUrl(href))}"${t}>${inlineInto(label, stash)}</a>`);
            }
            i = end + 1;
            continue;
          }
        }
      }
      out += s[i];
      i++;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Helpers for the writing tools

  function title(src) {
    const text = frontMatter(src).body;
    const atx = text.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m);
    if (atx) return plainText(inline(atx[1])).trim();
    const setext = text.match(/^(\S.*)\n {0,3}(?:=+|-+)[ \t]*$/m);
    return setext ? plainText(inline(setext[1])).trim() : '';
  }

  function stats(src) {
    const text = frontMatter(src).body;
    const prose = text
      .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm, ' ')
      .replace(/!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/g, ' ')
      .replace(/\]\((?:[^()]|\([^)]*\))*\)/g, ']');
    const words = (prose.match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu) || []).length;
    return {
      words,
      characters: text.length,
      minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    };
  }

  function excerpt(src, max = 220) {
    const first = render(src).match(/<p>([\s\S]*?)<\/p>/);
    if (!first) return '';
    const text = plainText(first[1]).replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return text.slice(0, text.lastIndexOf(' ', max)).replace(/[,;:.\s]+$/, '') + '…';
  }

  // Lightweight writing checks. Each issue: { line, column, length, message }.
  function lint(src) {
    const issues = [];
    const fm = frontMatter(src);
    const lines = fm.body.replace(/\r\n?/g, '\n').split('\n');
    let fence = null;

    lines.forEach((line, n) => {
      const f = line.match(RE.fence);
      if (f && (!fence || f[1][0] === fence[0])) { fence = fence ? null : f[1]; return; }
      if (fence) return;

      const add = (index, length, message) =>
        issues.push({ line: fm.lines + n + 1, column: index + 1, length, message });
      const scan = (re, fn) => { let m; re.lastIndex = 0; while ((m = re.exec(line))) fn(m); };
      const code = [];
      scan(/`+[^`]*`+/g, (m) => code.push([m.index, m.index + m[0].length]));
      const inCode = (k) => code.some(([a, b]) => k >= a && k < b);

      scan(/\]\(\[[^\]]*\]\([^)]*\)\)/g, (m) => {
        if (!inCode(m.index)) add(m.index + 2, m[0].length - 3, 'Link URL is itself a Markdown link — probably pasted twice.');
      });
      scan(/\[[^\]]+\]\(\s*\)/g, (m) => {
        if (!inCode(m.index)) add(m.index, m[0].length, 'Link has no URL.');
      });
      scan(/(?<!\p{L})(\p{L}+)(?=(\s+)(\p{L}+)(?!\p{L}))/gu, (m) => {
        if (m[1].toLowerCase() === m[3].toLowerCase() && !inCode(m.index)) {
          add(m.index, m[1].length + m[2].length + m[3].length, `Repeated word “${m[1]}”.`);
        }
      });
      if (!line.includes('|')) {
        const prefix = (line.match(/^\s*(?:[-*+]|\d+[.)]|>|#{1,6})?\s*/) || [''])[0].length;
        const reDouble = /(\S) {2,}(?=\S)/g;
        let m;
        while ((m = reDouble.exec(line.slice(prefix)))) {
          if (!inCode(prefix + m.index)) add(prefix + m.index + 1, m[0].length - 1, 'Extra spaces between words.');
        }
      }
    });

    return issues;
  }

  return {
    render, inline, title, stats, excerpt, lint, slugify, plainText, escape: esc,
    frontMatter, setMeta, status, forPublishing, STATUSES, DEFAULT_STATUS,
  };
});
