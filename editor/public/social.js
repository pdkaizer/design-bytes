/* DB Writer — Social: posts for LinkedIn, X, Bluesky, Mastodon and Instagram. */
(() => {
  'use strict';

  const { api, toast, prefs } = window.dbw;
  const $ = (sel, root = document) => root.querySelector(sel);
  const body = document.body;
  const pieces = () => window.dbw.articles(); // articles and thoughts: [{ slug (key), title, status, kind }]
  const pieceTitle = (key) => pieces().find((a) => a.slug === key)?.title;
  const enc = encodeURIComponent;

  const MASTODON = 'toad.social'; // your Mastodon server (@pdkaizer@toad.social)
  const URLS = /https?:\/\/\S+/g;

  // Each network: its limit, how it counts, and how to open its composer.
  const NETWORKS = {
    linkedin: { name: 'LinkedIn', limit: 3000, open: (t) => `https://www.linkedin.com/feed/?shareActive=true&text=${enc(t)}` },
    x: { name: 'X', limit: 280, urlLength: 23, open: (t) => `https://x.com/intent/post?text=${enc(t)}` },
    bluesky: { name: 'Bluesky', limit: 300, graphemes: true, open: (t) => `https://bsky.app/intent/compose?text=${enc(t)}` },
    mastodon: { name: 'Mastodon', limit: 500, urlLength: 23, open: (t) => `https://${MASTODON}/share?text=${enc(t)}` },
    instagram: { name: 'Instagram', limit: 2200, hashtags: 30, open: null }, // no web composer — the caption is copied
  };
  const ORDER = Object.keys(NETWORKS);
  const STATUS = { draft: 'Draft', ready: 'Ready', posted: 'Posted' };

  function length(net, text) {
    const N = NETWORKS[net];
    const t = N.urlLength ? text.replace(URLS, 'x'.repeat(N.urlLength)) : text;
    if (N.graphemes && Intl.Segmenter) return [...new Intl.Segmenter().segment(t)].length;
    return [...t].length;
  }
  const textFor = (post, net) => post.versions?.[net] || post.text || '';
  const overBy = (net, text) => length(net, text) - NETWORKS[net].limit;
  const tooManyTags = (net, text) => NETWORKS[net].hashtags && (text.match(/#[\p{L}\p{N}_]+/gu) || []).length > NETWORKS[net].hashtags;

  // Saved links and quotes, for sharing them in a post.
  const lib = { links: [], quotes: [], loaded: 0 };
  async function loadLibrary(force = false) {
    if (!force && Date.now() - lib.loaded < 15000) return lib;
    const [links, quotes] = await Promise.allSettled([api('GET', '/api/links'), api('GET', '/api/quotes')]);
    if (links.status === 'fulfilled') lib.links = links.value;
    if (quotes.status === 'fulfilled') lib.quotes = quotes.value;
    lib.loaded = Date.now();
    return lib;
  }
  const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());
  // Shared addresses drop tracking codes (utm_…, newsletter and click IDs); Substack
  // links lose their whole query string, which is only ever email tracking.
  function cleanUrl(raw) {
    try {
      const u = new URL(raw);
      if (/(^|\.)substack\.com$/.test(u.hostname)) u.search = '';
      for (const k of [...u.searchParams.keys()]) {
        if (/^(utm_|mc_|fbclid$|gclid$|igshid$|mkt_tok$|ref_src$|triedRedirect$|isFreemail$)/i.test(k)) u.searchParams.delete(k);
      }
      return u.href;
    } catch {
      return raw;
    }
  }
  // A link reads as its title, then its address.
  const linkText = (l) => `${l.title && l.title !== l.url ? `${l.title}\n` : ''}${cleanUrl(l.url)}`;
  // A quote reads as “The words.” — Person, Source (plus the source's address when it's a link).
  function quoteText(q) {
    const who = [q.author || '', q.source && !isUrl(q.source) ? q.source : ''].filter(Boolean).join(', ');
    return `“${q.text}”${who ? `\n— ${who}` : ''}${isUrl(q.source) ? `\n${cleanUrl(q.source.trim())}` : ''}`;
  }
  function sharedLabel(p) {
    if (!p.shares) return null;
    const item = p.shares.type === 'link' ? lib.links.find((l) => l.id === p.shares.id) : lib.quotes.find((q) => q.id === p.shares.id);
    if (!item) return `Shares a saved ${p.shares.type}`;
    return p.shares.type === 'link' ? `Shares a saved link: ${item.title || item.url}` : `Shares a saved quote${item.author ? ` by ${item.author}` : ''}`;
  }

  const S = {
    items: [],
    loaded: false,
    status: prefs.get('social-status', ''),
    network: prefs.get('social-network', ''),
    piece: prefs.get('social-piece', ''),
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
  const dateLabel = (ms) => new Date(ms).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(new Date(ms).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  });
  const changed = () => window.dispatchEvent(new CustomEvent('dbw:social-changed'));

  // ---------------------------------------------------------------------------
  // The composer — used to write a new post and to edit one

  function composer(post, { onSave, onCancel, prefill }) {
    const p = {
      text: post?.text || prefill?.text || '',
      shares: post?.shares || prefill?.shares || null,
      versions: { ...(post?.versions || {}) },
      networks: post ? [...post.networks] : prefs.get('social-last-networks', ['linkedin', 'bluesky', 'mastodon']),
      status: post?.status || 'draft',
      articles: [...(post?.articles || [])],
      note: post?.note || '',
    };
    const open = new Set(Object.keys(p.versions)); // networks with their own version showing

    const shared = h('textarea', { placeholder: 'Write the post — this shared draft goes to every network you pick, unless you give one its own version.', 'aria-label': 'Post' });
    shared.value = p.text;
    const toggles = h('div', { class: 'net-row', role: 'group', 'aria-label': 'Networks' });
    const versionsBox = h('div', { class: 'social-form' });
    const hint = h('div', { class: 'social-hint' });
    const forBox = h('div', { class: 'article-pick' });
    const status = h('select', { 'aria-label': 'Status' }, ...Object.entries(STATUS).map(([v, label]) => h('option', { value: v }, label)));
    status.value = p.status;
    const linkBtn = h('button', { type: 'button', class: 'linkish', hidden: true }, '+ Insert link to the thought');

    // Insert a saved link or quote into the draft at the cursor.
    const pickInput = h('input', { placeholder: 'Insert a saved link or quote…', 'aria-label': 'Insert a saved link or quote', autocomplete: 'off', spellcheck: 'false' });
    const pickMenu = h('div', { class: 'tag-menu', hidden: true });
    let pick = 0;
    const insertAtCursor = (insert) => {
      const at = shared.selectionStart ?? shared.value.length;
      const end = shared.selectionEnd ?? at;
      const before = shared.value.slice(0, at);
      const after = shared.value.slice(end);
      const text = `${before && !/\n\n$/.test(before) ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${insert}${after && !/^\n/.test(after) ? '\n\n' : ''}`;
      shared.setRangeText(text, at, end, 'end');
      shared.dispatchEvent(new Event('input'));
      shared.focus();
    };
    function pickOptions() {
      const words = pickInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const match = (...f) => words.every((w) => f.join(' ').toLowerCase().includes(w));
      return [
        ...lib.quotes.filter((q) => match(q.text, q.author, q.source)).map((q) => ({ type: 'quote', item: q })),
        ...lib.links.filter((l) => match(l.title, l.url, l.site, (l.tags || []).join(' '))).map((l) => ({ type: 'link', item: l })),
      ].slice(0, 10);
    }
    function drawPick() {
      const options = pickOptions();
      pick = Math.min(pick, Math.max(0, options.length - 1));
      pickMenu.hidden = document.activeElement !== pickInput;
      pickMenu.replaceChildren(...(options.length ? options.map((o, i) => h('button', {
        type: 'button', class: i === pick ? 'on' : '', onmousedown: (e) => { e.preventDefault(); choose(o); },
      }, o.type === 'quote'
        ? [h('span', {}, `“${o.item.text.slice(0, 80)}${o.item.text.length > 80 ? '…' : ''}”`), h('small', {}, `Quote · ${o.item.author || 'Unknown'}`)]
        : [h('span', {}, o.item.title || o.item.url), h('small', {}, `Link · ${o.item.url}`)])) : [h('button', { type: 'button', disabled: true }, lib.links.length || lib.quotes.length ? 'Nothing matches' : 'No saved links or quotes yet')]));
      return options;
    }
    function choose(o) {
      insertAtCursor(o.type === 'quote' ? quoteText(o.item) : linkText(o.item));
      if (!p.shares) p.shares = { type: o.type, id: o.item.id };
      pickInput.value = '';
      pickMenu.hidden = true;
    }
    pickInput.addEventListener('focus', async () => { await loadLibrary(); drawPick(); });
    pickInput.addEventListener('input', () => { pick = 0; drawPick(); });
    pickInput.addEventListener('blur', () => { pickMenu.hidden = true; });
    pickInput.addEventListener('keydown', (e) => {
      const options = drawPick();
      if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); pick = (pick + 1) % options.length; drawPick(); }
      else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); pick = (pick - 1 + options.length) % options.length; drawPick(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (options[pick]) choose(options[pick]); }
      else if (e.key === 'Escape') { e.stopPropagation(); pickMenu.hidden = true; }
    });
    const pickBox = h('div', { class: 'art-links-add social-pick' }, pickInput, pickMenu);

    function counter(net) {
      const t = p.versions[net] || shared.value;
      const n = length(net, t);
      const over = n > NETWORKS[net].limit || tooManyTags(net, t);
      return h('span', { class: `count${over ? ' over' : ''}`, title: tooManyTags(net, t) ? `More than ${NETWORKS[net].hashtags} hashtags` : '' }, `${n}/${NETWORKS[net].limit}`);
    }

    function drawToggles() {
      toggles.replaceChildren(...ORDER.map((net) => h('button', {
        type: 'button', class: 'net-toggle', 'aria-pressed': String(p.networks.includes(net)),
        onclick: () => {
          if (p.networks.includes(net)) p.networks = p.networks.filter((n) => n !== net);
          else p.networks = ORDER.filter((n) => n === net || p.networks.includes(n));
          drawAll();
        },
      }, NETWORKS[net].name, p.networks.includes(net) ? counter(net) : null)));
    }

    function drawVersions() {
      // One line offering a separate version for each picked network that doesn't have one yet.
      const offer = p.networks.filter((net) => !open.has(net));
      const offerRow = offer.length ? h('div', { class: 'social-row' }, h('span', { class: 'social-hint' }, open.size ? 'Own version for' : 'Write a separate version for'),
        ...offer.map((net, i) => [i ? h('span', { class: 'social-hint' }, '·') : null, h('button', {
          type: 'button', class: 'linkish', title: `A version just for ${NETWORKS[net].name}, starting from the shared draft`,
          onclick: () => { open.add(net); p.versions[net] = p.versions[net] || shared.value; drawAll(); versionsBox.querySelector(`[data-net="${net}"]`)?.focus(); },
        }, NETWORKS[net].name)])) : null;
      versionsBox.replaceChildren(...p.networks.filter((net) => open.has(net)).map((net) => {
        const area = h('textarea', { 'data-net': net, 'aria-label': `${NETWORKS[net].name} version`, placeholder: `Leave empty to use the shared draft on ${NETWORKS[net].name}` });
        area.value = p.versions[net] || '';
        let count = counter(net);
        area.addEventListener('input', () => {
          p.versions[net] = area.value;
          const next = counter(net);
          count.replaceWith(next);
          count = next;
          drawToggles();
          drawHint();
        });
        return h('div', { class: 'net-version' },
          h('div', { class: 'net-version-head' }, `${NETWORKS[net].name} version`,
            h('button', { type: 'button', class: 'linkish', onclick: () => { open.delete(net); delete p.versions[net]; drawAll(); } }, 'Use the shared draft instead'),
            count),
          area);
      }), ...(offerRow ? [offerRow] : []));
    }

    function drawHint() {
      const problems = p.networks.filter((net) => overBy(net, p.versions[net] || shared.value) > 0 || tooManyTags(net, p.versions[net] || shared.value));
      hint.className = `social-hint${problems.length ? ' warn' : ''}`;
      hint.textContent = !p.networks.length
        ? 'Pick at least one network.'
        : problems.length
          ? `Too long for ${problems.map((n) => NETWORKS[n].name).join(' and ')} — shorten it or write a version just for ${problems.length > 1 ? 'them' : 'it'}.`
          : '';
    }

    function drawFor() {
      const order = { backlog: 0, editing: 1, final: 2, published: 3 };
      const options = pieces().filter((a) => !p.articles.includes(a.slug))
        .sort((a, b) => order[a.status] - order[b.status] || a.title.localeCompare(b.title));
      const select = h('select', { 'aria-label': 'What this post is for' },
        h('option', { value: '' }, p.articles.length ? '+ Another…' : '+ Promotes an article or thought…'),
        ...options.map((a) => h('option', { value: a.slug }, `${a.kind === 'thoughts' ? 'Thought: ' : ''}${a.title}`)));
      select.hidden = !options.length;
      select.addEventListener('change', () => { if (select.value) { p.articles.push(select.value); drawFor(); } });
      forBox.replaceChildren(...p.articles.filter(pieceTitle).map((key) => h('button', {
        type: 'button', class: 'tag-chip', title: 'Remove', onclick: () => { p.articles.splice(p.articles.indexOf(key), 1); drawFor(); },
      }, pieceTitle(key), h('span', { class: 'x' }, '×'))), select);
      // Thoughts live at peterkaizer.com/thoughts/<slug>/, so their link can be dropped in.
      const thought = p.articles.find((k) => k.startsWith('thoughts/'));
      linkBtn.hidden = !thought;
      linkBtn.onclick = () => {
        const url = `https://peterkaizer.com/thoughts/${thought.slice(9)}/`;
        const at = shared.selectionStart ?? shared.value.length;
        const before = shared.value.slice(0, at);
        const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${url}`;
        shared.setRangeText(insert, at, shared.selectionEnd ?? at, 'end');
        shared.dispatchEvent(new Event('input'));
        shared.focus();
      };
    }

    function drawAll() { drawToggles(); drawVersions(); drawHint(); drawFor(); }
    shared.addEventListener('input', () => { drawToggles(); drawHint(); });

    async function save() {
      p.text = shared.value;
      p.status = status.value;
      for (const net of Object.keys(p.versions)) if (!open.has(net) || !p.versions[net].trim() || p.versions[net] === p.text) delete p.versions[net];
      if (!p.text.trim() && !Object.keys(p.versions).length) { shared.focus(); toast('Write the post first'); return; }
      if (!p.networks.length) { toast('Pick at least one network'); return; }
      prefs.set('social-last-networks', p.networks);
      await onSave({ text: p.text, versions: p.versions, networks: p.networks, status: p.status, articles: p.articles, shares: p.shares });
    }

    drawAll();
    const form = h('form', { class: 'social-form', onsubmit: (e) => { e.preventDefault(); save(); } },
      shared,
      toggles,
      hint,
      versionsBox,
      pickBox,
      h('div', { class: 'social-row' }, h('span', { class: 'social-hint' }, 'For'), forBox, linkBtn),
      h('div', { class: 'social-row' },
        status,
        h('span', { class: 'grow' }),
        onCancel ? h('button', { class: 'btn', type: 'button', onclick: onCancel }, 'Cancel') : null,
        h('button', { class: 'btn primary', type: 'submit' }, post ? 'Save' : 'Save post')));
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
    });
    form.focusText = () => shared.focus();
    return form;
  }

  function drawCompose(prefill) {
    const form = composer(null, {
      prefill,
      onSave: async (data) => {
        try {
          const post = await api('POST', '/api/social', data);
          S.items.unshift(post);
          changed();
          updateCount();
          drawCompose();
          S.status = ''; S.network = ''; S.piece = ''; S.q = ''; $('#social-search').value = ''; saveFilter();
          render();
          flash(post.id);
          toast('Post saved');
        } catch (err) {
          toast(`Couldn’t save the post: ${err.message}`);
        }
      },
    });
    $('#social-compose').replaceChildren(form);
    return form;
  }

  // ---------------------------------------------------------------------------
  // Loading & rendering the list

  async function reload() {
    S.items = await api('GET', '/api/social');
    S.loaded = true;
    updateCount();
  }
  function updateCount() {
    const n = $('#view-tabs [data-view="social"] .count');
    if (n) n.textContent = S.items.length;
  }
  const saveFilter = () => { prefs.set('social-status', S.status); prefs.set('social-network', S.network); prefs.set('social-piece', S.piece); };

  function shown() {
    const words = S.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return S.items.filter((p) =>
      (!S.status || p.status === S.status) &&
      (!S.network || p.networks.includes(S.network)) &&
      (!S.piece || (p.articles || []).includes(S.piece)) &&
      words.every((w) => [p.text, ...Object.values(p.versions || {}), p.note].join(' ').toLowerCase().includes(w)));
  }

  function render() { renderSide(); renderFilter(); renderList(); }

  function renderSide() {
    const row = (label, n, pressed, onclick) => h('button', { class: 'tag-row', 'aria-pressed': String(pressed), onclick },
      h('span', { class: 'name' }, label), h('span', { class: 'n' }, n));
    const set = (key, value) => () => { S[key] = S[key] === value ? '' : value; saveFilter(); render(); };
    const side = $('#social-side');
    side.replaceChildren(
      row('All posts', S.items.length, !S.status && !S.network && !S.piece, () => { S.status = ''; S.network = ''; S.piece = ''; saveFilter(); render(); }),
      h('h3', {}, 'Status'),
      ...Object.entries(STATUS).map(([s, label]) => row(label, S.items.filter((p) => p.status === s).length, S.status === s, set('status', s))),
      h('h3', {}, 'Networks'),
      ...ORDER.map((net) => row(NETWORKS[net].name, S.items.filter((p) => p.networks.includes(net)).length, S.network === net, set('network', net))),
    );
    const perPiece = new Map();
    for (const p of S.items) for (const key of p.articles || []) if (pieceTitle(key)) perPiece.set(key, (perPiece.get(key) || 0) + 1);
    if (perPiece.size) {
      side.append(h('h3', {}, 'Promoting'), ...[...perPiece].map(([key, n]) => row(pieceTitle(key), n, S.piece === key, set('piece', key))));
    }
  }

  function renderFilter() {
    const box = $('#social-filter');
    if (S.piece && !pieceTitle(S.piece)) S.piece = '';
    box.hidden = !S.status && !S.network && !S.piece;
    if (box.hidden) return;
    const chip = (label, clear) => h('button', { class: 'tag-chip on', title: 'Remove this filter', onclick: () => { clear(); saveFilter(); render(); } }, label, h('span', { class: 'x' }, '×'));
    box.replaceChildren(...[
      `Showing ${shown().length}`,
      S.status ? chip(STATUS[S.status], () => { S.status = ''; }) : null,
      S.network ? chip(`on ${NETWORKS[S.network].name}`, () => { S.network = ''; }) : null,
      S.piece ? chip(`for “${pieceTitle(S.piece)}”`, () => { S.piece = ''; }) : null,
      h('button', { class: 'tag-chip', onclick: () => { S.status = ''; S.network = ''; S.piece = ''; saveFilter(); render(); } }, 'Clear'),
    ].filter((x) => x != null));
  }

  function renderList() {
    const list = $('#social-list');
    const items = shown();
    if (!items.length) {
      list.replaceChildren(h('li', { class: 'links-empty' }, !S.items.length
        ? 'No posts yet. Write one above, pick its networks, and use “Open in …” when you’re ready to post.'
        : 'No posts match. Try a different filter or search.'));
      return;
    }
    list.replaceChildren(...items.map((p) => (p.id === S.editing ? editCard(p) : card(p))));
  }

  function card(p) {
    const custom = Object.keys(p.versions || {}).filter((n) => p.networks.includes(n));
    return h('li', { class: 'post-card', 'data-id': p.id },
      h('div', { class: 'post-main' },
        h('div', { class: 'post-top' },
          h('span', { class: 'post-status', 'data-s': p.status }, STATUS[p.status]),
          h('span', { class: 'social-hint' }, `Added ${dateLabel(p.created)}`),
          (p.articles || []).filter(pieceTitle).map((key) => h('button', { class: 'article-chip', title: 'Open it', onclick: () => window.dbw.openArticle(key) }, pieceTitle(key)))),
        h('p', { class: 'post-text' }, p.text || textFor(p, p.networks[0])),
        custom.length ? h('div', { class: 'post-sub' }, `Own version for ${custom.map((n) => NETWORKS[n].name).join(', ')}`) : null,
        p.shares ? h('div', { class: 'post-sub' }, sharedLabel(p)) : null,
        h('div', { class: 'post-nets' }, ...p.networks.map((net) => {
          const t = textFor(p, net);
          const n = length(net, t);
          const over = n > NETWORKS[net].limit || tooManyTags(net, t);
          const posted = p.posted?.[net];
          return h('div', { class: 'post-net' },
            h('span', { class: 'name' }, NETWORKS[net].name),
            h('button', { class: 'btn', title: NETWORKS[net].open ? `Opens ${NETWORKS[net].name} with the text filled in (it’s copied too)` : 'Instagram has no web composer — this copies the caption and opens Instagram', onclick: () => openIn(p, net) },
              NETWORKS[net].open ? `Open in ${NETWORKS[net].name}` : 'Copy caption & open Instagram'),
            h('span', { class: `len${over ? ' over' : ''}` }, `${n}/${NETWORKS[net].limit}${over ? ' — too long' : ''}`),
            posted
              ? [h('span', { class: 'done' }, `✓ Posted ${dateLabel(posted)}`), h('button', { class: 'mark', onclick: () => setPosted(p, net, false) }, 'Undo')]
              : h('button', { class: 'mark', onclick: () => setPosted(p, net, true) }, 'Mark as posted'));
        }))),
      h('div', { class: 'link-actions' },
        h('button', { class: 'icon-btn', title: 'Copy the shared draft', 'aria-label': 'Copy', html: ICONS.copy, onclick: () => copy(p.text || textFor(p, p.networks[0])) }),
        h('button', { class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit', html: ICONS.edit, onclick: () => { S.editing = p.id; renderList(); } }),
        h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', html: ICONS.trash, onclick: () => remove(p) })));
  }

  function editCard(p) {
    const form = composer(p, {
      onSave: async (data) => {
        try {
          Object.assign(p, await api('PATCH', `/api/social/${p.id}`, data));
          S.editing = null;
          changed();
          render();
          flash(p.id);
        } catch (err) {
          toast(`Couldn’t save: ${err.message}`);
        }
      },
      onCancel: () => { S.editing = null; renderList(); },
    });
    requestAnimationFrame(() => form.focusText());
    return h('li', { class: 'post-card', 'data-id': p.id }, h('div', { class: 'post-main' }, form));
  }

  function flash(id) {
    const node = $(`.post-card[data-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  // ---------------------------------------------------------------------------
  // Posting, copying, deleting

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function openIn(p, net) {
    const N = NETWORKS[net];
    const t = textFor(p, net);
    if (overBy(net, t) > 0) toast(`Heads up: it’s ${overBy(net, t)} over ${N.name}’s limit`);
    // Open first (browsers only allow pop-ups straight from a click), then copy as a backup.
    const win = window.open(N.open ? N.open(t) : 'https://www.instagram.com/', '_blank');
    if (win) win.opener = null; // the network's page can't reach back into DB Writer
    const copied = await copy(t);
    if (!win) toast(`Your browser blocked the new tab — the text is ${copied ? 'copied' : 'below'}; open ${N.name} yourself`);
    else if (!N.open) toast(copied ? 'Caption copied — paste it into a new Instagram post with your image' : 'Couldn’t copy the caption');
    else toast(`Opened ${N.name}${copied ? ' — the text is copied too, in case it doesn’t fill in' : ''}. Mark it as posted once it’s up.`);
  }

  async function setPosted(p, net, on) {
    const posted = { ...(p.posted || {}) };
    if (on) posted[net] = Date.now(); else delete posted[net];
    try {
      Object.assign(p, await api('PATCH', `/api/social/${p.id}`, { posted }));
      changed();
      render();
      if (on && p.status === 'posted') toast('Posted everywhere it was meant for 🎉');
    } catch (err) {
      toast(`Couldn’t update: ${err.message}`);
    }
  }

  async function remove(p) {
    try {
      await api('DELETE', `/api/social/${p.id}`);
      S.items = S.items.filter((x) => x.id !== p.id);
      changed();
      updateCount();
      render();
      clearTimeout(S.undo?.timer);
      const bar = $('#social-undo');
      bar.querySelector('span').textContent = 'Deleted the post.';
      bar.hidden = false;
      S.undo = { post: p, timer: setTimeout(() => { bar.hidden = true; S.undo = null; }, 8000) };
    } catch (err) {
      toast(`Couldn’t delete: ${err.message}`);
    }
  }

  $('#social-undo button').addEventListener('click', async () => {
    const u = S.undo;
    if (!u) return;
    clearTimeout(u.timer);
    $('#social-undo').hidden = true;
    S.undo = null;
    try {
      await api('POST', '/api/social/restore', { post: u.post });
      await reload();
      changed();
      render();
      flash(u.post.id);
    } catch (err) {
      toast(`Couldn’t restore: ${err.message}`);
    }
  });
  $('#social-search').addEventListener('input', (e) => { S.q = e.target.value; renderFilter(); renderList(); });

  window.addEventListener('dbw:view', async (e) => {
    if (e.detail !== 'social') return;
    try {
      if (!S.loaded) await reload();
      await loadLibrary();
      if (!$('#social-compose').firstChild) drawCompose();
      render();
    } catch (err) {
      toast(`Couldn’t load posts: ${err.message}`);
    }
  });
  window.addEventListener('focus', () => {
    if (body.dataset.view === 'social' && !S.editing) reload().then(render).catch(() => {});
  });
  window.dbw.focusSocialComposer = () => ($('#social-compose').firstChild || drawCompose()).focusText();

  // Share a saved link or quote: opens Social with a new draft already written.
  window.dbw.shareToSocial = async (type, item) => {
    window.dbw.setView('social');
    if (!S.loaded) await reload().catch(() => {});
    loadLibrary(true);
    const form = drawCompose({ text: type === 'quote' ? quoteText(item) : linkText(item), shares: { type, id: item.id } });
    render();
    $('#social-list').scrollTop = 0;
    requestAnimationFrame(() => form.focusText());
    toast(`Drafted a post sharing this ${type} — pick your networks and save it`);
  };

  reload().catch(() => {}); // for the tab's count
})();
