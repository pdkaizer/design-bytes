/*
 * Social media posts: the rules for drafting, editing, marking posted, deleting
 * and restoring them. Runs in the page (window.DBSocial) and in Node (require,
 * for tests), saving through the bridge via lib/datastore.js.
 *
 * Stored as { posts: [...] } in social/posts.json. Each post:
 *   { id, text, versions: { linkedin, x, bluesky, mastodon, instagram }, networks: [],
 *     status: 'draft' | 'ready' | 'posted', posted: { network: timestamp }, articles: [],
 *     shares: { type: 'link' | 'quote', id } | null, note, created, updated }
 * text is the shared draft; a network's version (when set) replaces it for that network.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./datastore') : root.DBDataStore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBSocial = api;
})(typeof self !== 'undefined' ? self : globalThis, function (DataStore) {
  'use strict';

  const { createStore, UNCHANGED, fail, isRef } = DataStore;

  const NETWORKS = ['linkedin', 'x', 'bluesky', 'mastodon', 'instagram'];
  const STATUSES = ['draft', 'ready', 'posted'];

  const text = (s, max = 10000) => String(s ?? '').replace(/\r\n?/g, '\n').slice(0, max);

  function fields(input, post, now) {
    if ('text' in input) post.text = text(input.text).trim();
    if ('versions' in input) {
      post.versions = {};
      for (const n of NETWORKS) {
        const v = text(input.versions?.[n]).trim();
        if (v) post.versions[n] = v;
      }
    }
    if ('networks' in input) post.networks = NETWORKS.filter((n) => (input.networks || []).includes(n));
    if ('status' in input && STATUSES.includes(input.status)) post.status = input.status;
    if ('posted' in input) {
      post.posted = {};
      for (const n of NETWORKS) if (Number(input.posted?.[n])) post.posted[n] = Number(input.posted[n]);
    }
    if ('articles' in input) post.articles = [...new Set((input.articles || []).map(String).filter(isRef))].slice(0, 50);
    if ('note' in input) post.note = text(input.note, 4000);
    if ('shares' in input) {
      const s = input.shares;
      post.shares = s && ['link', 'quote'].includes(s.type) && /^[0-9a-f-]{36}$/i.test(String(s.id)) ? { type: s.type, id: String(s.id) } : null;
    }
    // Posted on every network it's for → the post as a whole is posted.
    if (post.networks.length && post.networks.every((n) => post.posted[n])) post.status = 'posted';
    else if (post.status === 'posted' && 'posted' in input) post.status = 'ready';
    post.updated = now();
    return post;
  }

  const blank = (id, created) => ({ id, text: '', versions: {}, networks: [], status: 'draft', posted: {}, articles: [], note: '', created });

  function createSocial(bridge, { now = () => Date.now(), newId = () => crypto.randomUUID() } = {}) {
    const store = createStore(bridge, 'social', 'posts');

    const add = (input) => store.change((posts) => {
      const post = fields(input, blank(newId(), now()), now);
      if (!post.text && !Object.keys(post.versions).length) throw fail(400, 'Write the post first.');
      posts.unshift(post);
      return post;
    });

    const update = (id, changes) => store.change((posts) => {
      const post = posts.find((p) => p.id === id);
      if (!post) throw fail(404, 'That post no longer exists.');
      return fields(changes, post, now);
    });

    const remove = (id) => store.change((posts) => {
      const at = posts.findIndex((p) => p.id === id);
      if (at === -1) throw fail(404, 'That post no longer exists.');
      return posts.splice(at, 1)[0];
    });

    // Undo a delete: put the post back where it belongs by date.
    const restore = (post) => store.change((posts) => {
      if (!post?.id || posts.some((p) => p.id === post.id)) return UNCHANGED;
      const back = fields(post, blank(post.id, Number(post.created) || now()), now);
      posts.push(back);
      posts.sort((a, b) => b.created - a.created);
      return back;
    });

    return { list: store.list, add, update, remove, restore, renameArticle: store.renameArticle };
  }

  return { createSocial, NETWORKS };
});
