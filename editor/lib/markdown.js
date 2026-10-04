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

  // ---------------------------------------------------------------------------
  // Notes: a private block at the end of the file, kept inside an HTML comment
  // so it stays hidden everywhere the Markdown is shown (GitHub, Ghost, …).
  //
  //   <!-- notes
  //   A sentence I cut…
  //   -->

  const NOTES = /\n*^<!-- notes[ \t]*\r?\n([\s\S]*?)\r?\n?^-->[ \t]*(?:\r?\n|$)/m;

  // Splits text into { article, notes }.
  function splitNotes(src) {
    const text = String(src == null ? '' : src);
    const m = text.match(NOTES);
    if (!m) return { article: text, notes: '' };
    const article = text.slice(0, m.index) + (m.index + m[0].length < text.length ? '\n\n' + text.slice(m.index + m[0].length) : '\n');
    return { article: m.index === 0 ? article.replace(/^\n+/, '') : article, notes: m[1] };
  }

  // Joins article text and notes back into one file. With no notes, the article is returned unchanged.
  function joinNotes(article, notes) {
    const n = String(notes || '').replace(/\s+$/, '');
    if (!n.trim()) return article;
    // "-->" would end the comment early, so it's softened to "-- >".
    return `${String(article).replace(/\s+$/, '')}\n\n<!-- notes\n${n.replace(/-->/g, '-- >')}\n-->\n`;
  }

  const articleBody = (src) => splitNotes(frontMatter(src).body).article;

  // Inside the notes, text moved out of the article is kept with the words that
  // surrounded it, so it can be put back in the same place later:
  //
  //   [cut] {"before":"…text before…","after":"…text after…","lead":" ","trail":""}
  //   The moved text
  //   [/cut]

  const CUT = /^\[cut\] (\{.*\})[ \t]*\r?\n([\s\S]*?)\r?\n\[\/cut\][ \t]*$/gm;

  // Splits notes into free-form text and the list of cuts.
  function parseNotes(notes) {
    const cuts = [];
    const text = String(notes || '').replace(CUT, (_, meta, body) => {
      let m = {};
      try { m = JSON.parse(meta); } catch { /* keep the text, lose the location */ }
      const str = (v) => (typeof v === 'string' ? v : '');
      cuts.push({ text: body, before: str(m.before), after: str(m.after), lead: str(m.lead), trail: str(m.trail) });
      return '';
    });
    return { text: text.replace(/\n{3,}/g, '\n\n').trim(), cuts };
  }

  function formatNotes({ text = '', cuts = [] }) {
    return [
      String(text).trim(),
      ...cuts.map((c) => `[cut] ${JSON.stringify({ before: c.before, after: c.after, lead: c.lead, trail: c.trail })}\n${c.text}\n[/cut]`),
    ].filter(Boolean).join('\n\n');
  }

  // Where a cut belongs in the article now: the offset between the words that
  // surrounded it, or -1 if that spot can't be found unambiguously.
  function findCutSpot(article, { before = '', after = '' }) {
    const unique = (needle) => {
      const i = article.indexOf(needle);
      return i > -1 && article.indexOf(needle, i + 1) === -1 ? i : -1;
    };
    if (before || after) {
      const both = unique(before + after);
      if (both > -1) return both + before.length;
    }
    for (const n of [60, 30, 15]) {
      const b = before.slice(-n);
      if (b.trim().length >= 6) { const i = unique(b); if (i > -1) return i + b.length; }
      const a = after.slice(0, n);
      if (a.trim().length >= 6) { const i = unique(a); if (i > -1) return i; }
    }
    if (!before.trim()) return 0;
    if (!after.trim()) return article.replace(/\s+$/, '').length;
    return -1;
  }

  // Markdown ready to paste into a publishing system such as Ghost: no front
  // matter, links that were pasted twice repaired, and (by default) without the
  // title heading, since the publishing system has its own title field.
  function forPublishing(src, { includeTitle = false } = {}) {
    let body = articleBody(src).replace(/\r\n?/g, '\n').replace(/^\s*\n/, '');
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
    const text = articleBody(src)
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
    const text = articleBody(src);
    const atx = text.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m);
    if (atx) return plainText(inline(atx[1])).trim();
    const setext = text.match(/^(\S.*)\n {0,3}(?:=+|-+)[ \t]*$/m);
    return setext ? plainText(inline(setext[1])).trim() : '';
  }

  function stats(src) {
    const text = articleBody(src);
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

  // ---------------------------------------------------------------------------
  // Comparing two versions of an article: paragraphs first, then words within
  // paragraphs that changed.

  // Longest-common-subsequence diff of two token lists → [['same'|'del'|'add', token], …].
  function diffTokens(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const head = a.slice(0, start).map((t) => ['same', t]);
    const tail = a.slice(endA).map((t) => ['same', t]);
    const x = a.slice(start, endA);
    const y = b.slice(start, endB);
    const n = x.length;
    const m = y.length;
    const ops = [];
    if (n * m > 4e6) { // too big to compare finely: show as replaced
      x.forEach((t) => ops.push(['del', t]));
      y.forEach((t) => ops.push(['add', t]));
      return [...head, ...ops, ...tail];
    }
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { ops.push(['same', x[i]]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(['del', x[i++]]);
      else ops.push(['add', y[j++]]);
    }
    while (i < n) ops.push(['del', x[i++]]);
    while (j < m) ops.push(['add', y[j++]]);
    return [...head, ...ops, ...tail];
  }

  // Word-level changes within a paragraph → [{ type, text }], merged into runs.
  function diffWords(a, b) {
    const tokens = (s) => s.match(/\s+|[\p{L}\p{N}’'-]+|[^\s\p{L}\p{N}]/gu) || [];
    const parts = [];
    for (const [type, text] of diffTokens(tokens(a), tokens(b))) {
      const last = parts[parts.length - 1];
      if (last && last.type === type) last.text += text;
      else parts.push({ type, text });
    }
    return parts;
  }

  // Compares two texts → blocks of { type: 'same'|'del'|'add', text } or
  // { type: 'change', parts } for a paragraph that was edited.
  function diffText(oldText, newText) {
    const paras = (t) => String(t || '').replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((p) => p.trim());
    const ops = diffTokens(paras(oldText), paras(newText));
    const out = [];
    for (let k = 0; k < ops.length;) {
      if (ops[k][0] === 'same') { out.push({ type: 'same', text: ops[k][1] }); k++; continue; }
      const dels = [];
      const adds = [];
      while (k < ops.length && ops[k][0] !== 'same') { (ops[k][0] === 'del' ? dels : adds).push(ops[k][1]); k++; }
      const paired = Math.min(dels.length, adds.length);
      for (let p = 0; p < paired; p++) {
        const parts = diffWords(dels[p], adds[p]);
        const kept = parts.filter((x) => x.type === 'same').reduce((s, x) => s + x.text.length, 0);
        // Only show as an edit if the paragraphs still have a fair amount in common.
        if (kept >= 0.3 * Math.max(dels[p].length, adds[p].length)) out.push({ type: 'change', parts });
        else out.push({ type: 'del', text: dels[p] }, { type: 'add', text: adds[p] });
      }
      dels.slice(paired).forEach((text) => out.push({ type: 'del', text }));
      adds.slice(paired).forEach((text) => out.push({ type: 'add', text }));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Readability: long sentences, passive voice, adverbs and wordy phrases, with
  // character offsets into the source so the editor can highlight them.

  const LONG_SENTENCE = 25;
  const VERY_LONG_SENTENCE = 35;

  const IRREGULAR_PARTICIPLES = new Set(('arisen awoken been beaten become begun bent bet bitten bled blown borne born bought bound broken ' +
    'brought built burnt burst caught chosen clung come cost crept cut dealt done drawn dreamt driven drunk dug dwelt eaten ' +
    'fallen fed felt fled flown forbidden forecast foregone foreseen forgiven forgotten forsaken fought found frozen given gone ' +
    'got gotten grown hidden held hit hung hurt kept knelt known laid led left lent let lit lost made meant met mistaken overcome ' +
    'overdone overheard overlooked overrun overseen overtaken overthrown paid proven put quit read rid ridden risen run said ' +
    'seen sent set sewn shaken shed shone shot shown shrunk shut slain slept slid sold sought sown spent spoken spread sprung ' +
    'stolen stood struck strung stuck stung sung sunk swept sworn swum swung taken taught thought thrown told torn understood ' +
    'undertaken undone upheld upset withdrawn withheld woken won worn wound written').split(' '));

  const NOT_ADVERBS = new Set(('ally anomaly apply assembly belly billy bully butterfly chilly comply costly curly daily dragonfly ' +
    'early elderly emily family firefly fly folly friendly ghastly gully hilly holly holy homily imply italy jelly jolly july ' +
    'kelly likely lily lively lonely lovely melancholy molly monopoly monthly multiply oily only orderly ply quarterly rally ' +
    'rely reply sally silly sly smelly supply tally timely ugly unlikely weekly wily woolly yearly').split(' '));

  // Wordy phrases and filler words → what to do instead.
  const WORDY = [
    [/\bin order to\b/gi, 'Wordy — “to” is enough'],
    [/\bdue to the fact that\b/gi, 'Wordy — try “because”'],
    [/\bin spite of the fact that\b/gi, 'Wordy — try “although”'],
    [/\bat this point in time\b/gi, 'Wordy — try “now”'],
    [/\bat the present time\b/gi, 'Wordy — try “now”'],
    [/\bin the event that\b/gi, 'Wordy — try “if”'],
    [/\bfor the purpose of\b/gi, 'Wordy — try “for” or “to”'],
    [/\bwith regard to\b/gi, 'Wordy — try “about”'],
    [/\bin regard to\b/gi, 'Wordy — try “about”'],
    [/\bin terms of\b/gi, 'Often vague — say what you mean directly'],
    [/\ba (?:large )?number of\b/gi, 'Wordy — try “many” or “several”'],
    [/\ba lot of\b/gi, 'Vague — try “many”, “much” or a number'],
    [/\beach and every\b/gi, 'Redundant — “each” or “every”'],
    [/\bfirst and foremost\b/gi, 'Redundant — try “first”'],
    [/\bprior to\b/gi, 'Simpler: “before”'],
    [/\bsubsequent to\b/gi, 'Simpler: “after”'],
    [/\butili[sz](?:e|es|ed|ing)\b/gi, 'Simpler: “use”'],
    [/\bfacilitat(?:e|es|ed|ing)\b/gi, 'Simpler: “help” or “ease”'],
    [/\bcommence(?:s|d)?\b/gi, 'Simpler: “start” or “begin”'],
    [/\bit is important to note that\b/gi, 'Filler — cut it and just say the thing'],
    [/\bit should be noted that\b/gi, 'Filler — cut it'],
    [/\bneedless to say\b/gi, 'Filler — cut it'],
    [/\bthe fact that\b/gi, 'Often wordy — can you cut it?'],
    [/\b(?:very|really|quite|somewhat|actually|basically|literally|totally|simply)\b/gi, 'Filler — usually stronger without it'],
    [/\bjust\b(?!\s+(?:as|like|because)\b)/gi, 'Filler — usually stronger without it'],
    [/\brather\b(?!\s+than\b)/gi, 'Filler — usually stronger without it'],
  ];

  const ABBREVIATIONS = new Set('e.g i.e etc vs mr mrs ms dr prof st jr sr inc ltd co fig no approx u.s u.k'.split(' '));

  function syllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  // Replaces everything that isn't prose (front matter, code, headings, URLs,
  // Markdown punctuation…) with spaces, keeping every offset the same.
  function proseMask(src) {
    const blank = (s) => s.replace(/[^\n]/g, ' ');
    const fm = frontMatter(src);
    let text = blank(src.slice(0, fm.end)) + src.slice(fm.end);
    let fence = null;
    let offset = 0;
    const lines = text.split('\n').map((line) => {
      const start = offset;
      offset += line.length + 1;
      if (start < fm.end) return line;
      const f = line.match(RE.fence);
      if (f && (!fence || f[1][0] === fence[0])) { fence = fence ? null : f[1]; return blank(line); }
      if (fence || RE.atx.test(line) || RE.hr.test(line) || line.includes('|') || /^\s*(<!--|-->|!\[)/.test(line)) return blank(line);
      return line
        .replace(/^(\s*(?:>\s?)*)(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s+)?/, blank); // quote / list markers
    });
    text = lines.join('\n');
    return text
      .replace(/`[^`\n]*`/g, blank)
      .replace(/!\[[^\]\n]*\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, blank)
      .replace(/\[([^\]\n]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, (m, label) => ` ${label}${blank(m.slice(label.length + 1))}`)
      .replace(/<[^>\n]*>/g, blank)
      .replace(/\bhttps?:\/\/\S+/g, blank)
      .replace(/[*_~\\]/g, ' ');
  }

  // Splits masked prose into paragraph-ish blocks, then sentences → [{ start, end, words }].
  function sentences(src, mask) {
    const out = [];
    const blocks = [];
    let start = null;
    let offset = 0;
    for (const line of src.split('\n')) {
      const lineStart = offset;
      offset += line.length + 1;
      const masked = mask.slice(lineStart, lineStart + line.length);
      const startsItem = /^\s*(?:[-*+]|\d+[.)]|>)\s/.test(line);
      if (!masked.trim() || startsItem) {
        if (start !== null) blocks.push([start, lineStart - 1]);
        start = masked.trim() ? lineStart : null;
      } else if (start === null) {
        start = lineStart;
      }
    }
    if (start !== null) blocks.push([start, src.length]);

    const WORD = /[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu;
    for (const [from, to] of blocks) {
      const block = mask.slice(from, to);
      let cursor = 0;
      const push = (a, b) => {
        const piece = block.slice(a, b);
        const lead = piece.length - piece.trimStart().length;
        const body = piece.trim();
        const words = (body.match(WORD) || []);
        if (!words.length) return;
        let begin = from + a + lead;
        while (begin > from && /[*_~[]/.test(src[begin - 1])) begin--; // include opening **, _ or [
        out.push({ start: begin, end: from + a + lead + body.length, words });
      };
      const END = /[.!?…]+["”’)\]]*(?=\s|$)/g;
      let m;
      while ((m = END.exec(block))) {
        const before = block.slice(cursor, m.index).match(/([\p{L}.]+)$/u);
        const word = before ? before[1].toLowerCase() : '';
        if (m[0] === '.' && (ABBREVIATIONS.has(word.replace(/\.$/, '')) || /^\p{Lu}$/u.test(before?.[1] || ''))) continue;
        push(cursor, m.index + m[0].length);
        cursor = m.index + m[0].length;
      }
      push(cursor, block.length);
    }
    return out;
  }

  // → { grade, sentences, words, issues: [{ start, end, kind, message }] }, where kind is
  //   'very-long' | 'long' | 'passive' | 'adverb' | 'wordy'. Offsets index into src.
  function readability(src) {
    const text = String(src || '');
    const mask = proseMask(text);
    const issues = [];

    const list = sentences(text, mask);
    let totalWords = 0;
    let totalSyllables = 0;
    for (const s of list) {
      totalWords += s.words.length;
      totalSyllables += s.words.reduce((n, w) => n + syllables(w), 0);
      if (s.words.length >= VERY_LONG_SENTENCE) {
        issues.push({ start: s.start, end: s.end, kind: 'very-long', message: `Very long sentence (${s.words.length} words) — try splitting it` });
      } else if (s.words.length >= LONG_SENTENCE) {
        issues.push({ start: s.start, end: s.end, kind: 'long', message: `Long sentence (${s.words.length} words) — could it be shorter?` });
      }
    }

    const wordy = [];
    for (const [re, message] of WORDY) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(mask))) wordy.push({ start: m.index, end: m.index + m[0].length, kind: 'wordy', message });
    }
    issues.push(...wordy);
    const covered = (a, b) => wordy.some((w) => a < w.end && b > w.start);

    const PASSIVE = /\b(am|is|are|was|were|be|been|being|get|gets|got|gotten)\s+(?:(\p{L}+ly)\s+)?(\p{L}+)\b/giu;
    let m;
    while ((m = PASSIVE.exec(mask))) {
      const p = m[3].toLowerCase();
      if (/ed$/.test(p) || IRREGULAR_PARTICIPLES.has(p)) {
        issues.push({ start: m.index, end: m.index + m[0].length, kind: 'passive', message: 'Passive voice — who’s doing it? Try putting them first' });
      }
      PASSIVE.lastIndex = m.index + m[1].length; // allow overlaps like "is being built"
    }

    const ADVERB = /\b\p{L}+ly\b/giu;
    while ((m = ADVERB.exec(mask))) {
      const w = m[0].toLowerCase();
      if (NOT_ADVERBS.has(w) || covered(m.index, m.index + w.length)) continue;
      issues.push({ start: m.index, end: m.index + w.length, kind: 'adverb', message: 'Adverb — a stronger verb often does the job' });
    }

    issues.sort((a, b) => a.start - b.start || b.end - a.end);
    const grade = list.length && totalWords
      ? Math.max(0, Math.round(0.39 * (totalWords / list.length) + 11.8 * (totalSyllables / totalWords) - 15.59))
      : 0;
    return { grade, sentences: list.length, words: totalWords, issues };
  }

  // Lightweight writing checks. Each issue: { line, column, length, message }.
  function lint(src) {
    const issues = [];
    const fm = frontMatter(src);
    const lines = splitNotes(fm.body).article.replace(/\r\n?/g, '\n').split('\n');
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
    frontMatter, setMeta, status, forPublishing, splitNotes, joinNotes, parseNotes, formatNotes, findCutSpot, diffText, readability, STATUSES, DEFAULT_STATUS,
  };
});
