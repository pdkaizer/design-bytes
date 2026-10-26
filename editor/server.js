#!/usr/bin/env node
'use strict';

// DB Writer — a local server for the editor.
//   npm start            → http://localhost:4321
//   PORT=5000 npm start  → pick another port
// Settings such as ANTHROPIC_API_KEY can go in a .env file at the project root.

const http = require('http');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./lib/store');
const { askClaude } = require('./lib/anthropic');
const { pageDetails } = require('./lib/pagedetails');
const site = require('./lib/site');
const datafiles = require('./lib/datafiles');
const files = require('./lib/files');

const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const LIB = path.join(__dirname, 'lib');
const MAX_JSON = 5 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg' };

const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': TYPES['.json'] });

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
  } catch (err) {
    throw err.status ? err : httpError(400, 'Invalid JSON');
  }
}

// Only answer requests addressed to this machine, and refuse cross-site writes.
function isTrusted(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  return true;
}

// ---------------------------------------------------------------------------
// API

// /api/files — plain file access to the writing folders, for the bridge.
async function filesApi(req, res, url, action) {
  try {
    if (action === 'move' && req.method === 'POST') {
      const { from, to } = await readJson(req);
      return json(res, 200, await files.move(from, to));
    }
    if (action === 'mirror' && req.method === 'POST') {
      const { name, content, images } = await readJson(req);
      return json(res, 200, await files.mirror(name, content, images));
    }
    if (action) throw httpError(404, 'Not found');
    if (req.method === 'GET' && url.searchParams.has('dir')) {
      return json(res, 200, { entries: await files.list(url.searchParams.get('dir'), { content: url.searchParams.has('content') }) });
    }
    if (req.method === 'GET') return json(res, 200, await files.read(url.searchParams.get('path')));
    if (req.method === 'PUT') {
      const { path: rel, content, mtime, create } = await readJson(req);
      return json(res, 200, await files.write(rel, content, { mtime, create: !!create }));
    }
    if (req.method === 'DELETE') return json(res, 200, await files.remove(url.searchParams.get('path')));
    throw httpError(405, 'Method not allowed');
  } catch (err) {
    if (err instanceof files.FileError) return json(res, err.status, { error: err.message, ...(err.current && { current: err.current }), ...(err.exists && { exists: true }) });
    throw err;
  }
}

// /api/site/… — peterkaizer.com's thoughts, for publishing (the rules run in the page).
async function siteApi(req, res, url, part) {
  try {
    if (part === 'thoughts' && req.method === 'GET') return json(res, 200, await site.siteThoughts());
    if (part === 'thoughts' && req.method === 'PUT') {
      const { name, content } = await readJson(req);
      return json(res, 200, await site.writeSiteThought(name, content));
    }
    if (part === 'images' && req.method === 'PUT') {
      return json(res, 200, await site.writeSiteImage(url.searchParams.get('name'), await readBody(req, MAX_IMAGE)));
    }
    if (part === 'commit' && req.method === 'POST') {
      const { name, message, image } = await readJson(req);
      return json(res, 200, await site.commitSiteThought(name, message, image));
    }
    throw httpError(404, 'Not found');
  } catch (err) {
    if (err instanceof site.SiteError) return json(res, err.status, { error: err.message });
    throw err;
  }
}

// /api/data/<name> — whole data files the page reads and writes through the bridge.
async function dataApi(req, res, name) {
  if (!datafiles.fileFor(name)) throw httpError(404, 'Not found');
  if (req.method === 'GET') return json(res, 200, await datafiles.read(name));
  if (req.method === 'PUT') {
    const { data, version } = await readJson(req);
    if (!data || typeof data !== 'object') throw httpError(400, 'data must be an object');
    const saved = await datafiles.write(name, data, version);
    if (saved.conflict) return json(res, 409, { error: 'Changed since it was read' });
    return json(res, 200, saved);
  }
  throw httpError(405, 'Method not allowed');
}

async function imagesApi(req, res, url) {
  if (req.method === 'POST') {
    let name = url.searchParams.get('name') || 'image';
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!store.IMAGE_EXT.test(name)) {
      if (!IMAGE_TYPES[type]) throw httpError(415, 'Only image files can be added');
      name = name.replace(/\.[^.]*$/, '') + IMAGE_TYPES[type];
    }
    const data = await readBody(req, MAX_IMAGE);
    if (!data.length) throw httpError(400, 'Empty image');
    await fsp.mkdir(store.IMAGES, { recursive: true });
    const finalName = await store.uniqueImageName(name);
    await fsp.writeFile(path.join(store.IMAGES, finalName), data, { flag: 'wx' });
    return json(res, 201, { name: finalName, path: `../images/${finalName}` });
  }
  throw httpError(405, 'Method not allowed');
}

// POST /api/images/fetch { url, name } — downloads a web image into /images as `name`
// (made unique). Downloading the same image again reuses the saved copy.
async function fetchImage(req, res) {
  const { url, name: wanted } = await readJson(req);
  let src;
  try { src = new URL(String(url || '')); } catch { throw httpError(400, 'Not a web address'); }
  if (!/^https?:$/.test(src.protocol)) throw httpError(400, 'Only http and https images can be downloaded');
  let response;
  try {
    response = await fetch(src.href, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) DBWriter/1.0' } });
  } catch (err) {
    throw httpError(502, `Couldn’t download ${src.href}: ${err.cause?.code || err.message}`);
  }
  if (!response.ok) throw httpError(502, `Couldn’t download ${src.href} (HTTP ${response.status})`);
  const type = (response.headers.get('content-type') || '').split(';')[0].trim();
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > MAX_IMAGE) throw httpError(415, `${src.href} is empty or too large`);
  let name = String(wanted || decodeURIComponent(src.pathname).split('/').filter(Boolean).pop() || 'image');
  if (!store.IMAGE_EXT.test(name)) {
    if (!IMAGE_TYPES[type]) throw httpError(415, `${src.href} isn’t an image`);
    name = `${name.replace(/\.[^.]*$/, '') || 'image'}${IMAGE_TYPES[type]}`;
  }
  name = name.replace(/[^\w@.-]+/g, '-').replace(/^[-.]+/, '').slice(-120) || `image${IMAGE_TYPES[type] || '.jpg'}`;
  await fsp.mkdir(store.IMAGES, { recursive: true });
  const existing = await fsp.readFile(path.join(store.IMAGES, name)).catch(() => null);
  if (existing && existing.equals(data)) return json(res, 200, { name, path: `../images/${name}`, reused: true });
  const finalName = await store.uniqueImageName(name);
  await fsp.writeFile(path.join(store.IMAGES, finalName), data, { flag: 'wx' });
  return json(res, 201, { name: finalName, path: `../images/${finalName}` });
}

// ---------------------------------------------------------------------------
// Static files

const SHARED = ['/lib/markdown.js', '/lib/documents.js', '/lib/datastore.js', '/lib/quotes.js', '/lib/social.js', '/lib/links.js', '/lib/stats.js', '/lib/template.js', '/lib/claude.js', '/lib/thoughtsite.js'];

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
  let base = PUBLIC;
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel.startsWith('/images/')) { base = store.IMAGES; rel = rel.slice('/images'.length); }
  else if (SHARED.includes(rel)) { base = LIB; rel = rel.slice('/lib'.length); } // code the page shares with Node

  const file = path.join(base, rel);
  if (!file.startsWith(base + path.sep)) throw httpError(403, 'Forbidden');
  const data = await fsp.readFile(file);
  send(res, 200, req.method === 'HEAD' ? undefined : data, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
  });
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (!isTrusted(req)) throw httpError(403, 'Forbidden');
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw httpError(400, 'Bad URL'); }
    const parts = pathname.split('/').filter(Boolean);

    if (parts[0] === 'api') {
      if (parts[1] === 'page-details' && parts.length === 2 && req.method === 'POST') {
        const { url: href } = await readJson(req);
        try { new URL(href); } catch { throw httpError(400, 'Invalid address'); }
        return json(res, 200, await pageDetails(href));
      }
      if (parts[1] === 'data' && parts.length === 3) return await dataApi(req, res, parts[2]);
      if (parts[1] === 'files' && parts.length <= 3) return await filesApi(req, res, url, parts[2]);
      if (parts[1] === 'site' && parts.length === 3) return await siteApi(req, res, url, parts[2]);
      if (parts[1] === 'images' && parts.length === 2) return await imagesApi(req, res, url);
      if (parts[1] === 'images' && parts[2] === 'fetch' && parts.length === 3 && req.method === 'POST') return await fetchImage(req, res);
      if (parts[1] === 'claude' && parts.length === 2 && req.method === 'POST') return json(res, 200, await askClaude(await readJson(req)));
      throw httpError(404, 'Not found');
    }
    return await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EEXIST' ? 409 : 500);
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 404 ? 'Not found' : err.message });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=${PORT + 1} npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`\n  DB Writer  →  ${address}\n`);
  const show = (dir) => (dir.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), dir) : dir.replace(os.homedir(), '~'));
  if (store.ROOT !== store.REPO) console.log(`  writing:     ${show(store.ROOT)}/  (published articles are copied to ${show(store.REPO)}/articles)`);
  console.log(`  articles:    ${show(store.ARTICLES)}/`);
  console.log(`  thoughts:    ${show(store.THOUGHTS)}/  →  publishes to ${process.env.THOUGHTS_SITE || '(set THOUGHTS_SITE in .env)'}`);
  console.log(`  quick notes: ${show(store.NOTES)}/`);
  console.log(`  journal:     ${show(store.JOURNAL)}/`);
  console.log(`  links:       ${show(path.dirname(datafiles.FILES.links))}/`);
  console.log(`  quotes:      ${show(path.dirname(datafiles.FILES.quotes))}/`);
  console.log(`  social:      ${show(path.dirname(datafiles.FILES.social))}/`);
  console.log(`  images:      ${show(store.IMAGES)}/\n`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [address], () => {});
  }
});
