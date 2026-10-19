/*
 * Saved quotes: the rules for adding, editing, deleting and restoring them.
 * Runs in the page (window.DBQuotes) and in Node (require, for tests), saving
 * through the bridge via lib/datastore.js.
 *
 * Stored as { quotes: [...] } in quotes/quotes.json. Each quote:
 *   { id, text, author, source, articles: [], note, created }
 * where articles lists the articles ("slug") and thoughts ("thoughts/slug") it's for.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./datastore') : root.DBDataStore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBQuotes = api;
})(typeof self !== 'undefined' ? self : globalThis, function (DataStore) {
  'use strict';

  const { createStore, UNCHANGED, fail, isRef } = DataStore;

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

  function createQuotes(bridge, { now = () => Date.now(), newId = () => crypto.randomUUID() } = {}) {
    const store = createStore(bridge, 'quotes', 'quotes');

    const add = (input) => store.change((quotes) => {
      const quote = fields(input, { id: newId(), text: '', author: '', source: '', articles: [], note: '', created: now() });
      if (!quote.text) throw fail(400, 'Type or paste the quote first.');
      const existing = quotes.find((q) => sameText(q.text, quote.text));
      if (existing) throw fail(409, 'You’ve already saved this quote.', { quote: { ...existing } });
      quotes.unshift(quote);
      return quote;
    });

    const update = (id, changes) => store.change((quotes) => {
      const quote = quotes.find((q) => q.id === id);
      if (!quote) throw fail(404, 'That quote no longer exists.');
      const text = quote.text;
      fields(changes, quote);
      if (!quote.text) quote.text = text; // never blank a quote by accident
      return quote;
    });

    const remove = (id) => store.change((quotes) => {
      const at = quotes.findIndex((q) => q.id === id);
      if (at === -1) throw fail(404, 'That quote no longer exists.');
      return quotes.splice(at, 1)[0];
    });

    // Undo a delete: put the quote back where it belongs by date.
    const restore = (quote) => store.change((quotes) => {
      if (!quote?.id || quotes.some((q) => q.id === quote.id)) return UNCHANGED;
      quotes.push(fields(quote, { id: quote.id, created: Number(quote.created) || now() }));
      quotes.sort((a, b) => b.created - a.created);
      return quote;
    });

    return { list: store.list, add, update, remove, restore, renameArticle: store.renameArticle };
  }

  return { createQuotes, cleanText, sameText };
});
