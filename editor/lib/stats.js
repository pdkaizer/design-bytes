'use strict';

// Writing stats for the Home page, worked out from version history: how many
// words each piece had at a point in time, compared with how many it has now.
// Versions are kept every few minutes while writing, so these are close estimates.

const store = require('./store');
const history = require('./history');

const DAY = 24 * 60 * 60 * 1000;
const KINDS = ['articles', 'thoughts', 'notes'];

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

async function writingStats(now = Date.now()) {
  const weekAgo = now - 7 * DAY;
  const twoWeeksAgo = now - 14 * DAY;
  let words = 0;
  let wordsBefore = 0;
  const days = new Set();
  const daysBefore = new Set();
  const counts = { inProgress: 0, ready: 0, published: 0 };

  for (const kind of KINDS) {
    const coll = store.collection(kind);
    for (const doc of await coll.list()) {
      if (doc.status === 'final') counts.ready++;
      else if (doc.status === 'published') counts.published++;
      else if (doc.status) counts.inProgress++;

      const versions = (await history.list(coll, doc.slug)).sort((a, b) => a.time - b.time);
      // A piece published before it was added (an imported back-catalogue piece) counts from its publish date.
      const created = Math.min(doc.created ?? versions[0]?.time ?? doc.mtime, doc.published ?? Infinity);
      // Words the piece had at time t: its newest version from before then.
      const wordsAt = (t) => {
        if (created > t) return 0;
        let best = null;
        for (const v of versions) if (v.time <= t) best = v;
        return best ? best.words : (versions[0]?.words ?? doc.words);
      };
      words += Math.max(0, doc.words - wordsAt(weekAgo));
      wordsBefore += Math.max(0, wordsAt(weekAgo) - wordsAt(twoWeeksAgo));

      for (const t of [...versions.map((v) => v.time), doc.mtime]) {
        if (t > weekAgo && t <= now) days.add(dayKey(t));
        else if (t > twoWeeksAgo && t <= weekAgo) daysBefore.add(dayKey(t));
      }
    }
  }

  return {
    words, wordsBefore,
    days: days.size, daysBefore: daysBefore.size,
    ...counts,
  };
}

// Daily activity for the last 53 weeks, like a GitHub contribution graph:
// words written each day (growth in word count between saved versions), the
// pieces you worked on, and the links, quotes and social posts you saved.
// Growth between a piece being added and its first saved version counts on the
// day it was added (so an imported piece counts on its import day).
async function activity(now = Date.now()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 52 * 7 - end.getDay()); // a Sunday, 53 columns ago
  const days = new Map();
  const iso = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const day = (ms) => {
    const key = iso(ms);
    if (!days.has(key)) days.set(key, { words: 0, pieces: new Set(), links: 0, quotes: 0, posts: 0 });
    return days.get(key);
  };

  for (const kind of KINDS) {
    const coll = store.collection(kind);
    for (const doc of await coll.list()) {
      const versions = (await history.list(coll, doc.slug)).sort((a, b) => a.time - b.time);
      const points = [...versions.map((v) => ({ t: v.time, w: v.words })), { t: doc.mtime, w: doc.words }];
      const since = Math.min(doc.created ?? Infinity, doc.published ?? Infinity); // published earlier → count it then
      if (since < points[0].t) points.unshift({ t: since, w: 0, added: true });
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.t < start.getTime()) continue;
        const d = day(p.t);
        d.pieces.add(`${kind}/${doc.slug}`);
        if (i === 0) continue;
        const grew = Math.max(0, p.w - points[i - 1].w);
        if (!grew) continue;
        // Growth right after a piece was added belongs to the day it was added.
        const when = points[i - 1].added ? points[i - 1].t : p.t;
        if (when >= start.getTime()) day(when).words += grew;
      }
    }
  }

  const tally = async (file, key, field) => {
    try {
      const data = JSON.parse(await require('fs').promises.readFile(require('path').join(store.ROOT, file), 'utf8'))[key] || [];
      for (const item of data) if (item.created >= start.getTime()) day(item.created)[field]++;
    } catch { /* nothing saved yet */ }
  };
  await tally('links/links.json', 'links', 'links');
  await tally('quotes/quotes.json', 'quotes', 'quotes');
  await tally('social/posts.json', 'posts', 'posts');

  const out = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const a = days.get(iso(d.getTime()));
    out.push(a ? { date: iso(d.getTime()), words: a.words, pieces: a.pieces.size, links: a.links, quotes: a.quotes, posts: a.posts }
      : { date: iso(d.getTime()), words: 0, pieces: 0, links: 0, quotes: 0, posts: 0 });
  }
  return { start: iso(start.getTime()), days: out };
}

module.exports = { writingStats, activity };
