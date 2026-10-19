/*
 * Saved quotes: the rules for adding, editing, deleting and restoring them.
 * Runs in the page (window.DBQuotes) and in Node (require, for tests). It never
 * touches files itself; it saves through a bridge (public/bridge.js), so the same
 * code works with the Node server today and a native app later.
 *
 * Stored as { quotes: [...] } in quotes/quotes.json. Each quote:
 *   { id, text, author, source, articles: [], note, created }
 * where articles lists the articles ("slug") and thoughts ("thoughts/slug") it's for.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBQuotes = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const NAME = 'quotes';
  const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

  const isRef = (s) => SLUG.test(s) || (s.startsWith('thoughts/') && SLUG.test(s.slice(9)));
  const cleanArticles = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter(isRef))].slice(0, 50);

  // Strip wrapping quotation marks people paste along with the words.
  const cleanText = (s) => String(s || '').trim().replace(/^["“”'‘’«]+|["“”'‘’»]+$/g, '').trim().slice(0, 4000);
  const comparable = (s) => cleanText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const sameText = (a, b) => comparable(a) === comparable(b);

  function fields(input, quote = {}) {
    if ('text' in input) quote.text = cleanText(input.text);
    if ('author' in input) quote.author = String(input.author || '').trim().replace(/^[—–-]+\s*/, '').slice(0, 200);
    if ('source' in input) quote.source = String(input.source || '').trim().slice(0, 500);
    if ('note' in input) quote.note = String(input.note || '').slice(0, 4000);
    if ('articles' in input) quote.articles = cleanArticles(input.articles);
    return quote;
  }

  // Errors look like the page's API errors: a message, a status and data.
  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, data: { error: message, ...extra } });
  const copy = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const UNCHANGED = Symbol('unchanged');

  // bridge: { readData(name) → { data, version }, writeData(name, data, version) → { version } }.
  // writeData fails with status 409 if the file changed since `version`.
  function createQuotes(bridge, { now = () => Date.now(), newId = () => crypto.randomUUID() } = {}) {
    let cache = null; // { quotes, version } as last read or written
    let queue = Promise.resolve();
    const serial = (fn) => (queue = queue.then(fn, fn));

    async function reload() {
      const { data, version } = await bridge.readData(NAME);
      cache = { quotes: Array.isArray(data?.quotes) ? data.quotes : [], version: version ?? null };
      return cache;
    }

    // Apply a change to the quotes and save. If they were saved elsewhere in the
    // meantime (another tab), start again from the latest copy.
    function change(edit) {
      return serial(async () => {
        for (let attempt = 0; ; attempt++) {
          const { quotes, version } = cache || (await reload());
          const next = copy(quotes);
          const result = edit(next);
          if (result === UNCHANGED) return undefined;
          try {
            const saved = await bridge.writeData(NAME, { quotes: next }, version);
            cache = { quotes: next, version: saved.version };
            return copy(result);
          } catch (err) {
            cache = null;
            if (err.status === 409 && attempt < 4) continue;
            throw err;
          }
        }
      });
    }

    const list = () => serial(async () => copy((await reload()).quotes));

    const add = (input) => change((quotes) => {
      const quote = fields(input, { id: newId(), text: '', author: '', source: '', articles: [], note: '', created: now() });
      if (!quote.text) throw fail(400, 'Type or paste the quote first.');
      const existing = quotes.find((q) => sameText(q.text, quote.text));
      if (existing) throw fail(409, 'You’ve already saved this quote.', { quote: copy(existing) });
      quotes.unshift(quote);
      return quote;
    });

    const update = (id, changes) => change((quotes) => {
      const quote = quotes.find((q) => q.id === id);
      if (!quote) throw fail(404, 'That quote no longer exists.');
      const text = quote.text;
      fields(changes, quote);
      if (!quote.text) quote.text = text; // never blank a quote by accident
      return quote;
    });

    const remove = (id) => change((quotes) => {
      const at = quotes.findIndex((q) => q.id === id);
      if (at === -1) throw fail(404, 'That quote no longer exists.');
      return quotes.splice(at, 1)[0];
    });

    // Undo a delete: put the quote back where it belongs by date.
    const restore = (quote) => change((quotes) => {
      if (!quote?.id || quotes.some((q) => q.id === quote.id)) return UNCHANGED;
      quotes.push(fields(quote, { id: quote.id, created: Number(quote.created) || now() }));
      quotes.sort((a, b) => b.created - a.created);
      return quote;
    });

    // When an article or thought is renamed, its quotes follow it.
    const renameArticle = (from, to) => change((quotes) => {
      let changed = false;
      for (const q of quotes) {
        const at = (q.articles || []).indexOf(from);
        if (at > -1) { q.articles[at] = to; q.articles = cleanArticles(q.articles); changed = true; }
      }
      return changed ? true : UNCHANGED;
    });

    return { list, add, update, remove, restore, renameArticle };
  }

  return { createQuotes, cleanText, sameText };
});
