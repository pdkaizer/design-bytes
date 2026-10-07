/* DB Writer — the Links page: save links and tag them by subject. */
(() => {
  'use strict';

  const { api, toast, prefs } = window.dbw;
  const articles = () => window.dbw.articles(); // [{ slug, title, status }]
  const articleTitle = (slug) => articles().find((a) => a.slug === slug)?.title;
  const $ = (sel, root = document) => root.querySelector(sel);
  const body = document.body;

  const L = {
    items: [],
    loaded: false,
    tags: new Set(prefs.get('link-tags', [])), // active tag filters (all must match)
    article: prefs.get('link-article', ''), // show only links for this article
    q: '',
    editing: null, // id of the link being edited
    undo: null, // { link, timer }
  };

  const ICONS = {
    edit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12.5 4.5 15.5 7.5 7 16H4v-3l8.5-8.5Z"/></svg>',
    trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6"/></svg>',
    copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="6.5" y="6.5" width="10" height="11" rx="2"/><path d="M13.5 6.5V4.5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/></svg>',
    spark: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2.5c.3 2.9 1.1 4.6 2.2 5.6 1 1 2.6 1.6 5.3 1.9-2.7.3-4.3.9-5.3 1.9-1.1 1-1.9 2.7-2.2 5.6-.3-2.9-1.1-4.6-2.2-5.6-1-1-2.6-1.6-5.3-1.9 2.7-.3 4.3-.9 5.3-1.9 1.1-1 1.9-2.7 2.2-5.6Z"/></svg>',
  };

  const h = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };

  const cleanTag = (t) => String(t).toLowerCase().replace(/^#+/, '').trim().replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const looksLikeUrl = (s) => /^(https?:\/\/|www\.)\S+$/i.test(s.trim()) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(s.trim());
  const dateLabel = (ms) => new Date(ms).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(new Date(ms).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  });

  function tagCounts() {
    const counts = new Map();
    for (const l of L.items) for (const t of l.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // ---------------------------------------------------------------------------
  // Loading & rendering

  async function reload() {
    L.items = await api('GET', '/api/links');
    L.loaded = true;
    for (const t of [...L.tags]) if (!L.items.some((l) => l.tags.includes(t))) L.tags.delete(t);
    for (const l of L.items) l.articles = l.articles || [];
    updateCount();
  }

  function updateCount() {
    const n = $('#view-tabs [data-view="links"] .count');
    if (n) n.textContent = L.items.length;
  }

  function shown() {
    const q = L.q.trim().toLowerCase();
    return L.items.filter((l) =>
      [...L.tags].every((t) => l.tags.includes(t)) &&
      (!L.article || l.articles.includes(L.article)) &&
      (!q || [l.title, l.url, l.site, l.description, l.note, l.tags.join(' ')].join(' ').toLowerCase().includes(q)));
  }

  function render() {
    renderSide();
    renderFilter();
    renderList();
  }

  function renderSide() {
    const counts = tagCounts();
    const side = $('#links-side');
    const all = h('button', { class: 'tag-row', 'aria-pressed': String(!L.tags.size && !L.article), onclick: () => { L.tags.clear(); L.article = ''; saveFilter(); render(); } },
      h('span', { class: 'name' }, 'All links'), h('span', { class: 'n' }, L.items.length));
    const untagged = L.items.filter((l) => !l.tags.length).length;
    const rows = counts.length
      ? counts.map(([tag, n]) => h('button', {
        class: 'tag-row', 'aria-pressed': String(L.tags.has(tag)), title: `Show links tagged #${tag}`, onclick: () => toggleTag(tag),
      }, h('span', { class: 'name' }, `#${tag}`), h('span', { class: 'n' }, n)))
      : [h('p', { class: 'empty-tags' }, 'Tags you add to links show up here, so you can browse by subject.')];
    side.replaceChildren(all, h('h3', {}, 'Tags'), ...rows);
    if (untagged && counts.length) side.append(h('p', { class: 'empty-tags' }, `${untagged} untagged`));

    // Articles that have links, most first.
    const perArticle = new Map();
    for (const l of L.items) for (const s of l.articles) if (articleTitle(s)) perArticle.set(s, (perArticle.get(s) || 0) + 1);
    if (perArticle.size) {
      side.append(h('h3', {}, 'For your writing'), ...[...perArticle].sort((a, b) => b[1] - a[1]).map(([slug, n]) => h('button', {
        class: 'tag-row', 'aria-pressed': String(L.article === slug), title: 'Show links for this article',
        onclick: () => { L.article = L.article === slug ? '' : slug; saveFilter(); render(); },
      }, h('span', { class: 'name' }, articleTitle(slug)), h('span', { class: 'n' }, n))));
    }
  }

  function renderFilter() {
    const box = $('#links-filter');
    if (L.article && !articleTitle(L.article)) L.article = '';
    box.hidden = !L.tags.size && !L.article;
    if (box.hidden) return;
    box.replaceChildren(...[
      `Showing ${shown().length}`,
      L.article ? h('button', { class: 'tag-chip on', title: 'Remove this filter', onclick: () => { L.article = ''; saveFilter(); render(); } }, `for “${articleTitle(L.article)}”`, h('span', { class: 'x' }, '×')) : null,
      L.tags.size ? 'tagged' : null,
      ...[...L.tags].map((t) => h('button', { class: 'tag-chip on', title: 'Remove this filter', onclick: () => toggleTag(t) }, `#${t}`, h('span', { class: 'x' }, '×'))),
      h('button', { class: 'tag-chip', onclick: () => { L.tags.clear(); L.article = ''; saveFilter(); render(); } }, 'Clear'),
    ].filter((x) => x != null));
  }

  function renderList() {
    const list = $('#links-list');
    const items = shown();
    if (!items.length) {
      list.replaceChildren(h('li', { class: 'links-empty' },
        !L.items.length
          ? 'No links yet. Paste one above — the page’s title and description are fetched for you, then add tags for what it’s about.'
          : 'No links match. Try fewer tags or a different search.'));
      return;
    }
    list.replaceChildren(...items.map((l) => (l.id === L.editing ? editCard(l) : card(l))));
  }

  function card(l) {
    const host = (() => { try { return new URL(l.url).hostname.replace(/^www\./, ''); } catch { return l.url; } })();
    return h('li', { class: 'link-card', 'data-id': l.id },
      h('div', { class: 'link-icon', 'aria-hidden': 'true' }, (l.site || host).replace(/^www\./, '')[0] || '•'),
      h('div', { class: 'link-main' },
        h('a', { class: 'link-title', href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url }, l.title || l.url),
        h('div', { class: 'link-meta' }, `${l.site && l.site !== host ? `${l.site} · ${host}` : host} · Added ${dateLabel(l.created)}`),
        l.description ? h('p', { class: 'link-desc' }, l.description) : null,
        l.note ? h('p', { class: 'link-note' }, l.note) : null,
        l.articles.some(articleTitle) ? h('div', { class: 'link-articles' }, 'For ', ...l.articles.filter(articleTitle).map((s) => h('button', {
          class: 'article-chip', title: 'Open this article', onclick: () => window.dbw.openArticle(s),
        }, articleTitle(s)))) : null,
        h('div', { class: 'link-tags' },
          l.tags.length
            ? l.tags.map((t) => h('button', { class: `tag-chip${L.tags.has(t) ? ' on' : ''}`, title: `Show links tagged #${t}`, onclick: () => toggleTag(t) }, `#${t}`))
            : h('button', { class: 'tag-chip suggested', onclick: () => startEdit(l.id) }, '+ Add tags'))),
      h('div', { class: 'link-actions' },
        h('button', { class: 'icon-btn', title: 'Copy link', 'aria-label': 'Copy link', html: ICONS.copy, onclick: () => copy(l) }),
        h('button', { class: 'icon-btn', title: 'Edit title, tags and note', 'aria-label': 'Edit', html: ICONS.edit, onclick: () => startEdit(l.id) }),
        h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', html: ICONS.trash, onclick: () => remove(l) })));
  }

  // ---------------------------------------------------------------------------
  // Editing a link: title, tags (with autocomplete and Claude suggestions), note

  function editCard(l) {
    const tags = [...l.tags];
    const existing = tagCounts();
    const title = h('input', { value: l.title || '', 'aria-label': 'Title' });
    const note = h('textarea', { placeholder: 'Why you saved it, what to use it for…', 'aria-label': 'Note' });
    note.value = l.note || '';
    const chips = h('span', { style: 'display: contents' });
    const tagInput = h('input', { placeholder: tags.length ? '' : 'Add tags — design, typography, ai…', 'aria-label': 'Tags', autocomplete: 'off', spellcheck: 'false' });
    const menu = h('div', { class: 'tag-menu', hidden: true });
    const tagBox = h('div', { class: 'tag-box', onclick: () => tagInput.focus() }, chips, tagInput, menu);
    const suggestions = h('span', { style: 'display: contents' });
    const linked = [...(l.articles || [])].filter(articleTitle);
    const articleChips = h('span', { style: 'display: contents' });
    const articlePick = h('select', { 'aria-label': 'Add to an article' });
    const drawArticles = () => {
      articleChips.replaceChildren(...linked.map((s) => h('button', {
        type: 'button', class: 'tag-chip', title: 'Remove', onclick: () => { linked.splice(linked.indexOf(s), 1); drawArticles(); },
      }, articleTitle(s), h('span', { class: 'x' }, '×'))));
      const order = { backlog: 0, editing: 1, final: 2, published: 3 }; // drafts first
      const options = articles().filter((a) => !linked.includes(a.slug)).sort((a, b) => order[a.status] - order[b.status] || a.title.localeCompare(b.title));
      articlePick.replaceChildren(h('option', { value: '' }, linked.length ? '+ Another article…' : '+ Add to an article…'),
        ...options.map((a) => h('option', { value: a.slug }, `${a.kind === 'thoughts' ? 'Thought: ' : ''}${a.title}${a.status === 'published' ? ' (published)' : ''}`)));
      articlePick.hidden = !options.length;
    };
    articlePick.addEventListener('change', () => { if (articlePick.value) { linked.push(articlePick.value); drawArticles(); } });
    drawArticles();
    const suggestBtn = h('button', { type: 'button', class: 'btn', html: `${ICONS.spark}<span>Suggest tags</span>`, onclick: () => suggestTags() });

    const drawChips = () => {
      chips.replaceChildren(...tags.map((t) => h('button', {
        type: 'button', class: 'tag-chip', title: 'Remove', onclick: (e) => { e.stopPropagation(); tags.splice(tags.indexOf(t), 1); drawChips(); },
      }, `#${t}`, h('span', { class: 'x' }, '×'))));
      tagInput.placeholder = tags.length ? '' : 'Add tags — design, typography, ai…';
    };
    const addTag = (raw) => {
      const t = cleanTag(raw);
      if (t && !tags.includes(t)) tags.push(t);
      tagInput.value = '';
      drawChips();
      drawMenu();
    };
    let pick = -1;
    const drawMenu = () => {
      const q = cleanTag(tagInput.value);
      const options = existing.filter(([t]) => !tags.includes(t) && (!q || t.includes(q))).slice(0, 7);
      pick = Math.min(pick, options.length - 1);
      menu.hidden = !q || !options.length;
      menu.replaceChildren(...options.map(([t, n], i) => h('button', {
        type: 'button', class: i === pick ? 'on' : '', onmousedown: (e) => { e.preventDefault(); addTag(t); },
      }, h('span', {}, `#${t}`), h('span', { class: 'n' }, n))));
      return options;
    };
    tagInput.addEventListener('input', () => {
      // Typing a comma finishes a tag.
      if (/[,\n]/.test(tagInput.value)) {
        const parts = tagInput.value.split(/[,\n]/);
        const rest = parts.pop();
        parts.forEach(addTag);
        tagInput.value = rest;
      }
      pick = -1;
      drawMenu();
    });
    tagInput.addEventListener('keydown', (e) => {
      const options = drawMenu();
      if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); pick = (pick + 1) % options.length; drawMenu(); }
      else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); pick = (pick - 1 + options.length) % options.length; drawMenu(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && (tagInput.value.trim() || pick > -1)) {
        e.preventDefault();
        addTag(pick > -1 ? options[pick][0] : tagInput.value);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !tagInput.value.trim())) { e.preventDefault(); save(); }
      else if (e.key === 'Backspace' && !tagInput.value && tags.length) { tags.pop(); drawChips(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!menu.hidden) menu.hidden = true; else cancel(); }
    });
    tagInput.addEventListener('blur', () => { menu.hidden = true; if (tagInput.value.trim()) addTag(tagInput.value); });

    async function suggestTags() {
      suggestBtn.disabled = true;
      suggestions.replaceChildren(h('span', {}, 'Thinking…'));
      try {
        const r = await api('POST', `/api/links/${l.id}/suggest-tags`, { current: tags });
        const fresh = r.tags.filter((t) => !tags.includes(t));
        suggestions.replaceChildren(...(fresh.length
          ? [...fresh.map((t) => h('button', {
            type: 'button', class: 'tag-chip suggested', title: 'Add this tag',
            onclick: (e) => { addTag(t); e.currentTarget.remove(); },
          }, `+ #${t}`)), h('button', { type: 'button', class: 'tag-chip', onclick: () => { fresh.forEach(addTag); suggestions.replaceChildren(); } }, 'Add all')]
          : [h('span', {}, 'No new tags to suggest.')]));
      } catch (err) {
        suggestions.replaceChildren(h('span', {}, err.message));
      } finally {
        suggestBtn.disabled = false;
      }
    }

    async function save() {
      if (tagInput.value.trim()) addTag(tagInput.value);
      try {
        const updated = await api('PATCH', `/api/links/${l.id}`, { title: title.value, tags, note: note.value, articles: linked });
        Object.assign(l, updated);
        changed();
        L.editing = null;
        render();
        flash(l.id);
      } catch (err) {
        toast(`Couldn’t save: ${err.message}`);
      }
    }
    function cancel() { L.editing = null; render(); }

    drawChips();
    const form = h('form', { class: 'link-edit', onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label', {}, 'Title', title),
      h('label', {}, 'Tags', tagBox),
      h('div', { class: 'tag-suggest' }, suggestBtn, suggestions),
      h('div', { class: 'link-edit-field' }, h('span', {}, 'For articles & thoughts'), h('div', { class: 'article-pick' }, articleChips, articlePick)),
      h('label', {}, 'Note', note),
      h('div', { class: 'link-edit-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
        h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel')));
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target !== tagInput) { e.preventDefault(); e.stopPropagation(); cancel(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });
    const li = h('li', { class: 'link-card', 'data-id': l.id },
      h('div', { class: 'link-icon', 'aria-hidden': 'true' }, (l.site || '•')[0]),
      h('div', { class: 'link-main' },
        h('a', { class: 'link-title', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.url),
        form));
    requestAnimationFrame(() => (l.tags.length ? title : tagInput).focus());
    return li;
  }

  // Let the article's links panel know.
  const changed = () => window.dispatchEvent(new CustomEvent('dbw:links-changed', { detail: 'page' }));
  window.addEventListener('dbw:links-changed', (e) => {
    if (e.detail === 'page') return;
    L.loaded = false;
    if (body.dataset.view === 'links') reload().then(render).catch(() => {});
    else reload().catch(() => {});
  });

  function startEdit(id) {
    L.editing = id;
    renderList();
  }

  // ---------------------------------------------------------------------------
  // Actions

  function toggleTag(tag) {
    if (L.tags.has(tag)) L.tags.delete(tag); else L.tags.add(tag);
    saveFilter();
    render();
    $('#links-list').scrollTop = 0;
  }
  const saveFilter = () => { prefs.set('link-tags', [...L.tags]); prefs.set('link-article', L.article); };

  function flash(id) {
    const node = $(`.link-card[data-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  async function add(raw) {
    const url = String(raw || '').trim();
    if (!url) { $('#link-url').focus(); return; }
    const btn = $('#link-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const link = await api('POST', '/api/links', { url });
      L.items.unshift(link);
      changed();
      $('#link-url').value = '';
      L.tags.clear(); // make sure the new link is visible
      L.q = '';
      $('#link-search').value = '';
      saveFilter();
      updateCount();
      L.editing = link.id; // straight into tagging
      render();
      toast(`Saved “${link.title}” — add some tags`);
    } catch (err) {
      if (err.status === 409 && err.data?.link) {
        L.tags.clear();
        L.q = '';
        $('#link-search').value = '';
        render();
        flash(err.data.link.id);
        toast('You’ve already saved this link — here it is');
        $('#link-url').value = '';
      } else {
        toast(`Couldn’t save the link: ${err.message}`);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save link';
    }
  }

  async function remove(l) {
    try {
      await api('DELETE', `/api/links/${l.id}`);
      L.items = L.items.filter((x) => x.id !== l.id);
      changed();
      updateCount();
      render();
      clearTimeout(L.undo?.timer);
      const bar = $('#links-undo');
      bar.querySelector('span').textContent = `Deleted “${l.title}”.`;
      bar.hidden = false;
      L.undo = { link: l, timer: setTimeout(() => { bar.hidden = true; L.undo = null; }, 8000) };
    } catch (err) {
      toast(`Couldn’t delete: ${err.message}`);
    }
  }

  async function undoDelete() {
    const u = L.undo;
    if (!u) return;
    clearTimeout(u.timer);
    $('#links-undo').hidden = true;
    L.undo = null;
    try {
      await api('POST', '/api/links/restore', { link: u.link });
      await reload();
      changed();
      render();
      flash(u.link.id);
    } catch (err) {
      toast(`Couldn’t restore: ${err.message}`);
    }
  }

  async function copy(l) {
    try {
      await navigator.clipboard.writeText(l.url);
      toast('Link copied');
    } catch {
      toast('Clipboard not available');
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring

  $('#link-add').addEventListener('submit', (e) => { e.preventDefault(); add($('#link-url').value); });
  $('#link-search').addEventListener('input', (e) => { L.q = e.target.value; renderFilter(); renderList(); });
  $('#links-undo button').addEventListener('click', undoDelete);

  // ⌘V anywhere on the Links page (outside a text field) saves the link on the clipboard.
  document.addEventListener('paste', (e) => {
    if (body.dataset.view !== 'links') return;
    const target = e.target;
    if (target.closest?.('input, textarea, [contenteditable]')) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!looksLikeUrl(text)) return;
    e.preventDefault();
    add(text);
  });

  window.addEventListener('dbw:view', async (e) => {
    if (e.detail !== 'links') return;
    try {
      if (!L.loaded) await reload();
      render();
    } catch (err) {
      toast(`Couldn’t load links: ${err.message}`);
    }
  });
  window.addEventListener('focus', () => {
    if (body.dataset.view === 'links' && !L.editing) reload().then(render).catch(() => {});
  });

  reload().catch(() => {}); // for the tab's count
})();
