'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocuments } = require('../lib/documents');

const NOW = new Date(2026, 9, 20, 9, 5).getTime(); // Tue Oct 20 2026, 9:05 local

// In-memory files that behave like the server's /api/files: versions (mtime),
// refused stale writes and creates, moves of files and folders.
function memoryFiles(start = NOW) {
  const files = new Map(); // path → { content, mtime }
  let clock = start;
  const err = (status, message, data = {}) => Object.assign(new Error(message), { status, data: { error: message, ...data } });
  const under = (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  return {
    files,
    async listFiles(dir, { content = false } = {}) {
      const names = new Map();
      for (const p of under(dir)) {
        const [name, ...rest] = p.slice(dir.length + 1).split('/');
        if (!names.has(name)) names.set(name, rest.length ? { name, dir: true, mtime: 0 } : { name, dir: false, mtime: files.get(p).mtime, ...(content && { content: files.get(p).content }) });
      }
      return [...names.values()];
    },
    async readFile(path) {
      if (!files.has(path)) throw err(404, `${path} isn’t there`);
      return { ...files.get(path) };
    },
    async writeFile(path, content, { mtime = null, create = false } = {}) {
      const cur = files.get(path);
      if (create && cur) throw err(409, 'exists', { exists: true });
      if (!create && cur && mtime != null && cur.mtime !== mtime) throw err(409, 'Changed on disk', { current: { ...cur } });
      files.set(path, { content, mtime: ++clock });
      return { mtime: clock };
    },
    async moveFile(from, to) {
      const moving = files.has(from) ? [from] : under(from);
      if (!moving.length) throw err(404, `${from} isn’t there`);
      if (files.has(to) || under(to).length) throw err(409, 'exists');
      for (const p of moving) { files.set(to + p.slice(from.length), files.get(p)); files.delete(p); }
      return { ok: true };
    },
    async deleteFile(path) { files.delete(path); return { ok: true }; },
    tick(ms) { clock += ms; },
  };
}

const make = (bridge, now = () => NOW) => createDocuments(bridge, { now });

test('a new article gets title, slug, status and created in its front matter', async () => {
  const bridge = memoryFiles();
  const docs = make(bridge);
  const a = await docs.create('articles', { title: 'The Conductor’s Role' });
  assert.equal(a.slug, 'the-conductors-role');
  assert.equal(a.content, '---\ntitle: The Conductor’s Role\nslug: the-conductors-role\nstatus: backlog\ncreated: 2026-10-20 09:05\n---\n\n');
  const b = await docs.create('articles', { title: 'The Conductor’s Role' });
  assert.equal(b.slug, 'the-conductors-role-2');
  assert.match(b.content, /slug: the-conductors-role-2/);
  const t = await docs.create('thoughts', { title: 'Craft' });
  assert.match(t.content, /category: \ndescription: \ntags:\nogImage: \n/);
});

test('notes are named for when they were made; the journal keeps one entry a day', async () => {
  const docs = make(memoryFiles());
  assert.equal((await docs.create('notes')).slug, '2026-10-20-0905');
  assert.equal((await docs.create('notes')).slug, '2026-10-20-0905-2');
  const first = await docs.create('journal');
  assert.equal(first.slug, '2026-10-20');
  await docs.save('journal', first.slug, `${first.content}\nWalked the river.\n`, { previous: first });
  const again = await docs.create('journal');
  assert.equal(again.slug, '2026-10-20');
  assert.match(again.content, /Walked the river/);
});

test('importing keeps the text, lifts the title, and can mark it published with its date', async () => {
  const docs = make(memoryFiles());
  const a = await docs.create('articles', { content: '﻿# Old Post\r\n\r\nBody.', filename: 'old-post.md', name: 'old-post', published: true, date: '2024-03-02' });
  assert.equal(a.slug, 'old-post');
  assert.match(a.content, /^---\ntitle: Old Post\nslug: old-post\nstatus: published\ndate: 2024-03-02\ncreated: /);
  assert.match(a.content, /\n\nBody\.$/);
  const kept = await docs.create('notes', { content: '---\ncreated: 2025-01-01 08:00\n---\n\nhi', filename: 'x.md', name: 'kept' });
  assert.match(kept.content, /created: 2025-01-01 08:00/);
});

test('lists documents newest first with their titles and details', async () => {
  const bridge = memoryFiles();
  const docs = make(bridge);
  await docs.create('articles', { title: 'First' });
  await docs.create('articles', { title: 'Second' });
  bridge.files.set('articles/README.txt', { content: 'x', mtime: 1 });
  const list = await docs.list('articles');
  assert.deepEqual(list.map((d) => d.title), ['Second', 'First']);
  assert.equal(list[0].status, 'backlog');
  assert.deepEqual(await docs.list('thoughts'), []);
});

test('saving refuses to overwrite a change made elsewhere, unless forced', async () => {
  const bridge = memoryFiles();
  const docs = make(bridge);
  const a = await docs.create('articles', { title: 'Draft' });
  await bridge.writeFile('articles/draft.md', 'edited in VS Code'); // someone else saves
  await assert.rejects(docs.save('articles', 'draft', 'mine', { previous: a }), (err) => err.status === 409 && err.data.content === 'edited in VS Code' && err.data.slug === 'draft');
  await docs.save('articles', 'draft', 'mine', { previous: a, force: true });
  assert.equal((await docs.read('articles', 'draft')).content, 'mine');
});

test('history keeps the old text before a save, at most every few minutes, and names versions', async () => {
  let now = NOW;
  const bridge = memoryFiles();
  const docs = make(bridge, () => now);
  let doc = await docs.create('articles', { title: 'Draft' });
  const saveAs = async (content) => { const r = await docs.save('articles', 'draft', content, { previous: doc }); doc = { ...doc, content, mtime: r.mtime }; };
  await saveAs(`${doc.content}one`); // first save keeps the starting text
  await saveAs(`${doc.content} two`); // too soon for another version
  assert.equal((await docs.versions('articles', 'draft')).length, 1);
  bridge.tick(6 * 60 * 1000);
  await saveAs(`${doc.content} three`); // replaces text saved just after the first version: still no new one
  assert.equal((await docs.versions('articles', 'draft')).length, 1);
  await saveAs(`${doc.content} four`); // replaces text saved 6 minutes later: kept
  const versions = await docs.versions('articles', 'draft');
  assert.equal(versions.length, 2);
  assert.match((await docs.version('articles', 'draft', versions[0].id)).content, /one two three$/);
  const id = await docs.saveVersion('articles', 'draft', 'Before restructuring');
  assert.equal((await docs.versions('articles', 'draft')).find((v) => v.id === id).label, 'Before restructuring');
  await assert.rejects(docs.version('articles', 'draft', '../../etc'), { status: 400 });
});

test('old automatic versions thin out; named ones stay', async () => {
  const bridge = memoryFiles();
  const day = 24 * 60 * 60 * 1000;
  const old = new Date(NOW - 30 * day);
  const id = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
  // Four versions within one day a month ago; one of them named.
  const ids = [0, 1, 2, 3].map((h) => id(old.getTime() + h * 60 * 60 * 1000));
  for (const v of ids) bridge.files.set(`articles/.history/draft/${v}.md`, { content: v, mtime: 1 });
  bridge.files.set('articles/.history/draft/labels.json', { content: JSON.stringify({ [ids[0]]: 'Keep me' }), mtime: 1 });
  bridge.files.set('articles/draft.md', { content: 'now', mtime: 5 });
  await make(bridge).saveVersion('articles', 'draft');
  const left = (await make(bridge).versions('articles', 'draft')).map((v) => v.id);
  assert.ok(left.includes(ids[0]), 'named version kept');
  assert.ok(left.includes(ids[3]), 'newest of that day kept');
  assert.ok(!left.includes(ids[1]) && !left.includes(ids[2]), 'the rest of that day thinned out');
});

test('rename moves the file and its history and keeps slug: in step; trash takes both', async () => {
  const bridge = memoryFiles();
  const docs = make(bridge);
  const a = await docs.create('articles', { title: 'Old Name' });
  await docs.saveVersion('articles', 'old-name', 'v1');
  await docs.create('articles', { title: 'Taken' });
  await assert.rejects(docs.rename('articles', 'old-name', 'taken'), { status: 409 });
  const moved = await docs.rename('articles', a.slug, 'New Name');
  assert.equal(moved.slug, 'new-name');
  assert.match(moved.content, /slug: new-name/);
  assert.equal((await docs.versions('articles', 'new-name')).length, 1);
  assert.equal((await docs.versions('articles', 'old-name')).length, 0);
  const { trashed } = await docs.trash('articles', 'new-name');
  assert.match(trashed, /^articles\/\.trash\/new-name-.*\.md$/);
  assert.ok([...bridge.files.keys()].some((p) => /^articles\/\.trash\/new-name-.*\.history\//.test(p)));
  assert.deepEqual((await docs.list('articles')).map((d) => d.slug), ['taken']);
});
