/*
 * Saved links: the rules for saving, tagging, editing, deleting and restoring
 * them. Runs in the page (window.DBLinks) and in Node (require, for tests),
 * saving through the bridge via lib/datastore.js. Fetching a page's title and
 * asking Claude for tags are bridge calls too, since the page can't do either.
 *
 * Stored as { links: [...] } in links/links.json. Each link:
 *   { id, url, title, description, site, tags: [], articles: [], note, created }
 * where articles lists the articles ("slug") and thoughts ("thoughts/slug") it's for.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./datastore') : root.DBDataStore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBLinks = api;
})(typeof self !== 'undefined' ? self : globalThis, function (DataStore) {
  'use strict';

  const { createStore, UNCHANGED, fail, isRef } = DataStore;

  // Tags are lowercase words joined by dashes: "Design Systems" → "design-systems".
  function cleanTags(tags) {
    const out = [];
    for (const t of Array.isArray(tags) ? tags : String(tags || '').split(',')) {
      const tag = String(t).toLowerCase().replace(/^#+/, '').trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (tag && !out.includes(tag)) out.push(tag.slice(0, 40));
    }
    return out.slice(0, 20);
  }

  const cleanArticles = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter(isRef))].slice(0, 50);

  function normalizeUrl(raw) {
    let s = String(raw || '').trim();
    if (!s) throw fail(400, 'Paste a link to save.');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
    let url;
    try { url = new URL(s); } catch { throw fail(400, 'That doesn’t look like a web address.'); }
    if (!/^https?:$/.test(url.protocol)) throw fail(400, 'Only http and https links can be saved.');
    url.hash = url.hash === '#' ? '' : url.hash;
    return url.href;
  }

  // Same page for duplicate detection: ignore http/https, "www.", a trailing slash and tracking parameters.
  function sameKey(href) {
    const u = new URL(href);
    [...u.searchParams.keys()].filter((k) => /^(utm_|fbclid|gclid|mc_)/i.test(k)).forEach((k) => u.searchParams.delete(k));
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
  }

  // What a link is called when its page can't be read: the site and path.
  function fallbackDetails(href) {
    const url = new URL(href);
    const site = url.hostname.replace(/^www\./, '');
    return { title: site + (url.pathname.length > 1 ? url.pathname : ''), description: '', site };
  }

  const str = (s, max) => String(s || '').trim().slice(0, max);

  // bridge also needs pageDetails(url) → { title, description, site } and
  // suggestTags({ title, url, description, note, current, existing }) → { tags }
  // (the page supplies that one from lib/claude.js).
  function createLinks(bridge, { now = () => Date.now(), newId = () => crypto.randomUUID() } = {}) {
    const store = createStore(bridge, 'links', 'links');
    const duplicateOf = (links, url) => links.find((l) => sameKey(l.url) === sameKey(url));
    const alreadySaved = (link) => fail(409, 'You’ve already saved this link.', { link: { ...link } });

    async function add(raw) {
      const url = normalizeUrl(raw);
      const existing = duplicateOf(await store.list(), url);
      if (existing) throw alreadySaved(existing);
      // Reading the page can take a few seconds, so it happens before the save, not during it.
      let details = fallbackDetails(url);
      try {
        const got = await bridge.pageDetails(url);
        details = { title: str(got.title, 300) || details.title, description: str(got.description, 600), site: str(got.site, 200) || details.site };
      } catch { /* save it with what we have */ }
      return store.change((links) => {
        const again = duplicateOf(links, url); // saved in another tab meanwhile
        if (again) throw alreadySaved(again);
        const link = { id: newId(), url, ...details, tags: [], articles: [], note: '', created: now() };
        links.unshift(link);
        return link;
      });
    }

    const update = (id, changes) => store.change((links) => {
      const link = links.find((l) => l.id === id);
      if (!link) throw fail(404, 'That link no longer exists.');
      if ('title' in changes) link.title = str(changes.title, 300) || link.title;
      if ('note' in changes) link.note = String(changes.note || '').slice(0, 4000);
      if ('tags' in changes) link.tags = cleanTags(changes.tags);
      if ('articles' in changes) link.articles = cleanArticles(changes.articles);
      if ('url' in changes) link.url = normalizeUrl(changes.url);
      return link;
    });

    const remove = (id) => store.change((links) => {
      const at = links.findIndex((l) => l.id === id);
      if (at === -1) throw fail(404, 'That link no longer exists.');
      return links.splice(at, 1)[0];
    });

    // Undo a delete: put the link back where it belongs by date.
    const restore = (link) => store.change((links) => {
      if (!link?.id || links.some((l) => l.id === link.id)) return UNCHANGED;
      links.push({ ...link, url: normalizeUrl(link.url), tags: cleanTags(link.tags), articles: cleanArticles(link.articles) });
      links.sort((a, b) => b.created - a.created);
      return link;
    });

    // Tags from Claude for a link, preferring ones already in the library.
    // current: the tags in the editor right now (maybe not saved yet).
    async function suggestTags(id, current) {
      const links = await store.list();
      const link = links.find((l) => l.id === id);
      if (!link) throw fail(404, 'That link no longer exists.');
      const have = cleanTags(current || link.tags);
      const existing = [...new Set([...links.flatMap((l) => l.tags || []), ...have])].sort();
      const { tags } = await bridge.suggestTags({ title: link.title, url: link.url, description: link.description, note: link.note, current: have, existing });
      return { tags: cleanTags(tags).filter((t) => !have.includes(t)) };
    }

    return { list: store.list, add, update, remove, restore, suggestTags, renameArticle: store.renameArticle };
  }

  return { createLinks, cleanTags, normalizeUrl, sameKey };
});
