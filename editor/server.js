#!/usr/bin/env node
'use strict';

// Design Bytes Writer — a local, dependency-free server for the editor.
//   npm start            → http://localhost:4321
//   PORT=5000 npm start  → pick another port

const http = require('http');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const store = require('./lib/store');
const { renderArticle } = require('./lib/template');

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

async function articlesApi(req, res, slug, action) {
  const method = req.method;

  if (!slug) {
    if (method === 'GET') return json(res, 200, await store.listArticles());
    if (method === 'POST') {
      const { title } = await readJson(req);
      const clean = String(title || '').trim() || 'Untitled';
      const slugged = await store.uniqueSlug(store.slugify(clean));
      await fsp.mkdir(store.ARTICLES, { recursive: true });
      await store.writeAtomic(store.articlePath(slugged), `# ${clean}\n\n`);
      return json(res, 201, await store.readArticle(slugged));
    }
    throw httpError(405, 'Method not allowed');
  }

  if (!store.isSlug(slug)) throw httpError(400, 'Invalid article name');
  const file = store.articlePath(slug);

  if (!action && method === 'GET') return json(res, 200, await store.readArticle(slug));

  if (!action && method === 'PUT') {
    const { content, mtime } = await readJson(req);
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    const stat = await fsp.stat(file).catch(() => null);
    // Someone (another editor, git, VS Code) changed the file since we loaded it.
    if (stat && mtime != null && Math.abs(stat.mtimeMs - mtime) > 0.5) {
      return json(res, 409, { error: 'Article changed on disk', ...(await store.readArticle(slug)) });
    }
    await store.writeAtomic(file, content);
    return json(res, 200, { slug, mtime: (await fsp.stat(file)).mtimeMs });
  }

  if (!action && method === 'DELETE') {
    await fsp.mkdir(store.TRASH, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.rename(file, path.join(store.TRASH, `${slug}-${stamp}.md`));
    return json(res, 200, { ok: true, trashed: `articles/.trash/${slug}-${stamp}.md` });
  }

  if (action === 'rename' && method === 'POST') {
    const { to } = await readJson(req);
    const next = store.isSlug(String(to || '')) ? String(to) : store.slugify(to || '');
    if (next !== slug) {
      if (await store.exists(store.articlePath(next))) throw httpError(409, `articles/${next}.md already exists`);
      await fsp.access(file);
      await fsp.rename(file, store.articlePath(next));
    }
    return json(res, 200, await store.readArticle(next));
  }

  if (action === 'export' && method === 'GET') {
    const { content, mtime } = await store.readArticle(slug);
    const html = await inlineImages(renderArticle(content, { mtime }));
    return send(res, 200, html, {
      'Content-Type': TYPES['.html'],
      'Content-Disposition': `attachment; filename="${slug}.html"`,
    });
  }

  throw httpError(404, 'Not found');
}

// Make an exported article self-contained by embedding its images.
async function inlineImages(html) {
  const names = new Set([...html.matchAll(/src="\.\.\/images\/([^"?#]+)"/g)].map((m) => m[1]));
  for (const name of names) {
    const file = path.join(store.IMAGES, decodeURIComponent(name));
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!file.startsWith(store.IMAGES + path.sep) || !type?.startsWith('image/')) continue;
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) continue;
    html = html.split(`src="../images/${name}"`).join(`src="data:${type};base64,${data.toString('base64')}"`);
  }
  return html.replace(/<a href="\.\.\/index\.html">/, '<a href="#">');
}

async function imagesApi(req, res, url) {
  if (req.method === 'GET') return json(res, 200, await store.listImages());
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

// ---------------------------------------------------------------------------
// Static files

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
  let base = PUBLIC;
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel.startsWith('/images/')) { base = store.IMAGES; rel = rel.slice('/images'.length); }
  else if (rel === '/lib/markdown.js') { base = LIB; rel = '/markdown.js'; }

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
      if (parts[1] === 'articles' && parts.length <= 4) return await articlesApi(req, res, parts[2], parts[3]);
      if (parts[1] === 'images' && parts.length === 2) return await imagesApi(req, res, url);
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
  console.log(`\n  design bytes writer  →  ${address}\n`);
  console.log(`  articles: ${path.relative(process.cwd(), store.ARTICLES) || '.'}/`);
  console.log(`  images:   ${path.relative(process.cwd(), store.IMAGES) || '.'}/\n`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [address], () => {});
  }
});
