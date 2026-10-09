'use strict';

// Saved quotes, kept in quotes/quotes.json (git-ignored). Each quote:
//   { id, text, author, source, articles: [], note, created }
// where articles lists the articles ("slug") and thoughts ("thoughts/slug") it's for.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { ROOT, writeAtomic, isSlug } = require('./store');

const DIR = path.join(ROOT, 'quotes');
const FILE = path.join(DIR, 'quotes.json');

class QuoteError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function load() {
  try {
    const data = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    return Array.isArray(data.quotes) ? data.quotes : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function persist(quotes) {
  await fsp.mkdir(DIR, { recursive: true });
  await writeAtomic(FILE, `${JSON.stringify({ quotes }, null, 2)}\n`);
}

const isRef = (s) => isSlug(s) || (s.startsWith('thoughts/') && isSlug(s.slice(9)));
const cleanArticles = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter(isRef))].slice(0, 50);

// Strip wrapping quotation marks people paste along with the words.
const cleanText = (s) => String(s || '').trim().replace(/^["“”'‘’«]+|["“”'‘’»]+$/g, '').trim().slice(0, 4000);
const sameText = (a, b) => cleanText(a).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === cleanText(b).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function fields(input, quote = {}) {
  if ('text' in input) quote.text = cleanText(input.text);
  if ('author' in input) quote.author = String(input.author || '').trim().replace(/^[—–-]+\s*/, '').slice(0, 200);
  if ('source' in input) quote.source = String(input.source || '').trim().slice(0, 500);
  if ('note' in input) quote.note = String(input.note || '').slice(0, 4000);
  if ('articles' in input) quote.articles = cleanArticles(input.articles);
  return quote;
}

const list = () => load();

function add(input) {
  return serial(async () => {
    const quote = fields(input, { id: crypto.randomUUID(), text: '', author: '', source: '', articles: [], note: '', created: Date.now() });
    if (!quote.text) throw new QuoteError(400, 'Type or paste the quote first.');
    const quotes = await load();
    const existing = quotes.find((q) => sameText(q.text, quote.text));
    if (existing) throw new QuoteError(409, 'You’ve already saved this quote.', { quote: existing });
    quotes.unshift(quote);
    await persist(quotes);
    return quote;
  });
}

function update(id, changes) {
  return serial(async () => {
    const quotes = await load();
    const quote = quotes.find((q) => q.id === id);
    if (!quote) throw new QuoteError(404, 'That quote no longer exists.');
    const text = quote.text;
    fields(changes, quote);
    if (!quote.text) quote.text = text; // never blank a quote by accident
    await persist(quotes);
    return quote;
  });
}

function remove(id) {
  return serial(async () => {
    const quotes = await load();
    const at = quotes.findIndex((q) => q.id === id);
    if (at === -1) throw new QuoteError(404, 'That quote no longer exists.');
    const [gone] = quotes.splice(at, 1);
    await persist(quotes);
    return gone;
  });
}

function restore(quote) {
  return serial(async () => {
    const quotes = await load();
    if (!quote?.id || quotes.some((q) => q.id === quote.id)) return quote;
    quotes.push({ ...fields(quote, { id: quote.id, created: Number(quote.created) || Date.now() }) });
    quotes.sort((a, b) => b.created - a.created);
    await persist(quotes);
    return quote;
  });
}

// When an article or thought is renamed, its quotes follow it.
function renameArticle(from, to) {
  return serial(async () => {
    const quotes = await load();
    let changed = false;
    for (const q of quotes) {
      const at = (q.articles || []).indexOf(from);
      if (at > -1) { q.articles[at] = to; q.articles = cleanArticles(q.articles); changed = true; }
    }
    if (changed) await persist(quotes);
  });
}

module.exports = { list, add, update, remove, restore, renameArticle, QuoteError, DIR };
