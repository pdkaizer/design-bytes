'use strict';

// Social media posts, kept in social/posts.json (git-ignored). Each post:
//   { id, text, versions: { linkedin, x, bluesky, mastodon, instagram }, networks: [],
//     status: 'draft' | 'ready' | 'posted', posted: { network: timestamp }, articles: [],
//     shares: { type: 'link' | 'quote', id } | null, note, created, updated }
// text is the shared draft; a network's version (when set) replaces it for that network.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { ROOT, writeAtomic, isSlug } = require('./store');

const DIR = path.join(ROOT, 'social');
const FILE = path.join(DIR, 'posts.json');
const NETWORKS = ['linkedin', 'x', 'bluesky', 'mastodon', 'instagram'];
const STATUSES = ['draft', 'ready', 'posted'];

class SocialError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function load() {
  try {
    const data = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    return Array.isArray(data.posts) ? data.posts : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function persist(posts) {
  await fsp.mkdir(DIR, { recursive: true });
  await writeAtomic(FILE, `${JSON.stringify({ posts }, null, 2)}\n`);
}

const isRef = (s) => isSlug(s) || (s.startsWith('thoughts/') && isSlug(s.slice(9)));
const text = (s, max = 10000) => String(s ?? '').replace(/\r\n?/g, '\n').slice(0, max);

function fields(input, post) {
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
  post.updated = Date.now();
  return post;
}

const list = () => load();

function add(input) {
  return serial(async () => {
    const post = fields(input, {
      id: crypto.randomUUID(), text: '', versions: {}, networks: [], status: 'draft', posted: {}, articles: [], note: '', created: Date.now(),
    });
    if (!post.text && !Object.keys(post.versions).length) throw new SocialError(400, 'Write the post first.');
    const posts = await load();
    posts.unshift(post);
    await persist(posts);
    return post;
  });
}

function update(id, changes) {
  return serial(async () => {
    const posts = await load();
    const post = posts.find((p) => p.id === id);
    if (!post) throw new SocialError(404, 'That post no longer exists.');
    fields(changes, post);
    await persist(posts);
    return post;
  });
}

function remove(id) {
  return serial(async () => {
    const posts = await load();
    const at = posts.findIndex((p) => p.id === id);
    if (at === -1) throw new SocialError(404, 'That post no longer exists.');
    const [gone] = posts.splice(at, 1);
    await persist(posts);
    return gone;
  });
}

function restore(post) {
  return serial(async () => {
    const posts = await load();
    if (!post?.id || posts.some((p) => p.id === post.id)) return post;
    const back = fields(post, { id: post.id, text: '', versions: {}, networks: [], status: 'draft', posted: {}, articles: [], note: '', created: Number(post.created) || Date.now() });
    posts.push(back);
    posts.sort((a, b) => b.created - a.created);
    await persist(posts);
    return back;
  });
}

function renameArticle(from, to) {
  return serial(async () => {
    const posts = await load();
    let changed = false;
    for (const p of posts) {
      const at = (p.articles || []).indexOf(from);
      if (at > -1) { p.articles[at] = to; changed = true; }
    }
    if (changed) await persist(posts);
  });
}

module.exports = { list, add, update, remove, restore, renameArticle, NETWORKS, DIR };
