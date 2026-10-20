'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { writingStats, activity } = require('../lib/stats');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 20, 18, 0).getTime(); // Tue Oct 20 2026, 6 pm
const at = (daysAgo, hour = 10) => { const d = new Date(NOW - daysAgo * DAY); d.setHours(hour, 0, 0, 0); return d.getTime(); };

// An article started 10 days ago and written over several days; a published import.
const draft = {
  kind: 'articles',
  doc: { slug: 'draft', words: 900, mtime: at(1), created: at(10), published: null, status: 'editing' },
  versions: [{ time: at(10), words: 0 }, { time: at(9), words: 300 }, { time: at(3), words: 600 }],
};
const imported = {
  kind: 'articles',
  doc: { slug: 'old', words: 1200, mtime: at(2), created: at(2), published: new Date(2024, 2, 1).getTime(), status: 'published' },
  versions: [],
};

test('words and days written in the last 7 days, against the 7 before', () => {
  const s = writingStats([draft, imported], NOW);
  assert.equal(s.words, 600); // 300 words at 8 days ago → 900 now; the import was published long before
  assert.equal(s.wordsBefore, 300); // 0 → 300 between 14 and 7 days ago
  assert.equal(s.days, 3); // 3 and 1 days ago (draft), 2 days ago (import edited)
  assert.equal(s.daysBefore, 2); // 10 and 9 days ago
  assert.deepEqual([s.inProgress, s.ready, s.published], [1, 0, 1]);
});

test('the activity graph covers 53 weeks from a Sunday, counting growth on the day it happened', () => {
  const saved = { links: [{ created: at(1) }], quotes: [{ created: at(1) }, { created: at(400) }], posts: [] };
  const a = activity([draft, imported], saved, NOW);
  assert.equal(new Date(`${a.start}T12:00`).getDay(), 0);
  assert.equal(a.days.length, 53 * 7 - (6 - new Date(NOW).getDay()));
  const on = (daysAgo) => a.days.find((d) => d.date === a.days[a.days.length - 1 - daysAgo].date);
  assert.equal(on(9).words, 300);
  assert.equal(on(3).words, 300);
  assert.equal(on(1).words, 300);
  assert.equal(on(1).links, 1);
  assert.equal(on(1).quotes, 1); // the quote from 400 days ago is outside the graph
  assert.equal(on(2).pieces, 1);
  assert.equal(a.days.reduce((n, d) => n + d.quotes, 0), 1);
});
