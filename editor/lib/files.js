'use strict';

// Plain file access for the page, through the bridge (public/bridge.js): list,
// read, write, move and delete files inside the writing folders — articles/,
// thoughts/, quick-notes/ and journal/, with their .history and .trash. Paths
// are relative to the project, e.g. "articles/morris-material.md". Nothing
// outside those folders can be reached. A native app would do the same with
// the folders it was given.
//
// Every file has a version (its modified time). A write names the version it
// started from and is refused if the file changed since, so an edit made
// elsewhere (another tab, VS Code, git) is never silently overwritten.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ROOT, writeAtomic } = require('./store');

const FOLDERS = ['articles', 'thoughts', 'quick-notes', 'journal'];
const PART = /^(?:\.history|\.trash|[A-Za-z0-9][\w@.-]{0,150})$/;

class FileError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// "articles/.history/slug/2026-10-03T14-05-22-123Z.md" → an absolute path, or an error.
function resolve(rel) {
  const parts = String(rel || '').split('/');
  if (!FOLDERS.includes(parts[0]) || parts.length > 4 || !parts.slice(1).every((p) => PART.test(p) && !p.includes('..'))) {
    throw new FileError(400, `Not a writing folder path: ${rel}`);
  }
  return path.join(ROOT, ...parts);
}

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const stat = (file) => fsp.stat(file).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
const same = (a, b) => Math.abs(a - b) < 0.5;

// The files and folders in a folder: [{ name, dir, mtime, content? }]. A missing folder is empty.
async function list(rel, { content = false } = {}) {
  const dir = resolve(rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  const out = await Promise.all(entries.filter((e) => PART.test(e.name) && (e.isFile() || e.isDirectory())).map(async (e) => {
    const file = path.join(dir, e.name);
    const s = await stat(file);
    if (!s) return null;
    const item = { name: e.name, dir: e.isDirectory(), mtime: s.mtimeMs };
    if (content && !item.dir && /\.(md|json)$/.test(e.name)) item.content = await fsp.readFile(file, 'utf8');
    return item;
  }));
  return out.filter(Boolean);
}

async function read(rel) {
  const file = resolve(rel);
  const [content, s] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]).catch((err) => {
    throw err.code === 'ENOENT' ? new FileError(404, `${rel} isn’t there`) : err;
  });
  return { content, mtime: s.mtimeMs };
}

// create: the file must not exist yet. Otherwise, when mtime is given, the file
// must still be at that version (or missing, if it was never saved).
function write(rel, content, { mtime = null, create = false } = {}) {
  const file = resolve(rel);
  if (typeof content !== 'string') throw new FileError(400, 'content must be text');
  return serial(async () => {
    const s = await stat(file);
    if (create && s) throw new FileError(409, `${rel} already exists`, { exists: true });
    if (!create && s && mtime != null && !same(s.mtimeMs, mtime)) {
      throw new FileError(409, 'Changed on disk', { current: { content: await fsp.readFile(file, 'utf8'), mtime: s.mtimeMs } });
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (create) await fsp.writeFile(file, content, { flag: 'wx' });
    else await writeAtomic(file, content);
    return { mtime: (await fsp.stat(file)).mtimeMs };
  });
}

// Moves a file or folder. Refuses to replace something already at `to`.
function move(from, to) {
  const src = resolve(from);
  const dest = resolve(to);
  return serial(async () => {
    if (!(await stat(src))) throw new FileError(404, `${from} isn’t there`);
    if (await stat(dest)) throw new FileError(409, `${to} already exists`, { exists: true });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(src, dest);
    return { ok: true };
  });
}

// Deletes a file (never a folder). A file that's already gone is fine.
function remove(rel) {
  const file = resolve(rel);
  return serial(async () => {
    const s = await stat(file);
    if (s?.isDirectory()) throw new FileError(400, 'Only files can be deleted');
    if (s) await fsp.unlink(file);
    return { ok: true };
  });
}

module.exports = { FOLDERS, list, read, write, move, remove, FileError };
