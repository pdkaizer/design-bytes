/* DB Writer — Home: the entry page with writing stats, recent work and every collection. */
(() => {
  'use strict';

  const { api, toast } = window.dbw;
  const dbw = window.dbw;
  const $ = (sel, root = document) => root.querySelector(sel);
  const body = document.body;

  const STATUS = { backlog: 'Backlog', editing: 'Editing', final: 'Final', published: 'Published' };
  const KIND = { articles: 'Article', thoughts: 'Thought', notes: 'Quick note', journal: 'Journal' };
  const H = { links: [], quotes: [], social: [], stats: null, activity: null };
  const NETS = { linkedin: 'LinkedIn', x: 'X', bluesky: 'Bluesky', mastodon: 'Mastodon', instagram: 'Instagram' };
  const POST_STATUS = { draft: 'Draft', ready: 'Ready', posted: 'Posted' };

  const h = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };
  const rel = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  function ago(ms) {
    const s = (ms - Date.now()) / 1000;
    for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(s) >= size) return rel.format(Math.round(s / size), unit);
    }
    return 'just now';
  }
  const num = (n) => n.toLocaleString('en-US');
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

  // ---------------------------------------------------------------------------
  // Stats

  function delta(now, before, unit) {
    if (before == null) return null;
    const diff = now - before;
    if (!diff) return h('div', { class: 'stat-delta' }, `Same as the previous 7 days`);
    const up = diff > 0;
    return h('div', { class: 'stat-delta' },
      h('span', { class: up ? 'up' : 'down' }, `${up ? '▲' : '▼'} ${num(Math.abs(diff))}${unit}`),
      ` ${up ? 'more' : 'fewer'} than the previous 7 days`);
  }

  function renderStats() {
    const s = H.stats;
    const box = $('#home-stats');
    if (!s) { box.replaceChildren(); return; }
    const tile = (label, value, extra) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, ...value), extra);
    box.replaceChildren(
      tile('Words written, last 7 days', [num(s.words)], delta(s.words, s.wordsBefore, ' words')),
      tile('Days you wrote', [String(s.days), h('small', {}, ' of 7')], delta(s.days, s.daysBefore, s.days - s.daysBefore === 1 || s.days - s.daysBefore === -1 ? ' day' : ' days')),
      tile('In progress', [String(s.inProgress)], h('div', { class: 'stat-delta' }, 'Backlog and Editing')),
      tile('Ready to publish', [String(s.ready)], h('div', { class: 'stat-delta' }, `${num(s.published)} published so far`)),
    );
  }

  // ---------------------------------------------------------------------------
  // Activity graph — words written per day for the last 53 weeks

  // Shade by words written; a day with only edits or saves still shows as active.
  const level = (d) => (d.words >= 800 ? 4 : d.words >= 400 ? 3 : d.words >= 150 ? 2 : d.words > 0 || d.pieces || d.links || d.quotes || d.posts ? 1 : 0);
  const longDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

  function describe(d) {
    const parts = [];
    if (d.words) parts.push(`${plural(d.words, 'word')} written`);
    if (d.pieces) parts.push(`worked on ${plural(d.pieces, 'piece')}`);
    const saved = [d.links && plural(d.links, 'link'), d.quotes && plural(d.quotes, 'quote'), d.posts && plural(d.posts, 'social post')].filter(Boolean);
    if (saved.length) parts.push(`saved ${saved.join(', ')}`);
    return parts.length ? parts.join(' · ') : 'No activity';
  }

  function streaks(days) {
    let longest = 0;
    let run = 0;
    for (const d of days) { run = level(d) ? run + 1 : 0; longest = Math.max(longest, run); }
    // The current streak can include today or end yesterday (today isn't over yet).
    let current = 0;
    const lastIndex = days.length - 1;
    for (let i = level(days[lastIndex]) ? lastIndex : lastIndex - 1; i >= 0 && level(days[i]); i--) current++;
    return { longest, current };
  }

  function renderActivity() {
    const a = H.activity;
    const graph = $('#activity-graph');
    $('#home-activity').hidden = !a;
    if (!a) return;
    const weeks = Math.ceil(a.days.length / 7);
    graph.style.setProperty('--weeks', weeks);
    const nodes = [];
    // Month labels above the first column that starts in that month.
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const first = a.days[w * 7];
      const m = new Date(`${first.date}T12:00`).getMonth();
      if (m !== lastMonth && (w > 0 || new Date(`${first.date}T12:00`).getDate() <= 7)) {
        nodes.push(h('span', { class: 'month', style: `grid-column: ${w + 2} / span 4` }, new Date(`${first.date}T12:00`).toLocaleDateString('en-US', { month: 'short' })));
      }
      lastMonth = m;
    }
    ['', 'Mon', '', 'Wed', '', 'Fri', ''].forEach((label, i) => nodes.push(h('span', { class: 'wd', style: `grid-row: ${i + 2}` }, label)));
    const todayIndex = a.days.length - 1;
    a.days.forEach((d, i) => {
      nodes.push(h('span', {
        class: `cell l${level(d)}${i === todayIndex ? ' today' : ''}`,
        style: `grid-column: ${Math.floor(i / 7) + 2}; grid-row: ${(i % 7) + 2}`,
        'data-i': i,
      }));
    });
    graph.replaceChildren(...nodes);
    graph.setAttribute('role', 'img');
    const total = a.days.reduce((s, d) => s + d.words, 0);
    const activeDays = a.days.filter((d) => level(d)).length;
    const { longest, current } = streaks(a.days);
    graph.setAttribute('aria-label', `Writing activity for the last year: ${plural(total, 'word')} written on ${plural(activeDays, 'day')}. Details are in the table below.`);
    $('#activity-summary').textContent = `${plural(total, 'word')} in the last year · ${plural(activeDays, 'active day')} · current streak ${plural(current, 'day')} · longest ${plural(longest, 'day')}`;

    // The same data as a table, for screen readers and anyone who prefers numbers.
    const rows = a.days.filter((d) => level(d)).reverse();
    $('#activity-table').replaceChildren(rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ...['Date', 'Words', 'Pieces', 'Links', 'Quotes', 'Posts'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, ...rows.map((d) => h('tr', {}, h('td', {}, longDate(d.date)), ...[d.words, d.pieces, d.links, d.quotes, d.posts].map((n) => h('td', {}, n ? num(n) : '–'))))))
      : h('p', { class: 'home-empty' }, 'No activity yet.'));
    // Start scrolled to the most recent weeks on narrow screens.
    requestAnimationFrame(() => { const scroller = $('.activity-scroll'); scroller.scrollLeft = scroller.scrollWidth; });
  }

  const tip = $('#activity-tip');
  $('#activity-graph').addEventListener('pointerover', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || !H.activity) return;
    const d = H.activity.days[cell.dataset.i];
    tip.replaceChildren(h('b', {}, longDate(d.date)), h('br'), describe(d));
    tip.hidden = false;
    const r = cell.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`;
  });
  $('#activity-graph').addEventListener('pointerleave', () => { tip.hidden = true; });
  $('.activity-scroll').addEventListener('scroll', () => { tip.hidden = true; });

  // ---------------------------------------------------------------------------
  // Recent work and collections

  function docMeta(d, kind) {
    const bits = [];
    if (d.status) bits.push(STATUS[d.status]);
    if (kind === 'thoughts' && d.category) bits.push(d.category);
    bits.push(`${num(d.words)} words`, `edited ${ago(d.mtime)}`);
    return bits.join(' · ');
  }

  function renderContinue() {
    const { articles, thoughts, notes, journal } = dbw.lists();
    const recent = [
      ...articles.map((d) => ({ d, kind: 'articles' })),
      ...thoughts.map((d) => ({ d, kind: 'thoughts' })),
      ...notes.map((d) => ({ d, kind: 'notes' })),
      ...journal.map((d) => ({ d, kind: 'journal' })),
    ].sort((a, b) => b.d.mtime - a.d.mtime).slice(0, 4);
    $('#home-continue').hidden = !recent.length;
    $('#continue-row').replaceChildren(...recent.map(({ d, kind }) => h('button', {
      class: 'continue-card', onclick: () => dbw.openDoc(kind, d.slug),
    }, h('span', { class: 'kind' }, KIND[kind]), h('span', { class: 'title' }, d.title), h('span', { class: 'meta' }, docMeta(d, kind)))));
  }

  function card(title, count, seeAll, ...content) {
    return h('section', { class: 'home-card' },
      h('h2', {}, title, count != null ? h('span', {}, `· ${count}`) : null, seeAll ? h('button', { class: 'see-all', onclick: seeAll }, 'See all →') : null),
      ...content);
  }

  function docList(kind, items, emptyText) {
    if (!items.length) {
      return h('p', { class: 'home-empty' }, emptyText, ' ', h('button', { onclick: () => dbw.newDoc(kind) }, 'Start one'));
    }
    return h('ul', { class: 'home-list' }, ...items.map((d) => h('li', {}, h('button', {
      class: 'home-item', onclick: () => dbw.openDoc(kind, d.slug),
    }, h('span', { class: 't' }, d.title), h('span', { class: 'm' }, docMeta(d, kind))))));
  }

  // Whether today's entry is written yet, with a button that opens (or starts) it.
  function journalToday(journal) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const today = journal.find((e) => e.slug === `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    return h('p', { class: 'home-empty journal-today' },
      today ? `Today: ${num(today.words)} words.` : 'Nothing for today yet.', ' ',
      h('button', { onclick: () => dbw.newDoc('journal') }, today ? 'Keep writing' : 'Write today’s entry'));
  }

  function statusChips(items) {
    const counts = Object.keys(STATUS).map((s) => [s, items.filter((d) => d.status === s).length]).filter(([, n]) => n);
    return counts.length ? h('div', { class: 'chips' }, ...counts.map(([s, n]) => h('span', { class: 'badge tag-chip', 'data-status': s }, `${STATUS[s]} ${n}`))) : null;
  }

  function renderGrid() {
    const { articles, thoughts, notes, journal } = dbw.lists();
    const byRecent = (list) => [...list].sort((a, b) => b.mtime - a.mtime);
    // Drafts first (what you're working on), then the rest.
    const working = (list) => byRecent(list).sort((a, b) => (a.status === 'published') - (b.status === 'published'));
    $('#home-grid').replaceChildren(
      card('Articles · Design Bytes', articles.length, () => dbw.showList('articles'),
        statusChips(articles), docList('articles', working(articles).slice(0, 6), 'No articles yet.')),
      card('Thoughts · peterkaizer.com', thoughts.length, () => dbw.showList('thoughts'),
        statusChips(thoughts), docList('thoughts', working(thoughts).slice(0, 6), 'No thoughts yet.')),
      card('Quick notes', notes.length, () => dbw.showList('notes'),
        docList('notes', byRecent(notes).slice(0, 5), 'Nothing jotted down yet.')),
      card('Journal', journal.length, () => dbw.showList('journal'),
        journalToday(journal), docList('journal', [...journal].sort((a, b) => (a.slug < b.slug ? 1 : -1)).slice(0, 5), 'No entries yet.')),
      card('Links', H.links.length, () => dbw.setView('links'),
        H.links.length
          ? h('ul', { class: 'home-list' }, ...H.links.slice(0, 5).map((l) => h('li', {}, h('a', {
            class: 'home-item', href: l.url, target: '_blank', rel: 'noopener noreferrer',
          }, h('span', { class: 't' }, l.title || l.url), h('span', { class: 'm' }, [host(l.url), ...(l.tags || []).map((t) => `#${t}`)].join(' · '))))))
          : h('p', { class: 'home-empty' }, 'No saved links yet.', ' ', h('button', { onclick: () => newLink() }, 'Save one'))),
      card('Quotes', H.quotes.length, () => dbw.setView('quotes'),
        H.quotes.length
          ? h('ul', { class: 'home-list' }, ...H.quotes.slice(0, 4).map((q) => h('li', {}, h('button', {
            class: 'home-item', onclick: () => dbw.setView('quotes'),
          }, h('span', { class: 'q' }, `“${q.text}”`), h('span', { class: 'm' }, `— ${q.author || 'Unknown'}`)))))
          : h('p', { class: 'home-empty' }, 'No saved quotes yet.', ' ', h('button', { onclick: () => newQuote() }, 'Add one'))),
      card('Social posts', H.social.length, () => dbw.setView('social'),
        H.social.length
          ? h('ul', { class: 'home-list' }, ...[...H.social].sort((a, b) => (a.status === 'posted') - (b.status === 'posted') || b.updated - a.updated).slice(0, 4).map((p) => h('li', {}, h('button', {
            class: 'home-item', onclick: () => dbw.setView('social'),
          }, h('span', { class: 't' }, (p.text || Object.values(p.versions || {})[0] || '').replace(/\s+/g, ' ')), h('span', { class: 'm' }, [POST_STATUS[p.status], p.networks.map((n) => NETS[n]).join(', ')].join(' · '))))))
          : h('p', { class: 'home-empty' }, 'No social posts yet.', ' ', h('button', { onclick: () => newSocial() }, 'Write one'))),
    );
  }

  // ---------------------------------------------------------------------------
  // Search everything

  function renderResults() {
    const q = $('#home-search').value.trim().toLowerCase();
    const results = $('#home-results');
    $('#home-body').hidden = !!q;
    results.hidden = !q;
    if (!q) return;
    const words = q.split(/\s+/);
    const hit = (...fields) => { const text = fields.join(' ').toLowerCase(); return words.every((w) => text.includes(w)); };
    const { articles, thoughts, notes, journal } = dbw.lists();
    const groups = [];
    for (const [kind, list] of [['articles', articles], ['thoughts', thoughts], ['notes', notes], ['journal', journal]]) {
      const found = list.filter((d) => hit(d.title, d.excerpt, d.slug, d.category));
      if (found.length) groups.push(card({ notes: 'Quick notes', journal: 'Journal' }[kind] || KIND[kind] + 's', found.length, null, docList(kind, found.slice(0, 20), '')));
    }
    const links = H.links.filter((l) => hit(l.title, l.url, l.site, l.description, l.note, (l.tags || []).join(' ')));
    if (links.length) {
      groups.push(card('Links', links.length, null, h('ul', { class: 'home-list' }, ...links.slice(0, 20).map((l) => h('li', {}, h('a', {
        class: 'home-item', href: l.url, target: '_blank', rel: 'noopener noreferrer',
      }, h('span', { class: 't' }, l.title || l.url), h('span', { class: 'm' }, host(l.url))))))));
    }
    const posts = H.social.filter((p) => hit(p.text, ...Object.values(p.versions || {}), p.note));
    if (posts.length) {
      groups.push(card('Social posts', posts.length, null, h('ul', { class: 'home-list' }, ...posts.slice(0, 20).map((p) => h('li', {}, h('button', {
        class: 'home-item', onclick: () => { dbw.setView('social'); requestAnimationFrame(() => { const box = $('#social-search'); box.value = q; box.dispatchEvent(new Event('input')); }); },
      }, h('span', { class: 't' }, (p.text || '').replace(/\s+/g, ' ')), h('span', { class: 'm' }, `${POST_STATUS[p.status]} · ${p.networks.map((n) => NETS[n]).join(', ')}`)))))));
    }
    const quotes = H.quotes.filter((x) => hit(x.text, x.author, x.source, x.note));
    if (quotes.length) {
      groups.push(card('Quotes', quotes.length, null, h('ul', { class: 'home-list' }, ...quotes.slice(0, 20).map((x) => h('li', {}, h('button', {
        class: 'home-item', onclick: () => openQuotesSearch(q),
      }, h('span', { class: 'q' }, `“${x.text}”`), h('span', { class: 'm' }, `— ${x.author || 'Unknown'}`)))))));
    }
    results.replaceChildren(groups.length
      ? h('div', { class: 'home-grid' }, ...groups)
      : h('p', { class: 'home-empty' }, `Nothing matches “${$('#home-search').value.trim()}”.`));
  }

  function openQuotesSearch(q) {
    dbw.setView('quotes');
    requestAnimationFrame(() => {
      const box = $('#quote-search');
      box.value = q;
      box.dispatchEvent(new Event('input'));
    });
  }

  // ---------------------------------------------------------------------------
  // New…

  function newLink() {
    dbw.setView('links');
    requestAnimationFrame(() => $('#link-url').focus());
  }
  function newSocial() {
    dbw.setView('social');
    requestAnimationFrame(() => dbw.focusSocialComposer());
  }
  function newQuote() {
    dbw.setView('quotes');
    requestAnimationFrame(() => $('#quote-text').focus());
  }

  const menu = $('#home-new-menu');
  const toggleMenu = (open = menu.hidden) => {
    menu.hidden = !open;
    $('#home-new').setAttribute('aria-expanded', String(open));
  };
  $('#home-new').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  menu.addEventListener('click', (e) => {
    const what = e.target.closest('[data-new]')?.dataset.new;
    if (!what) return;
    toggleMenu(false);
    if (what === 'link') newLink();
    else if (what === 'quote') newQuote();
    else if (what === 'social') newSocial();
    else dbw.newDoc(what);
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('#home-new, #home-new-menu')) toggleMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) toggleMenu(false);
    if (e.key === 'Escape' && body.dataset.page === 'home' && $('#home-search').value) { $('#home-search').value = ''; renderResults(); }
  });
  $('#home-import').addEventListener('click', () => dbw.importInto('articles'));
  $('#home-search').addEventListener('input', renderResults);

  // ---------------------------------------------------------------------------

  async function show() {
    renderContinue();
    renderGrid();
    renderStats();
    renderActivity();
    const [lists, links, quotes, stats, social, activity] = await Promise.allSettled([
      dbw.loadList(), api('GET', '/api/links'), dbw.quotes.list(), api('GET', '/api/stats'), dbw.social.list(), api('GET', '/api/activity'),
    ]);
    if (activity.status === 'fulfilled') H.activity = activity.value;
    if (social.status === 'fulfilled') H.social = social.value;
    if (links.status === 'fulfilled') H.links = links.value;
    if (quotes.status === 'fulfilled') H.quotes = quotes.value;
    if (stats.status === 'fulfilled') H.stats = stats.value;
    if (body.dataset.page !== 'home') return;
    renderContinue();
    renderGrid();
    renderStats();
    renderActivity();
    renderResults();
    if (lists.status === 'rejected') toast(`Couldn’t refresh: ${lists.reason.message}`);
  }

  window.addEventListener('dbw:home', show);
  window.addEventListener('focus', () => { if (body.dataset.page === 'home') show(); });
})();
