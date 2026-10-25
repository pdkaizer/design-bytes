'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createThoughtSite, prepare, ogImageFor, siteVersion, categories } = require('../lib/thoughtsite');

const DRAFT = `---
title: Restraint
slug: restraint
category: Philosophy
description: Less, but better.
status: final
created: 2026-10-20 09:00
tags:
  - craft
---

The body.

<!-- notes
private
-->
`;

test('the site’s version drops DB Writer’s fields and private notes', () => {
  assert.equal(siteVersion(DRAFT), '---\ntitle: Restraint\ncategory: Philosophy\ndescription: Less, but better.\ntags:\n  - craft\n---\n\nThe body.\n');
});

test('publishing fills in the date and marks the draft published', () => {
  const p = prepare('restraint', DRAFT, null, { date: '2026-10-22' });
  assert.match(p.draft, /description: Less, but better\.\ndate: 2026-10-22\nstatus: published/);
  assert.match(p.content, /^---\ntitle: Restraint\ncategory: Philosophy\ndescription: Less, but better\.\ndate: 2026-10-22\n/);
  assert.equal(p.message, 'Add thought: Restraint');
  assert.equal(p.changed, true);
  // Publishing again: same file, nothing to change, and it's an update.
  const again = prepare('restraint', p.draft, p.content, { date: '2026-10-23' });
  assert.equal(again.changed, false);
  assert.equal(again.message, 'Update thought: Restraint');
});

test('it won’t replace a different post DB Writer didn’t publish without asking', () => {
  assert.throws(() => prepare('restraint', DRAFT, '---\ntitle: Theirs\n---\n\nOther.\n'), (e) => e.status === 409 && e.data.needsConfirm);
  assert.equal(prepare('restraint', DRAFT, '---\ntitle: Theirs\n---\n\nOther.\n', { overwrite: true }).changed, true);
  assert.throws(() => prepare('x', '---\ntitle: \n---\n\nNo title.'), { status: 400 });
});

test('categories: most used first, the usual ones always offered', () => {
  const c = categories(['---\ncategory: Craft\n---\n', '---\ncategory: Craft\n---\n', '---\ncategory: Layout\n---\n', 'no front matter']);
  assert.deepEqual(c.slice(0, 2), ['Craft', 'Layout']);
  assert.ok(c.includes('Typography'));
});

test('publish writes only when changed, then commits; categories fall back when the site isn’t set up', async () => {
  const calls = [];
  const files = new Map();
  const bridge = {
    async siteThoughts() { return [...files].map(([name, content]) => ({ name, content })); },
    async writeSiteThought(name, content) { calls.push(['write', name]); files.set(name, content); },
    async commitSiteThought(name, message) { calls.push(['commit', name, message]); return { committed: true, pushed: true }; },
  };
  const site = createThoughtSite(bridge, { now: () => new Date(2026, 9, 22) });
  const r = await site.publish('restraint', DRAFT);
  assert.equal(r.file, 'src/thoughts/restraint.md');
  assert.match(r.draft, /status: published/);
  assert.deepEqual(calls, [['write', 'restraint.md'], ['commit', 'restraint.md', 'Add thought: Restraint']]);
  calls.length = 0;
  await site.publish('restraint', r.draft);
  assert.deepEqual(calls, [['commit', 'restraint.md', 'Update thought: Restraint']]); // nothing new to write
  const broken = createThoughtSite({ siteThoughts: async () => { throw Object.assign(new Error('no site'), { status: 503 }); } });
  assert.ok((await broken.categories()).includes('Layout'));
  await assert.rejects(broken.publish('x', DRAFT), { status: 503 });
});

test('a chosen preview image is copied into the site and committed with the post', async () => {
  const draft = DRAFT.replace('description: Less, but better.\n', 'description: Less, but better.\nogImage: ../images/restraint-og.png\n');
  assert.deepEqual(ogImageFor('restraint', draft), { local: '../images/restraint-og.png', name: 'restraint.png', sitePath: '/assets/images/thoughts/restraint.png' });
  assert.equal(ogImageFor('x', '---\nogImage: /assets/images/thoughts/x.png\n---\n'), null, 'a path in the site is left alone');
  assert.equal(ogImageFor('x', '---\nogImage: ../images/notes.txt\n---\n'), null);
  assert.equal(ogImageFor('x', '---\nogImage: ../images/a.JPEG\n---\n').name, 'x.jpg');

  const calls = [];
  const files = new Map();
  const bridge = {
    async siteThoughts() { return [...files].map(([name, content]) => ({ name, content })); },
    async writeSiteThought(name, content) { calls.push(['post', name]); files.set(name, content); },
    async writeSiteImage(name, blob) { calls.push(['image', name, blob]); },
    async commitSiteThought(name, message, image) { calls.push(['commit', name, image]); return { committed: true, pushed: true }; },
  };
  const site = createThoughtSite(bridge, { now: () => new Date(2026, 9, 23), readImage: async (path) => `bytes of ${path}` });
  const r = await site.publish('restraint', draft);
  assert.deepEqual(calls, [['image', 'restraint.png', 'bytes of ../images/restraint-og.png'], ['post', 'restraint.md'], ['commit', 'restraint.md', 'restraint.png']]);
  assert.match(files.get('restraint.md'), /ogImage: \/assets\/images\/thoughts\/restraint\.png/, 'the site points at its own copy');
  assert.match(r.draft, /ogImage: \.\.\/images\/restraint-og\.png/, 'the draft keeps DB Writer’s copy');
  // Republishing the same thing: nothing new to write for the post.
  calls.length = 0;
  await site.publish('restraint', r.draft);
  assert.deepEqual(calls.map((c) => c[0]), ['image', 'commit']);
});

test('copyImage puts the chosen image in the site straight away', async () => {
  const writes = [];
  const site = createThoughtSite({ async writeSiteImage(name, blob) { writes.push([name, blob]); } }, { readImage: async (p) => `bytes of ${p}` });
  assert.equal(await site.copyImage('craft', '---\ntitle: Craft\nogImage: ../images/craft-og.jpeg\n---\n'), 'src/assets/images/thoughts/craft.jpg');
  assert.deepEqual(writes, [['craft.jpg', 'bytes of ../images/craft-og.jpeg']]);
  assert.equal(await site.copyImage('craft', '---\nogImage: /assets/images/thoughts/craft.png\n---\n'), null);
  assert.equal(writes.length, 1);
});
