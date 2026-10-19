/*
 * A list of records kept in one data file and saved through the bridge
 * (public/bridge.js). Used by quotes, social posts and links. Runs in the page
 * (window.DBDataStore) and in Node (require, for tests).
 *
 * Every change starts from the latest saved copy. If the file was saved
 * elsewhere in the meantime (another tab), the bridge refuses the write and the
 * change is made again on the newer copy, so no one's work is overwritten.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBDataStore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // Returned by an edit that turned out not to change anything: nothing is saved.
  const UNCHANGED = Symbol('unchanged');

  // Errors look like the page's API errors: a message, a status and data.
  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, data: { error: message, ...extra } });
  const copy = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
  // How records refer to a piece: "slug" for an article, "thoughts/slug" for a thought.
  const isRef = (s) => SLUG.test(s) || (s.startsWith('thoughts/') && SLUG.test(s.slice(9)));

  // bridge: { readData(name) → { data, version }, writeData(name, data, version) → { version } },
  // with writeData failing with status 409 when the file changed since `version`.
  // The file holds { [key]: [records] }, e.g. { quotes: [...] }.
  function createStore(bridge, name, key) {
    let cache = null; // { items, version } as last read or written
    let queue = Promise.resolve();
    const serial = (fn) => (queue = queue.then(fn, fn));

    async function reload() {
      const { data, version } = await bridge.readData(name);
      cache = { items: Array.isArray(data?.[key]) ? data[key] : [], version: version ?? null };
      return cache;
    }

    // The latest records (copies, so changing them doesn't change what's saved).
    const list = () => serial(async () => copy((await reload()).items));

    // edit(items) changes the array in place and returns what the caller gets back
    // (or UNCHANGED). It may run more than once, so it must only touch `items`.
    function change(edit) {
      return serial(async () => {
        for (let attempt = 0; ; attempt++) {
          const { items, version } = cache || (await reload());
          const next = copy(items);
          const result = edit(next);
          if (result === UNCHANGED) return undefined;
          try {
            const saved = await bridge.writeData(name, { [key]: next }, version);
            cache = { items: next, version: saved.version };
            return copy(result);
          } catch (err) {
            cache = null;
            if (err.status === 409 && attempt < 4) continue;
            throw err;
          }
        }
      });
    }

    // When an article or thought is renamed, records that are for it follow it.
    const renameArticle = (from, to) => change((items) => {
      let changed = false;
      for (const item of items) {
        const at = (item.articles || []).indexOf(from);
        if (at > -1) { item.articles[at] = to; item.articles = [...new Set(item.articles)]; changed = true; }
      }
      return changed ? true : UNCHANGED;
    });

    return { list, change, renameArticle };
  }

  return { createStore, UNCHANGED, fail, copy, isRef };
});
