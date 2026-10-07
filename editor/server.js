#!/usr/bin/env node
'use strict';

// DB Writer — a local server for the editor.
//   npm start            → http://localhost:4321
//   PORT=5000 npm start  → pick another port
// Settings such as ANTHROPIC_API_KEY can go in a .env file at the project root.

const http = require('http');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const md = require('./lib/markdown');
const store = require('./lib/store');
const { renderArticle } = require('./lib/template');
const { suggest, suggestTags } = require('./lib/suggest');
const links = require('./lib/links');
const publisher = require('./lib/publish');
const history = require('./lib/history');

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

// /api/articles/… and /api/notes/… — the same API over two folders.
async function documentsApi(req, res, coll, slug, action, versionId) {
  const method = req.method;
  const isNote = coll.kind === 'notes';

  if (!slug) {
    if (method === 'GET') return json(res, 200, await coll.list());
    if (method === 'POST') {
      const { title, content: imported, filename, name: chosen } = await readJson(req);
      const clean = String(title || '').trim();
      let slugged;
      let content;
      if (typeof imported === 'string') {
        // Importing a Markdown file: keep its text, name it after its title (or file name),
        // and make sure an article has one of our statuses.
        content = imported.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const stem = String(filename || '').replace(/\.[^.]*$/, '');
        const name = String(chosen || '').trim() || md.title(content) || stem || (isNote ? 'note' : 'untitled');
        slugged = await coll.uniqueSlug(store.isSlug(name) ? name.toLowerCase() : store.slugify(name));
        if (!isNote) {
          // Articles keep their title and file name in front matter.
          content = md.liftTitle(content);
          if (!md.title(content)) content = md.setMeta(content, 'title', stem || 'Untitled', { first: true });
          content = md.setMeta(content, 'slug', slugged, { after: 'title' });
          if (!md.STATUSES.includes(String(md.frontMatter(content).data.status || '').toLowerCase())) {
            content = md.setMeta(content, 'status', md.DEFAULT_STATUS);
          }
        }
      } else if (isNote) {
        // Quick notes are named by when they were made: 2026-10-04-1532.md
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        slugged = await coll.uniqueSlug(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`);
        content = clean ? `# ${clean}\n\n` : '';
      } else {
        slugged = await coll.uniqueSlug(store.slugify(clean || 'Untitled'));
        content = md.setMeta('', 'title', clean || 'Untitled');
        content = md.setMeta(content, 'slug', slugged);
        if (coll.kind === 'thoughts') {
          // The fields peterkaizer.com uses, ready to fill in.
          content = md.setMeta(content, 'category', '');
          content = md.setMeta(content, 'description', '');
        }
        content = md.setMeta(content, 'status', md.DEFAULT_STATUS);
      }
      // Record when it was added (an imported file keeps a created: date it already has).
      if (!md.created(content)) content = md.setMeta(content, 'created', md.formatStamp());
      await fsp.mkdir(coll.dir, { recursive: true });
      await store.writeAtomic(coll.file(slugged), content);
      return json(res, 201, await coll.read(slugged));
    }
    throw httpError(405, 'Method not allowed');
  }

  if (!store.isSlug(slug)) throw httpError(400, 'Invalid name');
  const file = coll.file(slug);

  if (!action && method === 'GET') return json(res, 200, await coll.read(slug));

  if (!action && method === 'PUT') {
    const { content, mtime } = await readJson(req);
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    const stat = await fsp.stat(file).catch(() => null);
    // Someone (another editor, git, VS Code) changed the file since we loaded it.
    if (stat && mtime != null && Math.abs(stat.mtimeMs - mtime) > 0.5) {
      return json(res, 409, { error: 'Changed on disk', ...(await coll.read(slug)) });
    }
    // Keep the text that's about to be replaced (at most every few minutes).
    if (stat) await history.beforeWrite(coll, slug, file, stat).catch((err) => console.error('history:', err));
    await store.writeAtomic(file, content);
    return json(res, 200, { slug, mtime: (await fsp.stat(file)).mtimeMs });
  }

  if (!action && method === 'DELETE') {
    await fsp.mkdir(coll.trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.rename(file, path.join(coll.trash, `${slug}-${stamp}.md`));
    await history.trash(coll, slug, stamp).catch((err) => console.error('history:', err));
    return json(res, 200, { ok: true, trashed: `${coll.folder}/.trash/${slug}-${stamp}.md` });
  }

  if (action === 'rename' && method === 'POST') {
    const { to } = await readJson(req);
    const next = store.isSlug(String(to || '')) ? String(to).toLowerCase() : store.slugify(to || '');
    if (next !== slug) {
      if (await store.exists(coll.file(next))) throw httpError(409, `${coll.folder}/${next}.md already exists`);
      await fsp.access(file);
      await fsp.rename(file, coll.file(next));
      await history.rename(coll, slug, next).catch((err) => console.error('history:', err));
      const key = (s) => (coll.kind === 'thoughts' ? `thoughts/${s}` : s); // how links refer to it
      if (!isNote) await links.renameArticle(key(slug), key(next)).catch((err) => console.error('links:', err));
    }
    if (!isNote) {
      // Keep the slug: line in step with the file name.
      const { content } = await coll.read(next);
      if (md.frontMatter(content).data.slug !== next) {
        await store.writeAtomic(coll.file(next), md.setMeta(content, 'slug', next, { after: 'title' }));
      }
    }
    return json(res, 200, await coll.read(next));
  }

  if (action === 'history') {
    // GET  …/history        → list of versions, newest first
    // GET  …/history/<id>   → one version's text
    // POST …/history        → save the current file as a (named) version
    if (!versionId && method === 'GET') return json(res, 200, await history.list(coll, slug));
    if (versionId && method === 'GET') {
      if (!history.isId(versionId)) throw httpError(400, 'Invalid version');
      return json(res, 200, { id: versionId, content: await history.read(coll, slug, versionId) });
    }
    if (!versionId && method === 'POST') {
      const { label } = await readJson(req);
      const { content, mtime } = await coll.read(slug);
      const id = await history.snapshot(coll, slug, content, mtime, String(label || '').trim().slice(0, 120));
      return json(res, 201, { id });
    }
    throw httpError(405, 'Method not allowed');
  }

  if (action === 'publish' && method === 'POST' && coll.kind === 'thoughts') {
    const { overwrite } = await readJson(req);
    const stat = await fsp.stat(file);
    const { content } = await coll.read(slug);
    let result;
    try {
      result = await publisher.publish(slug, content, { overwrite: !!overwrite });
    } catch (err) {
      if (err.status === 409) return json(res, 409, { error: err.message, needsConfirm: true });
      throw err;
    }
    // The draft now says published (and has a date) — keep the old text in history.
    if (result.draft !== content) {
      await history.beforeWrite(coll, slug, file, stat).catch((err) => console.error('history:', err));
      await store.writeAtomic(file, result.draft);
    }
    const saved = await coll.read(slug);
    return json(res, 200, { ...result, draft: undefined, content: saved.content, mtime: saved.mtime });
  }

  if (action === 'export' && method === 'GET') {
    const { content, mtime } = await coll.read(slug);
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

// /api/links — saved links with tags.
async function linksApi(req, res, id, action) {
  const method = req.method;
  if (!id) {
    if (method === 'GET') return json(res, 200, await links.list());
    if (method === 'POST') {
      try {
        return json(res, 201, await links.add((await readJson(req)).url));
      } catch (err) {
        if (err.status === 409) return json(res, 409, { error: err.message, link: err.link });
        throw err;
      }
    }
    throw httpError(405, 'Method not allowed');
  }
  if (id === 'restore' && method === 'POST') return json(res, 200, await links.restore((await readJson(req)).link));
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(400, 'Invalid link');
  if (!action && method === 'PATCH') return json(res, 200, await links.update(id, await readJson(req)));
  if (!action && method === 'DELETE') return json(res, 200, await links.remove(id));
  if (action === 'suggest-tags' && method === 'POST') {
    const link = await links.get(id);
    const current = links.cleanTags((await readJson(req)).current || link.tags); // tags in the editor, maybe unsaved
    const existing = [...new Set([...(await links.list()).flatMap((l) => l.tags), ...current])].sort();
    const { tags } = await suggestTags({ ...link, current, existing });
    return json(res, 200, { tags: links.cleanTags(tags).filter((t) => !current.includes(t)) });
  }
  throw httpError(404, 'Not found');
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
      if (parts[1] === 'links' && parts.length <= 4) return await linksApi(req, res, parts[2], parts[3]);
      if (parts[1] === 'site' && parts[2] === 'categories' && req.method === 'GET') return json(res, 200, await publisher.categories());
      const coll = store.collection(parts[1]);
      if (coll && parts.length <= 5) return await documentsApi(req, res, coll, parts[2], parts[3], parts[4]);
      if (parts[1] === 'images' && parts.length === 2) return await imagesApi(req, res, url);
      if (parts[1] === 'suggest' && parts.length === 2 && req.method === 'POST') {
        return json(res, 200, await suggest(await readJson(req)));
      }
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
  console.log(`  articles:    ${path.relative(process.cwd(), store.ARTICLES) || '.'}/`);
  console.log(`  thoughts:    ${path.relative(process.cwd(), store.THOUGHTS) || '.'}/  →  publishes to ${process.env.THOUGHTS_SITE || '(set THOUGHTS_SITE in .env)'}`);
  console.log(`  quick notes: ${path.relative(process.cwd(), store.NOTES) || '.'}/`);
  console.log(`  links:       ${path.relative(process.cwd(), links.DIR) || '.'}/`);
  console.log(`  images:      ${path.relative(process.cwd(), store.IMAGES) || '.'}/\n`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [address], () => {});
  }
});
