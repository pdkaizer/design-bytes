'use strict';

// The data files the page reads and writes through the bridge (public/bridge.js):
// whole JSON files, saved atomically. Each read returns a version (the file's
// modified time); a write must name the version it started from, and is refused
// if the file has changed since, so two tabs never overwrite each other's work.

const fsp = require('fs').promises;
const path = require('path');
const { ROOT, writeAtomic } = require('./store');

const FILES = {
  quotes: path.join(ROOT, 'quotes', 'quotes.json'),
  social: path.join(ROOT, 'social', 'posts.json'),
};

const fileFor = (name) => (Object.hasOwn(FILES, name) ? FILES[name] : null);

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function mtime(file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function read(name) {
  const file = fileFor(name);
  try {
    const [text, version] = await Promise.all([fsp.readFile(file, 'utf8'), mtime(file)]);
    return { data: JSON.parse(text), version };
  } catch (err) {
    if (err.code === 'ENOENT') return { data: null, version: null };
    throw err;
  }
}

function write(name, data, version) {
  const file = fileFor(name);
  return serial(async () => {
    const current = await mtime(file);
    const same = current === null ? version == null : version != null && Math.abs(current - version) < 0.5;
    if (!same) return { conflict: true };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    return { version: await mtime(file) };
  });
}

module.exports = { FILES, fileFor, read, write };
