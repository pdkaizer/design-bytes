/* Design Bytes Writer — editor client. */
(() => {
  'use strict';

  const md = window.DBMarkdown;
  const $ = (sel) => document.querySelector(sel);
  const body = document.body;
  const ed = $('#editor');

  const el = {
    list: $('#list'),
    search: $('#search'),
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
    doc: null, // { slug, saved, mtime }
    saveTimer: 0,
    saving: null,
    conflict: null,
    issues: [],
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

  async function loadList() {
    state.articles = await api('GET', '/api/articles');
    renderList();
  }

  function renderList() {
    const q = el.search.value.trim().toLowerCase();
    const shown = state.articles.filter((a) =>
      !q || a.title.toLowerCase().includes(q) || a.slug.includes(q) || (a.excerpt || '').toLowerCase().includes(q));

    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'list-empty';
      li.textContent = q ? 'No matches' : 'No articles yet';
      el.list.replaceChildren(li);
      return;
    }

    el.list.replaceChildren(...shown.map((a) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'item' + (state.doc?.slug === a.slug ? ' active' : '');
      btn.dataset.slug = a.slug;
      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = a.title;
      const meta = document.createElement('span');
      meta.className = 'item-meta';
      meta.textContent = `${a.words.toLocaleString()} words · ${ago(a.mtime)}`;
      btn.append(title, meta);
      li.append(btn);
      return li;
    }));
  }

  // ---------------------------------------------------------------------------
  // Opening & saving

  async function openArticle(slug) {
    if (state.doc?.slug === slug) return;
    await save();
    try {
      load(await api('GET', `/api/articles/${enc(slug)}`));
      if (isMobile()) body.classList.remove('show-sidebar');
    } catch (err) {
      toast(`Couldn’t open ${slug}: ${err.message}`);
    }
  }

  function load(article) {
    state.doc = { slug: article.slug, saved: article.content, mtime: article.mtime };
    hideConflict();
    ed.value = article.content;
    ed.setSelectionRange(0, 0);
    ed.scrollTop = 0;
    el.previewPane.scrollTop = 0;
    body.classList.remove('empty');
    prefs.set('last', article.slug);
    history.replaceState(null, '', `#${article.slug}`);
    setStatus('saved');
    refresh(true);
    renderList();
    updateCursor();
  }

  function closeDoc() {
    state.doc = null;
    ed.value = '';
    body.classList.add('empty');
    el.title.textContent = 'design bytes';
    el.file.textContent = '';
    document.title = 'Design Bytes Writer';
    history.replaceState(null, '', location.pathname);
    renderList();
  }

  const isDirty = () => !!state.doc && ed.value !== state.doc.saved;

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

    const content = ed.value;
    setStatus('saving');
    state.saving = (async () => {
      try {
        const r = await api('PUT', `/api/articles/${enc(doc.slug)}`, { content, mtime: force ? null : doc.mtime });
        doc.saved = content;
        doc.mtime = r.mtime;
        const entry = state.articles.find((a) => a.slug === doc.slug);
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
      const a = await api('GET', `/api/articles/${enc(doc.slug)}`);
      if (state.doc !== doc || Math.abs(a.mtime - doc.mtime) < 1) return;
      if (a.content === doc.saved) { doc.mtime = a.mtime; return; }
      if (isDirty()) { showConflict(a); return; }
      const { selectionStart, selectionEnd, scrollTop } = ed;
      ed.value = a.content;
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

      const title = md.title(text) || state.doc.slug;
      el.title.textContent = title;
      el.file.textContent = `articles/${state.doc.slug}.md`;
      document.title = `${title} · Design Bytes`;

      const s = md.stats(text);
      el.stats.textContent = `${s.words.toLocaleString()} words · ${s.minutes} min read`;

      state.issues = md.lint(text);
      el.issuesBtn.hidden = !state.issues.length;
      el.issuesBtn.textContent = `${state.issues.length} ${state.issues.length === 1 ? 'suggestion' : 'suggestions'}`;
      if (!el.issues.hidden) renderIssues();

      const entry = state.articles.find((a) => a.slug === state.doc.slug);
      if (entry && (entry.title !== title || entry.words !== s.words)) {
        entry.title = title;
        entry.words = s.words;
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
  function caretTop(pos) {
    const cs = getComputedStyle(ed);
    mirror.style.cssText = `position:absolute;visibility:hidden;top:0;left:-9999px;white-space:pre-wrap;` +
      `overflow-wrap:break-word;box-sizing:border-box;width:${ed.clientWidth}px;font:${cs.font};` +
      `letter-spacing:${cs.letterSpacing};padding:${cs.padding};tab-size:${cs.tabSize};`;
    mirror.textContent = ed.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '​';
    mirror.append(mark);
    document.body.append(mirror);
    const top = mark.offsetTop;
    mirror.remove();
    return top;
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
    else if (!e.shiftKey && !e.altKey) cmd = { b: 'bold', i: 'italic', k: 'link', e: 'code' }[key] || null;
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

  async function newArticle() {
    const title = await ask({
      title: 'New article', label: 'Title', placeholder: 'What are you writing about?', confirm: 'Create',
      hint: 'You can change the title any time — it’s the first heading.',
    });
    if (!title) return;
    await save();
    try {
      const a = await api('POST', '/api/articles', { title });
      await loadList();
      load(a);
      ed.focus();
      ed.setSelectionRange(ed.value.length, ed.value.length);
    } catch (err) {
      toast(`Couldn’t create article: ${err.message}`);
    }
  }

  async function renameDoc() {
    const doc = state.doc;
    const suggested = md.title(ed.value) ? slugifyTitle(md.title(ed.value)) : doc.slug;
    const to = await ask({
      title: 'Rename file', label: 'File name', value: doc.slug === suggested ? doc.slug : suggested,
      hint: `Letters, numbers and dashes. Currently articles/${doc.slug}.md`, confirm: 'Rename',
    });
    if (!to || to === doc.slug) return;
    await save();
    try {
      const a = await api('POST', `/api/articles/${enc(doc.slug)}/rename`, { to });
      doc.slug = a.slug;
      doc.mtime = a.mtime;
      prefs.set('last', a.slug);
      history.replaceState(null, '', `#${a.slug}`);
      await loadList();
      refresh(true);
      toast(`Renamed to articles/${a.slug}.md`);
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
      text: `“${el.title.textContent}” will be moved to articles/.trash. You can restore it from there.`,
      confirm: 'Move to trash', danger: true,
    });
    if (!ok) return;
    await save();
    try {
      await api('DELETE', `/api/articles/${enc(doc.slug)}`);
      closeDoc();
      await loadList();
      if (state.articles[0]) await openArticle(state.articles[0].slug);
      toast('Moved to articles/.trash');
    } catch (err) {
      toast(`Couldn’t delete: ${err.message}`);
    }
  }

  async function exportDoc() {
    await save();
    const a = document.createElement('a');
    a.href = `/api/articles/${enc(state.doc.slug)}/export`;
    a.download = `${state.doc.slug}.html`;
    a.click();
  }

  async function copyHtml() {
    try {
      await navigator.clipboard.writeText(md.render(ed.value));
      toast('Article HTML copied');
    } catch {
      toast('Clipboard not available');
    }
  }

  const actions = { rename: renameDoc, export: exportDoc, 'copy-html': copyHtml, delete: deleteDoc };

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
      if (!el.menu.hidden) { toggleMenu(false); el.menuBtn.focus(); return; }
      if (!el.issues.hidden) { el.issues.hidden = true; return; }
      if (body.classList.contains('focus')) { toggleFocus(false); return; }
    }
    if (!mod) return;
    if (e.key === 's') { e.preventDefault(); save(); }
    else if (e.key === '/') { e.preventDefault(); setMode(MODES[(MODES.indexOf(body.dataset.mode) + 1) % MODES.length]); }
    else if (e.key === '.' && !e.shiftKey) { e.preventDefault(); toggleFocus(); }
    else if (e.key === '\\') { e.preventDefault(); toggleSidebar(); }
  });

  // ---------------------------------------------------------------------------
  // Wiring & startup

  el.search.addEventListener('input', renderList);
  el.list.addEventListener('click', (e) => {
    const slug = e.target.closest('[data-slug]')?.dataset.slug;
    if (slug) openArticle(slug);
  });
  $('#new').addEventListener('click', newArticle);
  $('#empty-new').addEventListener('click', newArticle);

  window.addEventListener('focus', checkDisk);
  window.addEventListener('hashchange', () => {
    const slug = decodeURIComponent(location.hash.slice(1));
    if (slug && slug !== state.doc?.slug) openArticle(slug);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!isDirty() || state.conflict) return;
    // Best effort: flush the last keystrokes, and warn in case it doesn't land.
    fetch(`/api/articles/${enc(state.doc.slug)}`, {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: ed.value, mtime: state.doc.mtime }),
    });
    e.preventDefault();
  });

  async function init() {
    setTheme(prefs.get('theme', 'auto'));
    setFont(prefs.get('font', 'mono'));
    setMode(prefs.get('mode', 'split'));
    if (prefs.get('sidebar', true) === false) body.classList.add('no-sidebar');

    await loadList();
    const wanted = decodeURIComponent(location.hash.slice(1)) || prefs.get('last', '');
    const target = state.articles.find((a) => a.slug === wanted) || state.articles[0];
    if (target) await openArticle(target.slug);
    else closeDoc();
  }

  init().catch((err) => toast(`Couldn’t reach the writer server: ${err.message}`));
})();
