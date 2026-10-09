'use strict';

// Saved links, kept in links/links.json (git-ignored). Each link:
//   { id, url, title, description, site, tags: [], articles: [], note, created }
// where articles lists the slugs of articles the link is for.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { ROOT, writeAtomic, isSlug } = require('./store');

const DIR = path.join(ROOT, 'links');
const FILE = path.join(DIR, 'links.json');
const FETCH_TIMEOUT = 8000;
const MAX_PAGE = 768 * 1024;

class LinkError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// Writes are queued so two quick changes can't overwrite each other.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function load() {
  try {
    const data = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    return Array.isArray(data.links) ? data.links : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function persist(links) {
  await fsp.mkdir(DIR, { recursive: true });
  await writeAtomic(FILE, `${JSON.stringify({ links }, null, 2)}\n`);
}

// Tags are lowercase words joined by dashes: "Design Systems" → "design-systems".
function cleanTags(tags) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : String(tags || '').split(',')) {
    const tag = String(t).toLowerCase().replace(/^#+/, '').trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (tag && !out.includes(tag)) out.push(tag.slice(0, 40));
  }
  return out.slice(0, 20);
}

// Articles are referred to by slug, thoughts by "thoughts/slug".
const isRef = (s) => isSlug(s) || (s.startsWith('thoughts/') && isSlug(s.slice(9)));
const cleanArticles = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter(isRef))].slice(0, 50);

function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new LinkError(400, 'Paste a link to save.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let url;
  try { url = new URL(s); } catch { throw new LinkError(400, 'That doesn’t look like a web address.'); }
  if (!/^https?:$/.test(url.protocol)) throw new LinkError(400, 'Only http and https links can be saved.');
  url.hash = url.hash === '#' ? '' : url.hash;
  return url.href;
}

// Same page for duplicate detection: ignore http/https, "www.", a trailing slash and tracking parameters.
function sameKey(href) {
  const u = new URL(href);
  [...u.searchParams.keys()].filter((k) => /^(utm_|fbclid|gclid|mc_)/i.test(k)).forEach((k) => u.searchParams.delete(k));
  return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
}

const decode = (s) => String(s || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return '';
}

// Fetches the page's title, description and site name. Never throws: on any
// problem the link is saved with what we have.
async function pageDetails(href) {
  const url = new URL(href);
  const fallback = { title: url.hostname.replace(/^www\./, '') + (url.pathname.length > 1 ? url.pathname : ''), description: '', site: url.hostname.replace(/^www\./, '') };
  try {
    const res = await fetch(href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) DBWriter/1.0', Accept: 'text/html,application/xhtml+xml' },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/html/i.test(type)) {
      const file = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
      return { ...fallback, title: file || fallback.title };
    }
    // Read just the start of the page — the <head> is all we need.
    const reader = res.body.getReader();
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < MAX_PAGE) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const title = meta(html, ['og:title', 'twitter:title']) || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    return {
      title: (title || fallback.title).slice(0, 300),
      description: (meta(html, ['og:description', 'description', 'twitter:description']) || '').slice(0, 600),
      site: meta(html, ['og:site_name']) || fallback.site,
    };
  } catch {
    return fallback;
  }
}

const list = () => load();

function add(rawUrl) {
  const url = normalizeUrl(rawUrl);
  return serial(async () => {
    const links = await load();
    const existing = links.find((l) => sameKey(l.url) === sameKey(url));
    if (existing) throw new LinkError(409, 'You’ve already saved this link.', { link: existing });
    const details = await pageDetails(url);
    const link = {
      id: crypto.randomUUID(),
      url,
      ...details,
      tags: [],
      articles: [],
      note: '',
      created: Date.now(),
    };
    links.unshift(link);
    await persist(links);
    return link;
  });
}

function update(id, changes) {
  return serial(async () => {
    const links = await load();
    const link = links.find((l) => l.id === id);
    if (!link) throw new LinkError(404, 'That link no longer exists.');
    if ('title' in changes) link.title = String(changes.title || '').trim().slice(0, 300) || link.title;
    if ('note' in changes) link.note = String(changes.note || '').slice(0, 4000);
    if ('tags' in changes) link.tags = cleanTags(changes.tags);
    if ('articles' in changes) link.articles = cleanArticles(changes.articles);
    if ('url' in changes) link.url = normalizeUrl(changes.url);
    await persist(links);
    return link;
  });
}

function remove(id) {
  return serial(async () => {
    const links = await load();
    const at = links.findIndex((l) => l.id === id);
    if (at === -1) throw new LinkError(404, 'That link no longer exists.');
    const [gone] = links.splice(at, 1);
    await persist(links);
    return gone;
  });
}

// Puts back a deleted link (for Undo).
function restore(link) {
  return serial(async () => {
    const links = await load();
    if (!link?.id || links.some((l) => l.id === link.id)) return link;
    links.push({ ...link, url: normalizeUrl(link.url), tags: cleanTags(link.tags) });
    links.sort((a, b) => b.created - a.created);
    await persist(links);
    return link;
  });
}

// When an article's file is renamed, its links follow it.
function renameArticle(from, to) {
  return serial(async () => {
    const links = await load();
    let changed = false;
    for (const l of links) {
      const at = (l.articles || []).indexOf(from);
      if (at > -1) { l.articles[at] = to; l.articles = cleanArticles(l.articles); changed = true; }
    }
    if (changed) await persist(links);
  });
}

async function get(id) {
  const link = (await load()).find((l) => l.id === id);
  if (!link) throw new LinkError(404, 'That link no longer exists.');
  return link;
}

module.exports = { list, add, update, remove, restore, get, renameArticle, cleanTags, LinkError, DIR };
