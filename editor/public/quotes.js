/* DB Writer — the Quotes page: save quotes, who said them, and what they're for. */
(() => {
  'use strict';

  const { api, toast, prefs } = window.dbw;
  const md = window.DBMarkdown;
  const $ = (sel, root = document) => root.querySelector(sel);
  const body = document.body;
  const pieces = () => window.dbw.articles(); // articles and thoughts: [{ slug (key), title, status, kind }]
  const pieceTitle = (key) => pieces().find((a) => a.slug === key)?.title;

  const Q = {
    items: [],
    loaded: false,
    author: prefs.get('quote-author', ''), // filter: one person
    piece: prefs.get('quote-piece', ''), // filter: one article or thought
    q: '',
    editing: null,
    undo: null,
  };

  const ICONS = {
    edit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12.5 4.5 15.5 7.5 7 16H4v-3l8.5-8.5Z"/></svg>',
    trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6"/></svg>',
    copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="6.5" y="6.5" width="10" height="11" rx="2"/><path d="M13.5 6.5V4.5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/></svg>',
  };

  const h = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'value') node.value = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };
  const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());
  const dateLabel = (ms) => new Date(ms).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(new Date(ms).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  });
  const changed = () => window.dispatchEvent(new CustomEvent('dbw:quotes-changed', { detail: 'page' }));

  // A chip list + dropdown for choosing the articles and thoughts a quote is for.
  function piecePicker(selected) {
    const box = h('div', { class: 'article-pick' });
    const draw = () => {
      const order = { backlog: 0, editing: 1, final: 2, published: 3 }; // drafts first
      const options = pieces().filter((a) => !selected.includes(a.slug))
        .sort((a, b) => order[a.status] - order[b.status] || a.title.localeCompare(b.title));
      const select = h('select', { 'aria-label': 'Add to an article or thought' },
        h('option', { value: '' }, selected.length ? '+ Another…' : '+ For an article or thought…'),
        ...options.map((a) => h('option', { value: a.slug }, `${a.kind === 'thoughts' ? 'Thought: ' : ''}${a.title}`)));
      select.hidden = !options.length;
      select.addEventListener('change', () => { if (select.value) { selected.push(select.value); draw(); } });
      box.replaceChildren(
        ...selected.filter(pieceTitle).map((key) => h('button', {
          type: 'button', class: 'tag-chip', title: 'Remove', onclick: () => { selected.splice(selected.indexOf(key), 1); draw(); },
        }, pieceTitle(key), h('span', { class: 'x' }, '×'))),
        select);
    };
    draw();
    return box;
  }

  // ---------------------------------------------------------------------------
  // Loading & rendering

  async function reload() {
    Q.items = await api('GET', '/api/quotes');
    Q.loaded = true;
    for (const q of Q.items) q.articles = q.articles || [];
    updateCount();
  }

  function updateCount() {
    const n = $('#view-tabs [data-view="quotes"] .count');
    if (n) n.textContent = Q.items.length;
  }

  function shown() {
    const words = Q.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return Q.items.filter((q) =>
      (!Q.author || (q.author || 'Unknown') === Q.author) &&
      (!Q.piece || q.articles.includes(Q.piece)) &&
      words.every((w) => [q.text, q.author, q.source, q.note].join(' ').toLowerCase().includes(w)));
  }

  const saveFilter = () => { prefs.set('quote-author', Q.author); prefs.set('quote-piece', Q.piece); };

  function render() {
    renderSide();
    renderFilter();
    renderList();
  }

  function renderSide() {
    const people = new Map();
    for (const q of Q.items) people.set(q.author || 'Unknown', (people.get(q.author || 'Unknown') || 0) + 1);
    const perPiece = new Map();
    for (const q of Q.items) for (const key of q.articles) if (pieceTitle(key)) perPiece.set(key, (perPiece.get(key) || 0) + 1);
    const row = (label, n, pressed, onclick, title) => h('button', { class: 'tag-row', 'aria-pressed': String(pressed), title, onclick },
      h('span', { class: 'name' }, label), h('span', { class: 'n' }, n));
    const side = $('#quotes-side');
    side.replaceChildren(
      row('All quotes', Q.items.length, !Q.author && !Q.piece, () => { Q.author = ''; Q.piece = ''; saveFilter(); render(); }),
      h('h3', {}, 'People'),
      ...(people.size
        ? [...people].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([who, n]) =>
          row(who, n, Q.author === who, () => { Q.author = Q.author === who ? '' : who; saveFilter(); render(); }, `Quotes by ${who}`))
        : [h('p', { class: 'empty-tags' }, 'The people you quote show up here.')]),
    );
    if (perPiece.size) {
      side.append(h('h3', {}, 'For your writing'), ...[...perPiece].sort((a, b) => b[1] - a[1]).map(([key, n]) =>
        row(pieceTitle(key), n, Q.piece === key, () => { Q.piece = Q.piece === key ? '' : key; saveFilter(); render(); }, 'Quotes for this piece')));
    }
  }

  function renderFilter() {
    const box = $('#quotes-filter');
    if (Q.piece && !pieceTitle(Q.piece)) Q.piece = '';
    if (Q.author && !Q.items.some((q) => (q.author || 'Unknown') === Q.author)) Q.author = '';
    box.hidden = !Q.author && !Q.piece;
    if (box.hidden) return;
    const chip = (label, clear) => h('button', { class: 'tag-chip on', title: 'Remove this filter', onclick: () => { clear(); saveFilter(); render(); } }, label, h('span', { class: 'x' }, '×'));
    box.replaceChildren(...[
      `Showing ${shown().length}`,
      Q.author ? chip(`by ${Q.author}`, () => { Q.author = ''; }) : null,
      Q.piece ? chip(`for “${pieceTitle(Q.piece)}”`, () => { Q.piece = ''; }) : null,
      h('button', { class: 'tag-chip', onclick: () => { Q.author = ''; Q.piece = ''; saveFilter(); render(); } }, 'Clear'),
    ].filter((x) => x != null));
  }

  function renderList() {
    const list = $('#quotes-list');
    const items = shown();
    if (!items.length) {
      list.replaceChildren(h('li', { class: 'links-empty' }, !Q.items.length
        ? 'No quotes yet. Add one above — who said it, where it’s from, and which article or thought it’s for.'
        : 'No quotes match. Try a different search or filter.'));
      return;
    }
    list.replaceChildren(...items.map((q) => (q.id === Q.editing ? editCard(q) : card(q))));
  }

  function cite(q) {
    const parts = [];
    if (q.author) parts.push(h('span', { class: 'who' }, q.author));
    if (q.source) parts.push(isUrl(q.source)
      ? h('a', { href: q.source, target: '_blank', rel: 'noopener noreferrer' }, (() => { try { return new URL(q.source).hostname.replace(/^www\./, ''); } catch { return 'source'; } })())
      : h('em', {}, q.source));
    const out = ['— '];
    parts.forEach((p, i) => out.push(...(i ? [', ', p] : [p])));
    if (!parts.length) out.push('Unknown');
    out.push(` · Added ${dateLabel(q.created)}`);
    return h('p', { class: 'quote-cite' }, ...out);
  }

  function card(q) {
    return h('li', { class: 'quote-card', 'data-id': q.id },
      h('div', { class: 'quote-main' },
        h('blockquote', { class: 'quote-text' }, q.text),
        cite(q),
        q.note ? h('p', { class: 'link-note' }, q.note) : null,
        q.articles.some(pieceTitle) ? h('div', { class: 'link-articles' }, 'For ', ...q.articles.filter(pieceTitle).map((key) => h('button', {
          class: 'article-chip', title: 'Open it', onclick: () => window.dbw.openArticle(key),
        }, pieceTitle(key)))) : null),
      h('div', { class: 'link-actions' },
        h('button', { class: 'icon-btn', title: 'Copy as a Markdown blockquote', 'aria-label': 'Copy', html: ICONS.copy, onclick: () => copy(q) }),
        h('button', { class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit', html: ICONS.edit, onclick: () => { Q.editing = q.id; renderList(); } }),
        h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', html: ICONS.trash, onclick: () => remove(q) })));
  }

  function editCard(q) {
    const text = h('textarea', { rows: 3, 'aria-label': 'Quote', value: q.text });
    const author = h('input', { placeholder: 'Who said it', 'aria-label': 'Who said it', value: q.author || '' });
    const source = h('input', { placeholder: 'Source — book, talk or link', 'aria-label': 'Source', value: q.source || '' });
    const note = h('textarea', { rows: 2, placeholder: 'A note to yourself (optional)', 'aria-label': 'Note', value: q.note || '' });
    note.style.font = '14px var(--ui)';
    const selected = [...q.articles];
    const save = async () => {
      try {
        Object.assign(q, await api('PATCH', `/api/quotes/${q.id}`, { text: text.value, author: author.value, source: source.value, note: note.value, articles: selected }));
        Q.editing = null;
        changed();
        render();
        flash(q.id);
      } catch (err) {
        toast(`Couldn’t save: ${err.message}`);
      }
    };
    const cancel = () => { Q.editing = null; renderList(); };
    const form = h('form', { class: 'quote-edit', onsubmit: (e) => { e.preventDefault(); save(); } },
      text,
      h('div', { class: 'quote-form-row' }, author, source),
      h('div', { class: 'link-edit-field' }, h('span', {}, 'For articles & thoughts'), piecePicker(selected)),
      note,
      h('div', { class: 'link-edit-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
        h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel')));
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });
    requestAnimationFrame(() => text.focus());
    return h('li', { class: 'quote-card', 'data-id': q.id }, h('div', { class: 'quote-main' }, form));
  }

  function flash(id) {
    const node = $(`.quote-card[data-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  // ---------------------------------------------------------------------------
  // Adding, copying, deleting

  let addFor = [];
  const drawAddFor = () => $('#quote-add-for').replaceWith(Object.assign(piecePicker(addFor), { id: 'quote-add-for' }));

  async function add() {
    const text = $('#quote-text').value;
    if (!text.trim()) { $('#quote-text').focus(); return; }
    const btn = $('#quote-save');
    btn.disabled = true;
    try {
      const q = await api('POST', '/api/quotes', { text, author: $('#quote-author').value, source: $('#quote-source').value, articles: addFor });
      Q.items.unshift(q);
      changed();
      updateCount();
      $('#quote-text').value = '';
      $('#quote-author').value = '';
      $('#quote-source').value = '';
      addFor = [];
      drawAddFor();
      Q.author = '';
      Q.piece = '';
      Q.q = '';
      $('#quote-search').value = '';
      saveFilter();
      render();
      flash(q.id);
      toast('Quote saved');
      $('#quote-text').focus();
    } catch (err) {
      if (err.status === 409 && err.data?.quote) {
        Q.author = ''; Q.piece = ''; Q.q = ''; $('#quote-search').value = '';
        render();
        flash(err.data.quote.id);
        toast('You’ve already saved this quote — here it is');
      } else {
        toast(`Couldn’t save the quote: ${err.message}`);
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function copy(q) {
    try {
      await navigator.clipboard.writeText(md.quoteMarkdown(q));
      toast('Copied as a Markdown blockquote');
    } catch {
      toast('Clipboard not available');
    }
  }

  async function remove(q) {
    try {
      await api('DELETE', `/api/quotes/${q.id}`);
      Q.items = Q.items.filter((x) => x.id !== q.id);
      changed();
      updateCount();
      render();
      clearTimeout(Q.undo?.timer);
      const bar = $('#quotes-undo');
      bar.querySelector('span').textContent = `Deleted the quote${q.author ? ` by ${q.author}` : ''}.`;
      bar.hidden = false;
      Q.undo = { quote: q, timer: setTimeout(() => { bar.hidden = true; Q.undo = null; }, 8000) };
    } catch (err) {
      toast(`Couldn’t delete: ${err.message}`);
    }
  }

  async function undoDelete() {
    const u = Q.undo;
    if (!u) return;
    clearTimeout(u.timer);
    $('#quotes-undo').hidden = true;
    Q.undo = null;
    try {
      await api('POST', '/api/quotes/restore', { quote: u.quote });
      await reload();
      changed();
      render();
      flash(u.quote.id);
    } catch (err) {
      toast(`Couldn’t restore: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring

  $('#quote-add').addEventListener('submit', (e) => { e.preventDefault(); add(); });
  $('#quote-add').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
  });
  $('#quote-search').addEventListener('input', (e) => { Q.q = e.target.value; renderFilter(); renderList(); });
  $('#quotes-undo button').addEventListener('click', undoDelete);

  window.addEventListener('dbw:quotes-changed', (e) => {
    if (e.detail === 'page') return;
    reload().then(() => { if (body.dataset.view === 'quotes') render(); }).catch(() => {});
  });
  window.addEventListener('dbw:view', async (e) => {
    if (e.detail !== 'quotes') return;
    try {
      if (!Q.loaded) await reload();
      drawAddFor();
      render();
    } catch (err) {
      toast(`Couldn’t load quotes: ${err.message}`);
    }
  });
  window.addEventListener('focus', () => {
    if (body.dataset.view === 'quotes' && !Q.editing) reload().then(render).catch(() => {});
  });

  reload().catch(() => {}); // for the tab's count
})();
