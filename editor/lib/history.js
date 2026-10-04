'use strict';

// Version history for articles, kept in articles/.history/<slug>/ (git-ignored).
// Each version is a full copy of the file, named after the time that text was
// saved: 2026-10-03T14-05-22-123Z.md. Named versions are listed in labels.json.

const fsp = require('fs').promises;
const path = require('path');
const { ARTICLES, TRASH, writeAtomic } = require('./store');
const md = require('./markdown');

const HISTORY = path.join(ARTICLES, '.history');
const GAP = 5 * 60 * 1000; // at most one automatic version every 5 minutes
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ID = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;

const isId = (id) => ID.test(id);
const dirFor = (slug) => path.join(HISTORY, slug);
const idFor = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const timeOf = (id) => Date.parse(id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));

async function readLabels(slug) {
  try { return JSON.parse(await fsp.readFile(path.join(dirFor(slug), 'labels.json'), 'utf8')); }
  catch { return {}; }
}

async function writeLabels(slug, labels) {
  await writeAtomic(path.join(dirFor(slug), 'labels.json'), JSON.stringify(labels, null, 2));
}

// Version ids, newest first.
async function ids(slug) {
  const names = await fsp.readdir(dirFor(slug)).catch(() => []);
  return names.filter((n) => n.endsWith('.md') && isId(n.slice(0, -3))).map((n) => n.slice(0, -3)).sort().reverse();
}

const read = (slug, id) => fsp.readFile(path.join(dirFor(slug), `${id}.md`), 'utf8');

async function list(slug) {
  const [all, labels] = await Promise.all([ids(slug), readLabels(slug)]);
  return Promise.all(all.map(async (id) => {
    const content = await read(slug, id);
    return { id, time: timeOf(id), label: labels[id] || '', words: md.stats(content).words };
  }));
}

// Saves `content` as a version from time `ms`, unless the newest version is
// already identical. Returns the id of the version that holds this text.
async function snapshot(slug, content, ms, label = '') {
  const [newest] = await ids(slug);
  let id = newest && (await read(slug, newest)) === content ? newest : null;
  if (!id) {
    id = idFor(ms);
    await fsp.mkdir(dirFor(slug), { recursive: true });
    await fsp.writeFile(path.join(dirFor(slug), `${id}.md`), content, { flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
  if (label) {
    const labels = await readLabels(slug);
    labels[id] = label;
    await writeLabels(slug, labels);
  }
  await prune(slug);
  return id;
}

// Called before an article is overwritten: keeps the text that's about to be
// replaced, if the last version is more than a few minutes old.
async function beforeWrite(slug, file, stat) {
  const [newest] = await ids(slug);
  if (newest && stat.mtimeMs - timeOf(newest) < GAP) return;
  await snapshot(slug, await fsp.readFile(file, 'utf8'), stat.mtimeMs);
}

// Keep everything from the last 2 days, then one version per hour for two
// weeks, then one per day. Named versions are always kept.
async function prune(slug) {
  const [all, labels] = await Promise.all([ids(slug), readLabels(slug)]);
  const now = Date.now();
  const seen = new Set();
  for (const id of all) {
    const age = now - timeOf(id);
    if (labels[id] || age < 2 * DAY) continue;
    const bucket = age < 14 * DAY ? `h${Math.floor(timeOf(id) / HOUR)}` : `d${Math.floor(timeOf(id) / DAY)}`;
    if (!seen.has(bucket)) { seen.add(bucket); continue; } // newest in its hour/day
    await fsp.unlink(path.join(dirFor(slug), `${id}.md`)).catch(() => {});
  }
}

async function rename(from, to) {
  await fsp.rename(dirFor(from), dirFor(to)).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

// When an article is trashed, its history goes with it.
async function trash(slug, stamp) {
  await fsp.mkdir(TRASH, { recursive: true });
  await fsp.rename(dirFor(slug), path.join(TRASH, `${slug}-${stamp}.history`)).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

module.exports = { isId, list, read, snapshot, beforeWrite, rename, trash, GAP };
