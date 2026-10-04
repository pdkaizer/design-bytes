/* DB Writer — editor client. */
(() => {
  'use strict';

  const md = window.DBMarkdown;
  const $ = (sel) => document.querySelector(sel);
  const body = document.body;
  const ed = $('#editor');
  const notesEd = $('#notes-editor');

  const el = {
    list: $('#list'),
    search: $('#search'),
    filters: $('#filters'),
    stage: $('#stage'),
    stageSelect: $('#stage-select'),
    preview: $('#preview'),
    previewPane: $('#preview-pane'),
    title: $('#doc-title'),
    file: $('#doc-file'),
    status: $('#status'),
    stats: $('#stats'),
    cursor: $('#cursor'),
    issuesBtn: $('#issues-btn'),
    issues: $('#issues'),
    conflict: $('#conflict'),
    menu: $('#menu'),
    menuBtn: $('#menu-btn'),
    toast: $('#toast'),
    dialog: $('#dialog'),
    filePicker: $('#file-picker'),
  };

  const state = {
    articles: [],
    notes: [], // quick notes
    view: 'articles', // which list the sidebar shows
    doc: null, // { slug, saved, mtime }
    saveTimer: 0,
    saving: null,
    conflict: null,
    issues: [],
    cuts: [], // text moved to notes, with where it came from
  };

  const prefs = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`dbw:${key}`); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`dbw:${key}`, JSON.stringify(value)); } catch { /* private mode */ }
    },
  };

  const enc = encodeURIComponent;
  const isMobile = () => matchMedia('(max-width: 760px)').matches;

  // ---------------------------------------------------------------------------
  // Server

  async function api(method, url, data, file) {
    const opts = { method, headers: {} };
    if (file) {
      opts.body = file;
      opts.headers['Content-Type'] = file.type || 'application/octet-stream';
    } else if (data !== undefined) {
      opts.body = JSON.stringify(data);
      opts.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, data: json });
    return json;
  }

  // ---------------------------------------------------------------------------
  // Article list

  const relTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  function ago(ms) {
    const s = (ms - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, size] of units) if (Math.abs(s) >= size) return relTime.format(Math.round(s / size), unit);
    return 'just now';
  }

  // Two kinds of document: articles (articles/) and quick notes (quick-notes/).
  const KINDS = {
    articles: { folder: 'articles', label: 'Articles', search: 'Search articles', empty: 'No articles yet' },
    notes: { folder: 'quick-notes', label: 'Quick notes', search: 'Search quick notes', empty: 'No quick notes yet' },
  };
  const listOf = (kind) => (kind === 'notes' ? state.notes : state.articles);
  const docUrl = (doc = state.doc) => `/api/${doc.kind}/${enc(doc.slug)}`;
  const hashFor = (kind, slug) => (kind === 'notes' ? `#note/${slug}` : `#${slug}`);
  const isOpen = (kind, slug) => state.doc?.kind === kind && state.doc?.slug === slug;
  function parseHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return null;
    return h.startsWith('note/') ? { kind: 'notes', slug: h.slice(5) } : { kind: 'articles', slug: h };
  }

  // "Oct 4", "Oct 4, 2025" or, with the time, "Oct 4, 7:08 PM"; long: "Sat, Oct 4, 2026".
  function addedLabel(ms, hasTime, long = false) {
    const d = new Date(ms);
    const opts = long
      ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) };
    if (hasTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleString('en-US', opts);
  }

  async function loadList() {
    [state.articles, state.notes] = await Promise.all([api('GET', '/api/articles'), api('GET', '/api/notes')]);
    renderList();
  }

  function setView(view) {
    state.view = view;
    prefs.set('view', view);
    el.search.placeholder = KINDS[view].search;
    el.search.setAttribute('aria-label', KINDS[view].search);
    $('#new').title = view === 'notes' ? 'New quick note' : 'New article';
    renderList();
  }

  $('#view-tabs').addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]')?.dataset.view;
    if (view && view !== state.view) setView(view);
  });

  const STATUS_LABELS = { backlog: 'Backlog', editing: 'Editing', final: 'Final', published: 'Published' };

  function renderFilters() {
    const current = prefs.get('filter', 'all');
    const count = (s) => state.articles.filter((a) => s === 'all' || a.status === s).length;
    el.filters.replaceChildren(...['all', ...md.STATUSES].map((s) => {
      const b = document.createElement('button');
      b.dataset.filter = s;
      if (s !== 'all') b.dataset.status = s;
      b.setAttribute('aria-pressed', String(s === current));
      const label = document.createElement('span');
      label.textContent = s === 'all' ? 'All' : STATUS_LABELS[s];
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = count(s);
      b.append(label, n);
      return b;
    }));
  }

  el.filters.addEventListener('click', (e) => {
    const filter = e.target.closest('[data-filter]')?.dataset.filter;
    if (!filter) return;
    prefs.set('filter', filter);
    renderList();
  });

  function renderList() {
    const view = state.view;
    const notes = view === 'notes';
    document.querySelectorAll('#view-tabs button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.view === view));
      b.querySelector('.count').textContent = listOf(b.dataset.view).length;
    });
    el.filters.hidden = notes;
    if (!notes) renderFilters();
    const q = el.search.value.trim().toLowerCase();
    const filter = notes ? 'all' : prefs.get('filter', 'all');
    const shown = listOf(view).filter((a) =>
      (filter === 'all' || a.status === filter) &&
      (!q || a.title.toLowerCase().includes(q) || a.slug.includes(q) || (a.excerpt || '').toLowerCase().includes(q)));

    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'list-empty';
      li.textContent = q ? 'No matches' : filter !== 'all' ? `Nothing in ${STATUS_LABELS[filter]}` : KINDS[view].empty;
      el.list.replaceChildren(li);
      return;
    }

    el.list.replaceChildren(...shown.map((a) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'item' + (isOpen(view, a.slug) ? ' active' : '');
      btn.dataset.slug = a.slug;
      btn.dataset.kind = view;
      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = a.title;
      const meta = document.createElement('span');
      meta.className = 'item-meta';
      const added = a.created ? addedLabel(a.created, notes && a.createdHasTime) : null; // notes show the time too
      btn.title = [a.created && `Added ${addedLabel(a.created, a.createdHasTime, true)}`, `Last edited ${ago(a.mtime)}`].filter(Boolean).join(' · ');
      if (notes) {
        meta.textContent = `${added || ago(a.mtime)} · ${a.words.toLocaleString()} words`;
      } else {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.dataset.status = a.status;
        badge.textContent = STATUS_LABELS[a.status];
        meta.append(badge, ` · ${a.words.toLocaleString()} words · ${added ? `Added ${added}` : ago(a.mtime)}`);
      }
      btn.append(title, meta);
      li.append(btn);
      return li;
    }));
  }

  // ---------------------------------------------------------------------------
  // Opening & saving

  async function openDoc(kind, slug) {
    if (isOpen(kind, slug)) return;
    await save();
    try {
      load(await api('GET', `/api/${kind}/${enc(slug)}`), kind);
      if (isMobile()) body.classList.remove('show-sidebar');
    } catch (err) {
      toast(`Couldn’t open ${slug}: ${err.message}`);
    }
  }

  // The editor holds the article; the notes panel holds the file's notes block.
  const fileText = () => md.joinNotes(ed.value, md.formatNotes({ text: notesEd.value, cuts: state.cuts }));
  function setFileText(content) {
    const { article, notes } = md.splitNotes(content);
    const parsed = md.parseNotes(notes);
    ed.value = article;
    notesEd.value = parsed.text;
    state.cuts = parsed.cuts;
    renderCuts();
  }

  function load(article, kind = state.doc?.kind || 'articles') {
    closeHistory();
    state.doc = { kind, slug: article.slug, saved: article.content, mtime: article.mtime };
    body.dataset.kind = kind;
    if (state.view !== kind) setView(kind);
    hideConflict();
    setFileText(article.content);
    ed.setSelectionRange(0, 0);
    ed.scrollTop = 0;
    el.previewPane.scrollTop = 0;
    body.classList.remove('empty');
    prefs.set('last', { kind, slug: article.slug });
    history.replaceState(null, '', hashFor(kind, article.slug));
    setStatus('saved');
    refresh(true);
    renderList();
    updateCursor();
  }

  function closeDoc() {
    closeHistory();
    state.doc = null;
    delete body.dataset.kind;
    setFileText('');
    body.classList.add('empty');
    el.title.textContent = 'design bytes';
    el.file.textContent = '';
    document.title = 'DB Writer';
    history.replaceState(null, '', location.pathname);
    renderList();
  }

  const isDirty = () => !!state.doc && fileText() !== state.doc.saved;

  const STATUS = { saved: 'Saved', unsaved: 'Edited', saving: 'Saving…', error: 'Not saved', conflict: 'Conflict' };
  function setStatus(s) {
    el.status.dataset.state = s;
    el.status.textContent = STATUS[s];
  }

  function scheduleSave() {
    if (!state.doc) return;
    setStatus(isDirty() ? 'unsaved' : 'saved');
    clearTimeout(state.saveTimer);
    if (!state.conflict) state.saveTimer = setTimeout(save, 700);
  }

  async function save(force = false) {
    clearTimeout(state.saveTimer);
    while (state.saving) await state.saving;
    const doc = state.doc;
    if (!doc || (!force && (state.conflict || !isDirty()))) return;

    const content = fileText();
    setStatus('saving');
    state.saving = (async () => {
      try {
        const r = await api('PUT', docUrl(doc), { content, mtime: force ? null : doc.mtime });
        doc.saved = content;
        doc.mtime = r.mtime;
        const entry = listOf(doc.kind).find((a) => a.slug === doc.slug);
        if (entry) entry.mtime = r.mtime;
        if (state.doc === doc) setStatus(isDirty() ? 'unsaved' : 'saved');
      } catch (err) {
        if (err.status === 409 && state.doc === doc) showConflict(err.data);
        else {
          setStatus('error');
          toast(`Couldn’t save: ${err.message}`);
        }
      } finally {
        state.saving = null;
      }
    })();
    return state.saving;
  }

  function showConflict(disk) {
    state.conflict = disk;
    el.conflict.hidden = false;
    setStatus('conflict');
  }

  function hideConflict() {
    state.conflict = null;
    el.conflict.hidden = true;
  }

  el.conflict.addEventListener('click', async (e) => {
    const choice = e.target.closest('[data-conflict]')?.dataset.conflict;
    if (!choice || !state.conflict) return;
    if (choice === 'disk') {
      load(state.conflict);
      toast('Loaded the version on disk.');
    } else {
      hideConflict();
      await save(true);
    }
  });

  // Pick up edits made outside the writer (VS Code, git) when the window regains focus.
  async function checkDisk() {
    loadList().catch(() => {});
    const doc = state.doc;
    if (!doc || state.conflict || state.saving) return;
    try {
      const a = await api('GET', docUrl(doc));
      if (state.doc !== doc || Math.abs(a.mtime - doc.mtime) < 1) return;
      if (a.content === doc.saved) { doc.mtime = a.mtime; return; }
      if (isDirty()) { showConflict(a); return; }
      const { selectionStart, selectionEnd, scrollTop } = ed;
      setFileText(a.content);
      doc.saved = a.content;
      doc.mtime = a.mtime;
      ed.setSelectionRange(selectionStart, selectionEnd);
      ed.scrollTop = scrollTop;
      refresh(true);
      toast('Reloaded — the file changed on disk.');
    } catch (err) {
      if (err.status === 404) toast('This article is no longer on disk. Keep typing to save it again.');
    }
  }

  // ---------------------------------------------------------------------------
  // Preview, stats, checks

  let frame = 0;
  function refresh(now = false) {
    cancelAnimationFrame(frame);
    const run = () => {
      if (!state.doc) return;
      const text = ed.value;
      if (body.dataset.mode !== 'write' || now) el.preview.innerHTML = md.render(text);

      const isNote = state.doc.kind === 'notes';
      const title = isNote ? (md.displayTitle(text) || 'Untitled note') : (md.title(text) || state.doc.slug);
      el.title.textContent = title;
      const added = md.created(text);
      el.file.textContent = `${KINDS[state.doc.kind].folder}/${state.doc.slug}.md` +
        (added ? ` · Added ${addedLabel(added.ms, added.hasTime, true)}` : '');
      document.title = `${title} · DB Writer`;

      const s = md.stats(text);
      el.stats.textContent = `${s.words.toLocaleString()} words · ${s.minutes} min read`;

      renderReadability();
      state.issues = md.lint(text);
      el.issuesBtn.hidden = !state.issues.length;
      el.issuesBtn.textContent = `${state.issues.length} ${state.issues.length === 1 ? 'suggestion' : 'suggestions'}`;
      if (!el.issues.hidden) renderIssues();

      const status = isNote ? undefined : md.status(text);
      if (!isNote) {
        el.stageSelect.value = status;
        el.stage.dataset.status = status;
      }
      body.dataset.status = status || '';

      const entry = listOf(state.doc.kind).find((a) => a.slug === state.doc.slug);
      const createdMs = added ? added.ms : null;
      if (entry && (entry.title !== title || entry.words !== s.words || entry.status !== status || entry.created !== createdMs)) {
        entry.title = title;
        entry.words = s.words;
        entry.status = status;
        entry.created = createdMs;
        entry.createdHasTime = !!added?.hasTime;
        renderList();
      }
    };
    if (now) run(); else frame = requestAnimationFrame(run);
  }

  function renderIssues() {
    if (!state.issues.length) { el.issues.hidden = true; return; }
    el.issues.replaceChildren(...state.issues.map((issue) => {
      const b = document.createElement('button');
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = `Ln ${issue.line}`;
      const msg = document.createElement('span');
      msg.textContent = issue.message;
      b.append(ln, msg);
      b.addEventListener('click', () => {
        el.issues.hidden = true;
        goTo(issue.line, issue.column, issue.length);
      });
      return b;
    }));
  }

  el.issuesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.issues.hidden = !el.issues.hidden;
    if (!el.issues.hidden) renderIssues();
  });

  function updateCursor() {
    const before = ed.value.slice(0, ed.selectionStart);
    const line = before.split('\n').length;
    const col = ed.selectionStart - before.lastIndexOf('\n');
    const selected = ed.selectionEnd - ed.selectionStart;
    el.cursor.textContent = `Ln ${line}, Col ${col}` + (selected ? ` · ${selected} selected` : '');
  }

  // Measure where a character sits inside the textarea (for scrolling to it).
  const mirror = document.createElement('div');
  function caretOffset(pos) {
    const cs = getComputedStyle(ed);
    mirror.style.cssText = `position:absolute;visibility:hidden;top:0;left:-9999px;white-space:pre-wrap;` +
      `overflow-wrap:break-word;box-sizing:border-box;width:${ed.clientWidth}px;font:${cs.font};` +
      `letter-spacing:${cs.letterSpacing};padding:${cs.padding};tab-size:${cs.tabSize};`;
    mirror.textContent = ed.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    mirror.append(mark);
    document.body.append(mirror);
    const offset = { top: mark.offsetTop, left: mark.offsetLeft, height: mark.offsetHeight };
    mirror.remove();
    return offset;
  }

  const caretTop = (pos) => caretOffset(pos).top;

  // Where a character sits on screen, in viewport coordinates.
  function caretPoint(pos) {
    const o = caretOffset(pos);
    const r = ed.getBoundingClientRect();
    return { x: r.left + o.left - ed.scrollLeft, y: r.top + o.top - ed.scrollTop, height: o.height };
  }

  function goTo(line, column = 1, length = 0) {
    const lines = ed.value.split('\n');
    let pos = 0;
    for (let k = 0; k < line - 1 && k < lines.length; k++) pos += lines[k].length + 1;
    const start = pos + column - 1;
    ed.focus();
    ed.setSelectionRange(start, start + length);
    ed.scrollTop = Math.max(0, caretTop(start) - ed.clientHeight / 3);
  }

  // ---------------------------------------------------------------------------
  // Editing commands (all go through execCommand so native undo keeps working)

  function replaceRange(start, end, text, selStart = start + text.length, selEnd = selStart) {
    ed.focus();
    ed.setSelectionRange(start, end);
    if (text || start !== end) {
      const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
      if (!ok) {
        ed.setRangeText(text, start, end, 'end');
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    ed.setSelectionRange(selStart, selEnd);
  }

  function wrap(before, after, placeholder) {
    const { selectionStart: s, selectionEnd: e, value: v } = ed;
    const sel = v.slice(s, e);
    if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
      replaceRange(s - before.length, e + after.length, sel, s - before.length, e - before.length);
    } else if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
      const inner = sel.slice(before.length, sel.length - after.length);
      replaceRange(s, e, inner, s, s + inner.length);
    } else {
      const inner = sel || placeholder;
      replaceRange(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
    }
  }

  function lineRange() {
    const v = ed.value;
    const s = ed.selectionStart;
    let e = ed.selectionEnd;
    if (e > s && v[e - 1] === '\n') e--;
    const start = v.lastIndexOf('\n', s - 1) + 1;
    const nl = v.indexOf('\n', e);
    return { start, end: nl === -1 ? v.length : nl };
  }

  function transformLines(fn) {
    const hadSelection = ed.selectionStart !== ed.selectionEnd;
    const { start, end } = lineRange();
    const next = fn(ed.value.slice(start, end).split('\n')).join('\n');
    if (hadSelection) replaceRange(start, end, next, start, start + next.length);
    else replaceRange(start, end, next);
  }

  const MARKER = /^(\s*)(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/;

  function toggleLines(pattern, add, { stripMarkers = true } = {}) {
    transformLines((lines) => {
      const filled = lines.filter((l) => l.trim());
      const remove = filled.length > 0 && filled.every((l) => pattern.test(l));
      let n = 0;
      return lines.map((l) => {
        if (!l.trim()) return l;
        if (remove) return l.replace(pattern, '$1');
        const indent = l.match(/^\s*/)[0];
        const text = stripMarkers ? l.replace(MARKER, '').trimStart() : l.trimStart();
        return indent + add(text, ++n);
      });
    });
  }

  function heading(level) {
    const hashes = '#'.repeat(level);
    toggleLines(new RegExp(`^()${hashes}[ \\t]+`), (t) => `${hashes} ${t.replace(/^#{1,6}[ \t]+/, '')}`);
  }

  function insertBlock(text) {
    const { selectionStart: s, selectionEnd: e, value: v } = ed;
    const before = v.slice(0, s);
    const after = v.slice(e);
    const pre = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const post = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    replaceRange(s, e, pre + text + post, s + pre.length + text.length);
  }

  function insertLink() {
    const { selectionStart: s, selectionEnd: e, value: v } = ed;
    const sel = v.slice(s, e);
    if (/^https?:\/\/\S+$/.test(sel)) {
      replaceRange(s, e, `[](${sel})`, s + 1);
      return;
    }
    const text = sel || 'link text';
    const url = 'https://';
    const urlStart = s + text.length + 3;
    if (sel) replaceRange(s, e, `[${text}](${url})`, urlStart + url.length);
    else replaceRange(s, e, `[${text}](${url})`, s + 1, s + 1 + text.length);
  }

  function inlineCode() {
    const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
    if (sel.includes('\n')) insertBlock('```\n' + sel.replace(/\n$/, '') + '\n```');
    else wrap('`', '`', 'code');
  }

  const FONTS = ['mono', 'sans', 'serif'];
  function setFont(font) {
    body.classList.remove('font-sans', 'font-serif');
    if (font !== 'mono') body.classList.add(`font-${font}`);
    $('#font-btn').title = `Editor font: ${font}`;
    prefs.set('font', font);
    if (typeof renderReadability === 'function') renderReadability();
  }

  const commands = {
    h2: () => heading(2),
    h3: () => heading(3),
    bold: () => wrap('**', '**', 'bold text'),
    italic: () => wrap('_', '_', 'italic text'),
    strike: () => wrap('~~', '~~', 'text'),
    code: inlineCode,
    link: insertLink,
    image: () => el.filePicker.click(),
    quote: () => toggleLines(/^(\s*)>[ \t]?/, (t) => `> ${t}`, { stripMarkers: false }),
    ul: () => toggleLines(/^(\s*)[-*+][ \t]+(?!\[[ xX]\])/, (t) => `- ${t}`),
    ol: () => toggleLines(/^(\s*)\d+[.)][ \t]+/, (t, n) => `${n}. ${t}`),
    task: () => toggleLines(/^(\s*)[-*+][ \t]+\[[ xX]\][ \t]+/, (t) => `- [ ] ${t}`),
    hr: () => insertBlock('---'),
    suggest: () => openSuggest(),
    tonotes: () => moveToNotes(),
    font: () => setFont(FONTS[(FONTS.indexOf(prefs.get('font', 'mono')) + 1) % FONTS.length]),
  };

  $('.toolbar').addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-cmd]')) e.preventDefault(); // keep the editor's selection
  });
  $('.toolbar').addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
    if (cmd && state.doc) commands[cmd]();
  });

  // Continue lists and quotes on Enter; end them on an empty item.
  function handleEnter(e) {
    const { selectionStart: s, selectionEnd: end, value: v } = ed;
    if (s !== end) return;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const line = v.slice(lineStart, s);
    const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/) || line.match(/^(\s*)(>)([ \t]?)/);
    if (!m) return;
    e.preventDefault();
    if (line.length === m[0].length) {
      replaceRange(lineStart, s, ''); // empty item → leave the list
      return;
    }
    let marker;
    if (m[2] === '>') marker = `${m[1]}> `;
    else if (m[3]) marker = `${m[1]}${Number(m[3]) + 1}${m[4]}${m[5]}`;
    else marker = `${m[1]}${m[2]}${m[5]}${m[6] ? '[ ] ' : ''}`;
    replaceRange(s, s, `\n${marker}`);
  }

  // Tab / Shift-Tab indent list items.
  function handleTab(e) {
    const { start, end } = lineRange();
    const lines = ed.value.slice(start, end).split('\n');
    if (!lines.some((l) => MARKER.test(l))) return;
    e.preventDefault();
    const s = ed.selectionStart;
    const next = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n');
    const delta = e.shiftKey ? Math.max(-2, -(lines[0].match(/^ */)[0].length)) : 2;
    replaceRange(start, end, next, Math.max(start, s + delta));
  }

  ed.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) return handleEnter(e);
    if (e.key === 'Tab' && !mod && !e.altKey) return handleTab(e);
    if (!mod || !state.doc) return;

    const key = e.key.toLowerCase();
    let cmd = null;
    if (e.altKey && e.code === 'Digit2') cmd = 'h2';
    else if (e.altKey && e.code === 'Digit3') cmd = 'h3';
    else if (e.shiftKey && e.code === 'Digit7') cmd = 'ol';
    else if (e.shiftKey && e.code === 'Digit8') cmd = 'ul';
    else if (e.shiftKey && e.code === 'Digit9') cmd = 'task';
    else if (e.shiftKey && e.code === 'Period') cmd = 'quote';
    else if (e.shiftKey && key === 'x') cmd = 'strike';
    else if (!e.shiftKey && !e.altKey) cmd = { b: 'bold', i: 'italic', k: 'link', e: 'code', j: 'suggest' }[key] || null;
    if (cmd) {
      e.preventDefault();
      commands[cmd]();
    }
  });

  ed.addEventListener('input', () => {
    if (!state.doc) return;
    refresh();
    scheduleSave();
  });

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === ed) updateCursor();
  });

  // Keep the preview roughly in step with the editor.
  ed.addEventListener('scroll', () => {
    if (body.dataset.mode !== 'split') return;
    const max = ed.scrollHeight - ed.clientHeight;
    const ratio = max > 0 ? ed.scrollTop / max : 0;
    el.previewPane.scrollTop = ratio * (el.previewPane.scrollHeight - el.previewPane.clientHeight);
  });

  // ---------------------------------------------------------------------------
  // Article status — stored as `status:` in the file's front matter

  function setArticleStatus(value) {
    const text = ed.value;
    const next = md.setMeta(text, 'status', value);
    if (next === text) return;
    // Only replace the changed head of the file, so undo and the caret stay sensible.
    let same = 0;
    while (same < text.length && same < next.length && text[text.length - 1 - same] === next[next.length - 1 - same]) same++;
    const delta = next.length - text.length;
    const { selectionStart, selectionEnd, scrollTop } = ed;
    const headEnd = text.length - same;
    replaceRange(0, headEnd, next.slice(0, next.length - same));
    const shift = (pos) => (pos >= headEnd ? pos + delta : Math.min(pos, next.length - same));
    ed.setSelectionRange(shift(selectionStart), shift(selectionEnd));
    ed.scrollTop = scrollTop;
    toast(`Marked as ${STATUS_LABELS[value]}`);
  }

  el.stageSelect.addEventListener('change', () => {
    if (state.doc) setArticleStatus(el.stageSelect.value);
  });

  // ---------------------------------------------------------------------------
  // Suggested alternatives — highlight text, then click the chip or press ⌘J

  const sug = {
    chip: $('#selection-chip'),
    panel: $('#suggest'),
    list: $('#suggest-list'),
    quote: $('#suggest-quote'),
    range: null, // { start, end, text } being reworded
    request: 0,
  };
  const MAX_SUGGEST = 1500;

  // The current selection, trimmed of surrounding whitespace.
  function selectedRange() {
    const v = ed.value;
    let s = ed.selectionStart;
    let e = ed.selectionEnd;
    while (s < e && /\s/.test(v[s])) s++;
    while (e > s && /\s/.test(v[e - 1])) e--;
    return e > s ? { start: s, end: e, text: v.slice(s, e) } : null;
  }

  function placeBelow(node, pos, gap = 6) {
    const p = caretPoint(pos);
    const r = ed.getBoundingClientRect();
    node.style.visibility = 'hidden';
    node.hidden = false;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let x = Math.min(Math.max(8, p.x - 12), window.innerWidth - w - 8);
    let y = p.y + p.height + gap;
    if (y + h > window.innerHeight - 8) y = Math.max(8, p.y - h - gap); // flip above
    const visible = p.y >= r.top - p.height && p.y <= r.bottom;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.visibility = '';
    return visible;
  }

  let chipFrame = 0;
  function updateChip() {
    cancelAnimationFrame(chipFrame);
    chipFrame = requestAnimationFrame(() => {
      const range = document.activeElement === ed && state.doc && sug.panel.hidden ? selectedRange() : null;
      if (!range) { sug.chip.hidden = true; return; }
      $('#chip-suggest').hidden = range.text.length > MAX_SUGGEST;
      if (!placeBelow(sug.chip, ed.selectionEnd)) sug.chip.hidden = true;
    });
  }

  function paragraphAround(start, end) {
    const v = ed.value;
    const from = v.lastIndexOf('\n\n', start - 1);
    const to = v.indexOf('\n\n', end);
    return {
      before: v.slice(from === -1 ? md.frontMatter(v).end : from + 2, start),
      after: v.slice(end, to === -1 ? v.length : to),
    };
  }

  async function openSuggest() {
    if (!state.doc) return;
    const range = selectedRange();
    if (!range) { toast('Highlight a word, phrase or sentence first'); return; }
    if (range.text.length > MAX_SUGGEST) { toast('That’s a lot of text — highlight a sentence or two at most'); return; }

    sug.range = range;
    sug.chip.hidden = true;
    sug.quote.textContent = range.text.length > 140 ? `${range.text.slice(0, 140)}…` : range.text;
    showSuggestState('loading');
    placeBelow(sug.panel, range.end, 8);

    const id = ++sug.request;
    try {
      const r = await api('POST', '/api/suggest', {
        selection: range.text,
        ...paragraphAround(range.start, range.end),
        title: md.title(ed.value),
      });
      if (id !== sug.request || sug.panel.hidden) return;
      if (!r.suggestions.length) showSuggestState('error', 'No alternatives came back — try again.');
      else renderSuggestions(r.suggestions);
    } catch (err) {
      if (id === sug.request && !sug.panel.hidden) showSuggestState('error', err.message);
    }
    if (!sug.panel.hidden) placeBelow(sug.panel, range.end, 8);
  }

  function showSuggestState(kind, message = '') {
    const p = document.createElement('p');
    p.className = `suggest-${kind}`;
    p.textContent = kind === 'loading' ? 'Finding alternatives…' : message;
    sug.list.replaceChildren(p);
    sug.panel.dataset.state = kind;
  }

  function renderSuggestions(items) {
    sug.panel.dataset.state = 'ready';
    sug.list.replaceChildren(...items.slice(0, 9).map((item, i) => {
      const b = document.createElement('button');
      b.className = 'suggestion';
      b.setAttribute('role', 'option');
      const key = document.createElement('kbd');
      key.textContent = i + 1;
      const text = document.createElement('span');
      text.className = 'suggestion-text';
      text.textContent = item.text;
      const note = document.createElement('span');
      note.className = 'suggestion-note';
      note.textContent = item.note;
      b.append(key, text, note);
      b.addEventListener('click', () => applySuggestion(item.text));
      return b;
    }));
  }

  function applySuggestion(text) {
    const range = sug.range;
    closeSuggest();
    if (!range) return;
    let { start, end } = range;
    // The text may have shifted if the article was edited meanwhile; find it again.
    if (ed.value.slice(start, end) !== range.text) {
      const near = ed.value.indexOf(range.text, Math.max(0, start - 200));
      const at = near > -1 ? near : ed.value.indexOf(range.text);
      if (at === -1) { toast('The highlighted text changed — highlight it again'); return; }
      start = at;
      end = at + range.text.length;
    }
    replaceRange(start, end, text, start, start + text.length);
    toast('Replaced — ⌘Z to undo');
  }

  function closeSuggest() {
    sug.panel.hidden = true;
    sug.request++;
  }

  sug.chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  $('#chip-suggest').addEventListener('click', openSuggest);
  $('#chip-notes').addEventListener('click', () => moveToNotes());
  $('#suggest-retry').addEventListener('click', () => {
    if (!sug.range) return;
    ed.setSelectionRange(sug.range.start, sug.range.end);
    openSuggest();
  });
  sug.panel.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  document.addEventListener('selectionchange', updateChip);
  ed.addEventListener('scroll', () => { sug.chip.hidden = true; if (!sug.panel.hidden) closeSuggest(); });
  ed.addEventListener('input', () => { sug.chip.hidden = true; });
  ed.addEventListener('blur', () => { sug.chip.hidden = true; });
  window.addEventListener('resize', () => { sug.chip.hidden = true; closeSuggest(); });
  document.addEventListener('mousedown', (e) => {
    if (!sug.panel.hidden && !e.target.closest('#suggest')) closeSuggest();
  });
  document.addEventListener('keydown', (e) => {
    if (sug.panel.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key) && sug.panel.dataset.state === 'ready') {
      const pick = sug.list.querySelectorAll('.suggestion')[Number(e.key) - 1];
      if (pick) { e.preventDefault(); pick.click(); }
    } else if (e.key !== 'Escape' && e.key !== 'Shift' && e.key !== 'Tab') {
      closeSuggest(); // typing carries on as normal
    }
  }, true);

  // ---------------------------------------------------------------------------
  // Notes — a private area saved at the end of the article file, never published

  function updateNotesCount() {
    const all = [notesEd.value, ...state.cuts.map((c) => c.text)].join('\n\n');
    const words = md.stats(all).words;
    const text = all.trim() ? `${words.toLocaleString()} word${words === 1 ? '' : 's'}` : '';
    $('#notes-count').textContent = text ? `· ${text}` : '';
    $('#notes-btn span').textContent = text ? `Notes · ${text}` : 'Notes';
  }

  const notesOpen = () => body.classList.contains('notes-open');
  function toggleNotes(open = !notesOpen()) {
    body.classList.toggle('notes-open', open);
    $('#notes').inert = !open;
    if (!open) hideCutSpot();
    $('#notes-btn').setAttribute('aria-pressed', String(open));
    $('#notes-btn').title = `${open ? 'Hide' : 'Show'} notes (⌥⌘N)`;
    prefs.set('notes', open);
    if (open && state.doc) notesEd.focus();
    else if (state.doc) ed.focus();
  }

  function moveToNotes() {
    if (!state.doc) return;
    const range = selectedRange();
    if (!range) { toast('Highlight the text you want to move to notes'); return; }

    const v = ed.value;
    let { start, end } = range;
    const atLineStart = start === 0 || v[start - 1] === '\n';
    const atLineEnd = end === v.length || v[end] === '\n';
    if (atLineStart && atLineEnd) {
      // A whole paragraph or line: take the blank line after it too.
      end += v.slice(end, end + 2) === '\n\n' ? 2 : v[end] === '\n' ? 1 : 0;
    } else if (v[start - 1] === ' ' && /^[\s.,;:!?)\]”’]?$/.test(v[end] || '')) {
      start -= 1; // mid-sentence: don't leave a double space behind
    } else if (atLineStart && v[end] === ' ') {
      end += 1;
    }
    // Remember the words around it, so it can be put back in the same place.
    state.cuts.push({
      text: range.text,
      before: v.slice(Math.max(0, start - 80), start),
      after: v.slice(end, end + 80),
      lead: v.slice(start, range.start),
      trail: v.slice(range.end, end),
    });
    renderCuts(true);
    replaceRange(start, end, '', start); // fires input → autosave
    ed.focus();
    toast(notesOpen() ? 'Moved to notes' : 'Moved to notes — ⌥⌘N to show them');
  }

  // Context shown on a card: the last few words before where the text was.
  function cutOrigin(cut) {
    const words = cut.before
      .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, '$1') // links → their text
      .replace(/[*_`#>~]|^---$|^status:.*$/gm, '')
      .replace(/\s+/g, ' ').trim().split(' ');
    if (!words[0]) return 'from the start of the article';
    return `after “…${words.slice(-6).join(' ')}”`;
  }

  function renderCuts(flashNewest = false) {
    const list = $('#cuts');
    list.hidden = !state.cuts.length;
    list.replaceChildren(...state.cuts.map((cut, i) => {
      const card = document.createElement('div');
      card.className = 'cut';
      const text = document.createElement('p');
      text.className = 'cut-text';
      text.textContent = cut.text;
      text.title = cut.text;
      const meta = document.createElement('div');
      meta.className = 'cut-meta';
      const origin = document.createElement('span');
      origin.textContent = cutOrigin(cut);
      origin.title = origin.textContent;
      const putBack = document.createElement('button');
      putBack.className = 'btn';
      putBack.textContent = 'Put back';
      putBack.title = 'Reinsert this where it was removed';
      putBack.addEventListener('click', () => restoreCut(i));
      const del = document.createElement('button');
      del.className = 'cut-delete';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        if (del.dataset.armed) { state.cuts.splice(i, 1); renderCuts(); scheduleSave(); return; }
        del.dataset.armed = '1';
        del.textContent = 'Delete?';
        setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 2500);
      });
      meta.append(origin, putBack, del);
      card.append(text, meta);
      card.addEventListener('mouseenter', () => showCutSpot(cut, origin));
      card.addEventListener('focusin', () => showCutSpot(cut, origin));
      card.addEventListener('mouseleave', hideCutSpot);
      card.addEventListener('focusout', hideCutSpot);
      return card;
    }));
    if (flashNewest && list.lastElementChild) {
      list.lastElementChild.classList.add('flash');
      list.lastElementChild.scrollIntoView({ block: 'nearest' });
    }
    updateNotesCount();
  }

  // Show where a card's text would go back, scrolling the editor there if needed.
  const marker = $('#cut-marker');
  function showCutSpot(cut, origin) {
    const at = md.findCutSpot(ed.value, cut);
    if (at < 0) {
      origin.textContent = 'Original spot not found — Put back inserts at the cursor';
      hideCutSpot();
      return;
    }
    origin.textContent = cutOrigin(cut);
    if (body.dataset.mode === 'preview' && !body.classList.contains('focus')) { hideCutSpot(); return; }
    const top = caretTop(at);
    if (top < ed.scrollTop + 48 || top > ed.scrollTop + ed.clientHeight - 64) {
      ed.scrollTop = Math.max(0, top - ed.clientHeight / 3);
    }
    const p = caretPoint(at);
    marker.style.left = `${p.x - 1}px`;
    marker.style.top = `${p.y}px`;
    marker.style.height = `${p.height}px`;
    marker.hidden = false;
  }
  function hideCutSpot() { marker.hidden = true; }

  function restoreCut(i) {
    hideCutSpot();
    const cut = state.cuts[i];
    if (!cut) return;
    let at = md.findCutSpot(ed.value, cut);
    const found = at > -1;
    if (!found) at = ed.selectionStart; // the surrounding text changed too much
    state.cuts.splice(i, 1);
    renderCuts();
    const piece = cut.lead + cut.text + cut.trail;
    replaceRange(at, at, piece, at + cut.lead.length, at + cut.lead.length + cut.text.length);
    ed.scrollTop = Math.max(0, caretTop(at) - ed.clientHeight / 3);
    toast(found ? 'Put back where it was' : 'Couldn’t find its original spot, so it went in at the cursor');
  }

  notesEd.addEventListener('input', () => {
    if (!state.doc) return;
    updateNotesCount();
    scheduleSave();
  });
  $('#notes-btn').addEventListener('click', () => toggleNotes());
  $('#notes-close').addEventListener('click', () => toggleNotes(false));

  // ---------------------------------------------------------------------------
  // Version history — kept by the server in articles/.history/<slug>/

  const hist = { items: [], selected: null, content: '', tab: 'changes', expanded: new Set() };
  const historyOpen = () => !$('#history').hidden;
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const fullFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function dayLabel(ms) {
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return dayFmt.format(d);
  }

  async function openHistory(selectId) {
    if (!state.doc) return;
    await save();
    closeSuggest();
    $('#history').hidden = false;
    body.classList.add('history-open');
    $('#history-btn').setAttribute('aria-pressed', 'true');
    await loadVersions(selectId);
  }

  function closeHistory() {
    if (!historyOpen()) return;
    $('#history').hidden = true;
    body.classList.remove('history-open');
    $('#history-btn').setAttribute('aria-pressed', 'false');
    if (state.doc) ed.focus();
  }

  async function loadVersions(selectId) {
    const slug = state.doc.slug;
    try {
      hist.items = await api('GET', `${docUrl()}/history`);
    } catch (err) {
      hist.items = [];
      toast(`Couldn’t load history: ${err.message}`);
    }
    if (state.doc?.slug !== slug) return;
    renderVersions();
    const pick = hist.items.find((v) => v.id === selectId) || hist.items[0];
    if (pick) selectVersion(pick.id);
    else showNoVersions();
  }

  function renderVersions() {
    const nodes = [];
    let lastDay = '';
    for (const v of hist.items) {
      const day = dayLabel(v.time);
      if (day !== lastDay) {
        const h = document.createElement('div');
        h.className = 'history-day';
        h.textContent = day;
        nodes.push(h);
        lastDay = day;
      }
      const b = document.createElement('button');
      b.className = 'version';
      b.dataset.id = v.id;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(v.id === hist.selected));
      const time = document.createElement('span');
      time.className = 'version-time';
      time.textContent = timeFmt.format(v.time);
      b.append(time);
      if (v.label) {
        const label = document.createElement('span');
        label.className = 'version-label';
        label.textContent = v.label;
        b.append(label);
      }
      const meta = document.createElement('span');
      meta.className = 'version-meta';
      meta.textContent = `${v.words.toLocaleString()} words`;
      b.append(meta);
      nodes.push(b);
    }
    $('#history-list').replaceChildren(...nodes);
  }

  function showNoVersions() {
    hist.selected = null;
    hist.content = '';
    const p = document.createElement('p');
    p.className = 'history-empty';
    p.textContent = 'No earlier versions yet. While you edit, the writer keeps a version every few minutes — and you can save a named one any time.';
    $('#history-list').replaceChildren(p);
    $('#history-title').textContent = 'Current text';
    $('#history-sub').textContent = '';
    $('#history-legend').textContent = '';
    $('#history-body').replaceChildren();
    $('#history-restore').disabled = true;
    $('#history-copy').disabled = true;
  }

  async function selectVersion(id) {
    const v = hist.items.find((x) => x.id === id);
    if (!v) return;
    hist.selected = id;
    hist.expanded.clear();
    document.querySelectorAll('.version').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
    $('#history-title').textContent = fullFmt.format(v.time);
    $('#history-sub').textContent = [v.label && `“${v.label}”`, `${v.words.toLocaleString()} words`, ago(v.time)].filter(Boolean).join(' · ');
    $('#history-restore').disabled = false;
    $('#history-copy').disabled = false;
    try {
      const r = await api('GET', `${docUrl()}/history/${enc(id)}`);
      if (hist.selected !== id) return;
      hist.content = r.content;
      renderVersion();
    } catch (err) {
      toast(`Couldn’t open that version: ${err.message}`);
    }
  }

  function diffParagraph(block) {
    const p = document.createElement('p');
    if (block.type === 'change') {
      for (const part of block.parts) {
        if (part.type === 'same') { p.append(part.text); continue; }
        const mark = document.createElement(part.type === 'add' ? 'ins' : 'del');
        mark.textContent = part.text;
        p.append(mark);
      }
    } else {
      if (block.type !== 'same') p.className = `d-${block.type}`;
      p.textContent = block.text;
    }
    return p;
  }

  function renderVersion() {
    const view = $('#history-body');
    const legend = $('#history-legend');
    document.querySelectorAll('#history-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === hist.tab)));

    if (hist.tab === 'preview') {
      legend.textContent = '';
      const article = document.createElement('article');
      article.className = 'article';
      article.innerHTML = md.render(hist.content);
      view.replaceChildren(article);
      return;
    }

    const blocks = md.diffText(hist.content, fileText());
    if (!blocks.some((b) => b.type !== 'same')) {
      legend.textContent = '';
      const same = document.createElement('p');
      same.className = 'diff-same-note';
      same.textContent = 'This version is identical to your current text.';
      view.replaceChildren(same);
      return;
    }
    legend.innerHTML = 'Compared with your current text: <ins>added since</ins> · <del>removed since</del>';

    // Collapse long unchanged stretches, keeping a paragraph of context around each change.
    const diff = document.createElement('div');
    diff.className = 'diff';
    for (let k = 0; k < blocks.length;) {
      if (blocks[k].type !== 'same') { diff.append(diffParagraph(blocks[k])); k++; continue; }
      let j = k;
      while (j < blocks.length && blocks[j].type === 'same') j++;
      const run = blocks.slice(k, j);
      const keepStart = k === 0 ? 0 : 1;
      const keepEnd = j === blocks.length ? 0 : 1;
      const hidden = run.length - keepStart - keepEnd;
      if (hidden > 1 && !hist.expanded.has(k)) {
        run.slice(0, keepStart).forEach((b) => diff.append(diffParagraph(b)));
        const skip = document.createElement('button');
        skip.className = 'diff-skip';
        skip.textContent = `⋯ ${hidden} unchanged paragraphs`;
        const at = k;
        skip.addEventListener('click', () => {
          const top = view.scrollTop;
          hist.expanded.add(at);
          renderVersion();
          view.scrollTop = top;
        });
        diff.append(skip);
        run.slice(run.length - keepEnd).forEach((b) => diff.append(diffParagraph(b)));
      } else {
        run.forEach((b) => diff.append(diffParagraph(b)));
      }
      k = j;
    }
    view.replaceChildren(diff);
  }

  async function restoreVersion() {
    const v = hist.items.find((x) => x.id === hist.selected);
    if (!v || !state.doc) return;
    if (hist.content === fileText()) { toast('That version is the same as your current text'); return; }
    const when = `${dayLabel(v.time).toLowerCase()}, ${timeFmt.format(v.time)}`;
    const safety = `Before restoring ${when}`;
    try {
      // Keep the current text first, so restoring can itself be undone.
      await save();
      await api('POST', `${docUrl()}/history`, { label: safety });
    } catch (err) {
      toast(`Couldn’t save your current text first, so nothing was restored: ${err.message}`);
      return;
    }
    setFileText(hist.content);
    refresh(true);
    await save();
    closeHistory();
    toast(`Restored the version from ${when}. Your previous text is in history as “${safety}”.`);
  }

  async function saveNamedVersion() {
    const label = await ask({
      title: 'Save a named version', label: 'Name', placeholder: 'e.g. Before restructuring', confirm: 'Save',
      hint: 'Named versions are kept for good; automatic ones thin out over time.',
    });
    if (!label || !state.doc) return;
    try {
      await save();
      const r = await api('POST', `${docUrl()}/history`, { label });
      if (historyOpen()) await loadVersions(r.id);
      toast(`Saved version “${label}”`);
    } catch (err) {
      toast(`Couldn’t save the version: ${err.message}`);
    }
  }

  $('#history-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id) selectVersion(id);
  });
  $('#history-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (!tab || !hist.selected) return;
    hist.tab = tab;
    renderVersion();
  });
  $('#history-restore').addEventListener('click', restoreVersion);
  $('#history-copy').addEventListener('click', async () => {
    toast(await copyText(hist.content) ? 'Copied this version’s text' : 'Clipboard not available');
  });
  $('#history-save').addEventListener('click', saveNamedVersion);
  $('#history-close').addEventListener('click', closeHistory);
  $('#history-btn').addEventListener('click', () => (historyOpen() ? closeHistory() : openHistory()));

  // ---------------------------------------------------------------------------
  // Readability highlights — drawn on a layer behind the transparent textarea

  const READ_CATS = [
    { kind: 'very-long', name: 'Very long sentences (35+ words)', swatch: 'background: var(--r-very)' },
    { kind: 'long', name: 'Long sentences (25+ words)', swatch: 'background: var(--r-long)' },
    { kind: 'passive', name: 'Passive voice', swatch: 'border-color: var(--r-passive)', line: true },
    { kind: 'adverb', name: 'Adverbs', swatch: 'border-color: var(--r-adverb)', line: true },
    { kind: 'wordy', name: 'Wordy phrases & filler', swatch: 'border-color: var(--r-wordy)', line: true },
  ];
  const read = {
    backdrop: $('#read-backdrop'),
    layer: $('#read-layer'),
    on: prefs.get('readability', false),
    off: new Set(prefs.get('readability-off', [])), // categories switched off
    result: null,
  };

  const GRADE_WORDS = [[6, 'Very easy to read'], [8, 'Easy to read'], [10, 'Plain English — good for most readers'],
    [12, 'Fairly hard — fine for an essay'], [Infinity, 'Hard to read — consider shorter sentences']];

  function renderReadability() {
    const showing = read.on && state.doc && !(body.dataset.mode === 'preview' && !body.classList.contains('focus'));
    if (!state.doc) { read.result = null; return; }
    if (!read.on && $('#read-panel').hidden) { read.backdrop.hidden = true; updateReadPanel(); return; } // nothing to show
    const text = ed.value;
    read.result = md.readability(text);
    updateReadPanel();
    if (!showing) { read.backdrop.hidden = true; read.layer.textContent = ''; return; }

    // Cut the text at every highlight boundary and wrap each piece in the kinds that cover it.
    const issues = read.result.issues.filter((i) => !read.off.has(i.kind));
    const points = [...new Set([0, text.length, ...issues.flatMap((i) => [i.start, i.end])])].sort((a, b) => a - b);
    const esc = md.escape;
    let html = '';
    let open = [];
    let next = 0; // issues are sorted by start
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k];
      const b = points[k + 1];
      while (next < issues.length && issues[next].start <= a) open.push(issues[next++]);
      open = open.filter((i) => i.end > a);
      const kinds = [...new Set(open.filter((i) => i.end >= b).map((i) => `r-${i.kind}`))];
      const piece = esc(text.slice(a, b));
      html += kinds.length ? `<span class="${kinds.join(' ')}">${piece}</span>` : piece;
    }
    read.layer.innerHTML = `${html}\n `;
    read.backdrop.hidden = false;
    syncReadLayer();
    updateReadHint();
  }

  // Keep the layer's box, font and scroll position identical to the textarea's.
  function syncReadLayer() {
    if (read.backdrop.hidden) return;
    const cs = getComputedStyle(ed);
    Object.assign(read.backdrop.style, {
      left: `${ed.offsetLeft}px`, top: `${ed.offsetTop}px`, width: `${ed.clientWidth}px`, height: `${ed.clientHeight}px`,
    });
    Object.assign(read.layer.style, {
      width: `${ed.clientWidth}px`, font: cs.font, letterSpacing: cs.letterSpacing, padding: cs.padding, tabSize: cs.tabSize,
      transform: `translateY(${-ed.scrollTop}px)`,
    });
  }

  function updateReadHint() {
    const hint = $('#read-hint');
    if (!read.on || !read.result || document.activeElement !== ed) { hint.textContent = ''; return; }
    const pos = ed.selectionStart;
    const here = read.result.issues
      .filter((i) => !read.off.has(i.kind) && i.start <= pos && pos <= i.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start)); // the most specific first
    hint.textContent = here.length ? here.map((i) => i.message).slice(0, 2).join(' · ') : '';
  }

  function updateReadPanel() {
    const r = read.result;
    const btn = $('#read-btn');
    btn.setAttribute('aria-pressed', String(read.on));
    btn.querySelector('span').textContent = read.on && r?.sentences ? `Readability · grade ${r.grade}` : 'Readability';
    $('#read-on').checked = read.on;
    $('#read-panel').classList.toggle('off', !read.on);
    if ($('#read-panel').hidden || !r) return;
    const words = GRADE_WORDS.find(([max]) => r.grade <= max)[1];
    $('#read-grade').innerHTML = r.sentences
      ? `<b>Grade ${r.grade}</b> · ${md.escape(words)}<br>${r.sentences} sentences, ${(r.words / r.sentences).toFixed(0)} words on average`
      : 'Nothing to measure yet.';
    $('#read-cats').replaceChildren(...READ_CATS.map((c) => {
      const row = document.createElement('label');
      row.className = 'read-cat';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !read.off.has(c.kind);
      box.addEventListener('change', () => {
        if (box.checked) read.off.delete(c.kind); else read.off.add(c.kind);
        prefs.set('readability-off', [...read.off]);
        if (!read.on) setReadability(true); else renderReadability();
      });
      const swatch = document.createElement('span');
      swatch.className = `swatch${c.line ? ' line' : ''}`;
      swatch.style.cssText = c.swatch;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = r.issues.filter((i) => i.kind === c.kind).length;
      row.append(box, swatch, name, count);
      return row;
    }));
  }

  function setReadability(on) {
    read.on = on;
    prefs.set('readability', on);
    renderReadability();
    if (!on) $('#read-hint').textContent = '';
  }

  $('#read-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('#read-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      panel.style.left = `${Math.max(10, $('#read-btn').offsetLeft - 10)}px`;
      // Opening the panel turns highlighting on (the switch inside turns it off again).
      if (!read.on) setReadability(true);
      else renderReadability();
    }
  });
  $('#read-on').addEventListener('change', (e) => setReadability(e.target.checked));
  ed.addEventListener('scroll', () => {
    if (!read.backdrop.hidden) read.layer.style.transform = `translateY(${-ed.scrollTop}px)`;
  });
  document.addEventListener('selectionchange', () => { if (read.on) updateReadHint(); });
  ed.addEventListener('blur', () => { $('#read-hint').textContent = ''; });
  new ResizeObserver(() => { if (read.on) renderReadability(); }).observe(ed);

  // ---------------------------------------------------------------------------
  // Import Markdown files — into whichever tab the sidebar is on

  const IMPORTABLE = /\.(md|markdown|mdown|mkd|txt)$/i;
  const MAX_IMPORT = 5 * 1024 * 1024;

  async function importFiles(files) {
    const kind = state.view;
    const wanted = [...files].filter((f) => IMPORTABLE.test(f.name) || f.type === 'text/markdown');
    const skipped = files.length - wanted.length;
    if (!wanted.length) { toast('Only Markdown (.md) or plain text (.txt) files can be imported'); return; }

    const failed = [];
    const items = [];
    for (const file of wanted) {
      if (file.size > MAX_IMPORT) { failed.push(`${file.name} (larger than 5 MB)`); continue; }
      const content = await file.text();
      const title = md.title(content) || (kind === 'notes' ? md.displayTitle(content) : '');
      const stem = file.name.replace(/\.[^.]*$/, '');
      items.push({ file, content, title, name: slugifyTitle(title || stem) || slugifyTitle(stem) || 'untitled' });
    }
    if (items.length && !(await askImportNames(items, kind))) return; // cancelled

    await save();
    let last = null;
    let done = 0;
    for (const item of items) {
      try {
        last = await api('POST', `/api/${kind}`, { content: item.content, filename: item.file.name, name: item.name });
        done++;
      } catch (err) {
        failed.push(`${item.file.name} (${err.message})`);
      }
    }
    if (done) {
      await loadList();
      load(last, kind);
    }
    const what = kind === 'notes' ? 'quick note' : 'article';
    const parts = [];
    if (done === 1) parts.push(`Imported “${el.title.textContent}”${kind === 'articles' ? ' into Backlog' : ''}`);
    else if (done) parts.push(`Imported ${done} ${what}s`);
    if (failed.length) parts.push(`couldn’t import ${failed.join(', ')}`);
    if (skipped) parts.push(`skipped ${skipped} file${skipped === 1 ? '' : 's'} that ${skipped === 1 ? 'isn’t' : 'aren’t'} Markdown`);
    toast(parts.join(' · '));
  }

  // Lets you check and change each file's name before importing. Resolves false if cancelled.
  function askImportNames(items, kind) {
    const dialog = $('#import-dialog');
    const folder = KINDS[kind].folder;
    const taken = new Set(listOf(kind).map((d) => d.slug));
    $('#import-title').textContent = items.length === 1 ? 'Import file' : `Import ${items.length} files`;
    $('#import-sub').textContent = kind === 'notes'
      ? 'They’ll be added as quick notes. Change a file name if you like.'
      : 'They’ll be added as articles in Backlog. Change a file name if you like.';
    $('#import-ok').textContent = items.length === 1 ? 'Import' : `Import ${items.length}`;

    const rows = items.map((item) => {
      const row = document.createElement('div');
      row.className = 'import-row';
      const from = document.createElement('div');
      from.className = 'from';
      from.append('From ');
      const b = document.createElement('b');
      b.textContent = item.file.name;
      from.append(b, item.title ? ` · “${item.title}”` : '');
      const box = document.createElement('label');
      box.className = 'import-name';
      const pre = document.createElement('span');
      pre.textContent = `${folder}/`;
      const input = document.createElement('input');
      input.value = item.name;
      input.spellcheck = false;
      input.setAttribute('aria-label', `File name for ${item.file.name}`);
      const post = document.createElement('span');
      post.textContent = '.md';
      box.append(pre, input, post);
      const note = document.createElement('div');
      note.className = 'note';
      row.append(from, box, note);
      return { item, input, note, row };
    });

    // Show what each name will really be saved as, and flag clashes.
    const check = () => {
      const used = new Set(taken);
      for (const r of rows) {
        const base = slugifyTitle(r.input.value) || 'untitled';
        let name = base;
        for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
        used.add(name);
        r.item.name = name;
        const changed = name !== r.input.value.trim();
        r.note.classList.toggle('warn', name !== base);
        r.note.textContent = name !== base
          ? `“${base}” is already taken — will be saved as ${folder}/${name}.md`
          : changed ? `Will be saved as ${folder}/${name}.md` : '';
      }
    };
    rows.forEach((r) => r.input.addEventListener('input', check));
    check();
    $('#import-rows').replaceChildren(...rows.map((r) => r.row));

    return new Promise((resolve) => {
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
      dialog.showModal();
      rows[0].input.focus();
      rows[0].input.select();
    });
  }

  $('#import').addEventListener('click', () => $('#import-picker').click());
  $('#import-picker').addEventListener('change', () => {
    importFiles([...$('#import-picker').files]);
    $('#import-picker').value = '';
  });

  // Drop Markdown files anywhere on the window. (Images dropped on the editor are
  // handled by the editor itself, which marks the event as dealt with.)
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  function showDropHint(on) {
    $('#drop-hint').hidden = !on;
    $('#drop-where').textContent = state.view === 'notes' ? 'as quick notes' : 'as articles in Backlog';
  }
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    if (e.target !== ed) showDropHint(true);
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showDropHint(false);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // don't let the browser open the file instead
    if (e.target === ed) showDropHint(false);
    else if ($('#drop-hint').hidden) showDropHint(true);
  });
  document.addEventListener('drop', (e) => {
    dragDepth = 0;
    showDropHint(false);
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter((f) => !f.type.startsWith('image/'));
    if (files.length) importFiles(files);
  });

  // ---------------------------------------------------------------------------
  // Images: paste, drop or pick → saved to /images → ![](../images/…)

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  async function uploadImages(files) {
    if (!state.doc) return;
    for (const file of files) {
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const generic = !file.name || /^image\.\w+$/i.test(file.name);
      const name = generic ? `${state.doc.slug}-${stamp()}.${ext}` : file.name;
      try {
        toast(`Adding ${name}…`);
        const r = await api('POST', `/api/images?name=${enc(name)}`, undefined, file);
        const alt = generic ? '' : r.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
        insertBlock(`![${alt}](${r.path})`);
        toast(`Saved to images/${r.name}`);
      } catch (err) {
        toast(`Couldn’t add image: ${err.message}`);
      }
    }
  }

  el.filePicker.addEventListener('change', () => {
    uploadImages([...el.filePicker.files]);
    el.filePicker.value = '';
  });

  ed.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      uploadImages(files);
      return;
    }
    // Pasting a URL over selected text turns it into a link.
    const text = (e.clipboardData?.getData('text/plain') || '').trim();
    const { selectionStart: s, selectionEnd: end, value: v } = ed;
    const sel = v.slice(s, end);
    if (sel && !sel.includes('\n') && !/^https?:\/\//.test(sel) && /^https?:\/\/\S+$/.test(text)) {
      e.preventDefault();
      replaceRange(s, end, `[${sel}](${text})`);
    }
  });

  ed.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
  });
  ed.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    uploadImages(files);
  });

  // ---------------------------------------------------------------------------
  // Articles: new, rename, export, delete

  function ask({ title, text = '', label = null, value = '', placeholder = '', hint = '', confirm = 'OK', danger = false }) {
    return new Promise((resolve) => {
      $('#dialog-title').textContent = title;
      $('#dialog-body').textContent = text;
      $('#dialog-field').hidden = label === null;
      $('#dialog-label').textContent = label || '';
      $('#dialog-hint').textContent = hint;
      const input = $('#dialog-input');
      input.value = value;
      input.placeholder = placeholder;
      input.required = label !== null;
      const ok = $('#dialog-ok');
      ok.textContent = confirm;
      ok.className = `btn ${danger ? 'danger' : 'primary'}`;
      el.dialog.returnValue = '';
      el.dialog.addEventListener('close', () => {
        if (el.dialog.returnValue !== 'ok') resolve(null);
        else resolve(label === null ? true : input.value.trim());
      }, { once: true });
      el.dialog.showModal();
      if (label !== null) input.select();
    });
  }

  async function newDoc() {
    if (state.view === 'notes') {
      // Quick notes start straight away: no title needed, the first line becomes one.
      await save();
      try {
        const n = await api('POST', '/api/notes', {});
        await loadList();
        load(n, 'notes');
        if (body.dataset.mode === 'preview') setMode('write');
        ed.focus();
        ed.setSelectionRange(ed.value.length, ed.value.length); // start typing below the created: line
      } catch (err) {
        toast(`Couldn’t create note: ${err.message}`);
      }
      return;
    }
    const title = await ask({
      title: 'New article', label: 'Title', placeholder: 'What are you writing about?', confirm: 'Create',
      hint: 'You can change the title any time — it’s the first heading.',
    });
    if (!title) return;
    await save();
    try {
      const a = await api('POST', '/api/articles', { title });
      await loadList();
      load(a, 'articles');
      ed.focus();
      ed.setSelectionRange(ed.value.length, ed.value.length);
    } catch (err) {
      toast(`Couldn’t create article: ${err.message}`);
    }
  }

  async function renameDoc() {
    const doc = state.doc;
    const folder = KINDS[doc.kind].folder;
    const heading = doc.kind === 'notes' ? md.displayTitle(ed.value) : md.title(ed.value);
    const suggested = heading ? slugifyTitle(heading) || doc.slug : doc.slug;
    const to = await ask({
      title: 'Rename file', label: 'File name', value: suggested,
      hint: `Letters, numbers and dashes. Currently ${folder}/${doc.slug}.md`, confirm: 'Rename',
    });
    if (!to || to === doc.slug) return;
    await save();
    try {
      const a = await api('POST', `${docUrl(doc)}/rename`, { to });
      doc.slug = a.slug;
      doc.mtime = a.mtime;
      prefs.set('last', { kind: doc.kind, slug: a.slug });
      history.replaceState(null, '', hashFor(doc.kind, a.slug));
      await loadList();
      refresh(true);
      toast(`Renamed to ${folder}/${a.slug}.md`);
    } catch (err) {
      toast(`Couldn’t rename: ${err.message}`);
    }
  }

  function slugifyTitle(t) {
    return t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  }

  async function deleteDoc() {
    const doc = state.doc;
    const ok = await ask({
      title: 'Move to trash?',
      text: `“${el.title.textContent}” will be moved to ${KINDS[doc.kind].folder}/.trash. You can restore it from there.`,
      confirm: 'Move to trash', danger: true,
    });
    if (!ok) return;
    await save();
    try {
      await api('DELETE', docUrl(doc));
      closeDoc();
      await loadList();
      const next = listOf(doc.kind)[0];
      if (next) await openDoc(doc.kind, next.slug);
      toast(`Moved to ${KINDS[doc.kind].folder}/.trash`);
    } catch (err) {
      toast(`Couldn’t delete: ${err.message}`);
    }
  }

  async function exportDoc() {
    await save();
    const a = document.createElement('a');
    a.href = `${docUrl()}/export`;
    a.download = `${state.doc.slug}.html`;
    a.click();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for browsers that block the async clipboard API.
      const t = document.createElement('textarea');
      t.value = text;
      t.style.cssText = 'position:fixed;opacity:0';
      document.body.append(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      ed.focus();
      return ok;
    }
  }

  async function copyHtml() {
    toast(await copyText(md.render(ed.value)) ? 'Article HTML copied' : 'Clipboard not available');
  }

  let copiedTimer = 0;
  async function copyMarkdown({ includeTitle = false } = {}) {
    const text = md.forPublishing(ed.value, { includeTitle });
    if (!(await copyText(text))) { toast('Clipboard not available'); return; }
    const words = md.stats(text).words.toLocaleString();
    toast(includeTitle
      ? `Markdown copied (${words} words)`
      : `Markdown copied (${words} words) — the title goes in Ghost’s title field`);
    const btn = $('#copy-md');
    btn.classList.add('done');
    btn.querySelector('span').textContent = 'Copied';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      btn.classList.remove('done');
      btn.querySelector('span').textContent = 'Copy for Ghost';
    }, 1800);
  }

  $('#copy-md').addEventListener('click', () => { if (state.doc) copyMarkdown(); });

  const actions = {
    rename: renameDoc,
    export: exportDoc,
    'copy-md': () => copyMarkdown({ includeTitle: true }),
    history: () => openHistory(),
    'copy-html': copyHtml,
    delete: deleteDoc,
  };

  function toggleMenu(open = el.menu.hidden) {
    el.menu.hidden = !open;
    el.menuBtn.setAttribute('aria-expanded', String(open));
    if (open) el.menu.querySelector('button').focus();
  }
  el.menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  el.menu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action || !state.doc) return;
    toggleMenu(false);
    actions[action]();
  });
  document.addEventListener('click', (e) => {
    if (!el.menu.hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
    if (!el.issues.hidden && !e.target.closest('#issues')) el.issues.hidden = true;
    if (!$('#read-panel').hidden && !e.target.closest('#read-panel, #read-btn')) $('#read-panel').hidden = true;
  });

  // ---------------------------------------------------------------------------
  // View: modes, focus, sidebar, theme

  const MODES = ['write', 'split', 'preview'];
  function setMode(mode) {
    body.dataset.mode = mode;
    prefs.set('mode', mode);
    document.querySelectorAll('#modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    if (state.doc) {
      refresh(true);
      if (mode !== 'preview') ed.focus();
    }
  }
  $('#modes').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-mode]')?.dataset.mode;
    if (mode) setMode(mode);
  });

  function toggleFocus(on = !body.classList.contains('focus')) {
    body.classList.toggle('focus', on);
    if (on) ed.focus();
  }
  $('#focus').addEventListener('click', () => toggleFocus(true));
  $('#focus-exit').addEventListener('click', () => toggleFocus(false));

  function toggleSidebar() {
    if (isMobile()) {
      body.classList.toggle('show-sidebar');
    } else {
      body.classList.toggle('no-sidebar');
      prefs.set('sidebar', !body.classList.contains('no-sidebar'));
    }
  }
  $('#toggle-sidebar').addEventListener('click', toggleSidebar);
  $('#scrim').addEventListener('click', () => body.classList.remove('show-sidebar'));

  const THEMES = ['auto', 'light', 'dark'];
  function setTheme(theme) {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    $('#theme').title = `Theme: ${theme}`;
    prefs.set('theme', theme);
  }
  $('#theme').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(prefs.get('theme', 'auto')) + 1) % THEMES.length];
    setTheme(next);
    toast(`Theme: ${next}`);
  });

  let toastTimer = 0;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (!sug.panel.hidden) { closeSuggest(); ed.focus(); return; }
      if (el.dialog.open || $('#import-dialog').open) return;
      if (historyOpen()) { closeHistory(); return; }
      if (!el.menu.hidden) { toggleMenu(false); el.menuBtn.focus(); return; }
      if (!el.issues.hidden) { el.issues.hidden = true; return; }
      if (!$('#read-panel').hidden) { $('#read-panel').hidden = true; return; }
      if (body.classList.contains('focus')) { toggleFocus(false); return; }
    }
    if (!mod) return;
    if (e.altKey && e.code === 'KeyN') { e.preventDefault(); if (state.doc) toggleNotes(); return; }
    if (e.altKey && e.code === 'KeyM') { e.preventDefault(); moveToNotes(); return; }
    if (e.key === 's') { e.preventDefault(); save(); }
    else if (e.key === '/') { e.preventDefault(); setMode(MODES[(MODES.indexOf(body.dataset.mode) + 1) % MODES.length]); }
    else if (e.key === '.' && !e.shiftKey) { e.preventDefault(); toggleFocus(); }
    else if (e.key === '\\') { e.preventDefault(); toggleSidebar(); }
  });

  // ---------------------------------------------------------------------------
  // Wiring & startup

  el.search.addEventListener('input', renderList);
  el.list.addEventListener('click', (e) => {
    const item = e.target.closest('[data-slug]');
    if (item) openDoc(item.dataset.kind, item.dataset.slug);
  });
  $('#new').addEventListener('click', newDoc);
  $('#empty-new').addEventListener('click', newDoc);

  window.addEventListener('focus', checkDisk);
  window.addEventListener('hashchange', () => {
    const target = parseHash();
    if (target && !isOpen(target.kind, target.slug)) openDoc(target.kind, target.slug);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!isDirty() || state.conflict) return;
    // Best effort: flush the last keystrokes, and warn in case it doesn't land.
    fetch(docUrl(), {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: fileText(), mtime: state.doc.mtime }),
    });
    e.preventDefault();
  });

  async function init() {
    setTheme(prefs.get('theme', 'auto'));
    setFont(prefs.get('font', 'mono'));
    setMode(prefs.get('mode', 'split'));
    if (prefs.get('sidebar', true) === false) body.classList.add('no-sidebar');
    if (prefs.get('notes', false)) { body.classList.add('notes-open'); $('#notes').inert = false; $('#notes-btn').setAttribute('aria-pressed', 'true'); }

    state.view = prefs.get('view', 'articles') === 'notes' ? 'notes' : 'articles';
    await loadList();
    setView(state.view);
    let last = prefs.get('last', null);
    if (typeof last === 'string') last = { kind: 'articles', slug: last }; // older saved form
    const wanted = parseHash() || last;
    const found = wanted && listOf(wanted.kind).find((a) => a.slug === wanted.slug);
    const first = listOf(state.view)[0] || state.articles[0];
    if (found) await openDoc(wanted.kind, found.slug);
    else if (first) await openDoc(listOf(state.view)[0] ? state.view : 'articles', first.slug);
    else closeDoc();
  }

  init().catch((err) => toast(`Couldn’t reach the writer server: ${err.message}`));
})();
