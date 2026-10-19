'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuotes } = require('../lib/quotes');

// An in-memory bridge that behaves like the server: versions, and 409 on a stale write.
function memoryBridge(initial = null) {
  const file = { data: initial, version: initial ? 1 : null };
  return {
    file,
    writes: 0,
    async readData() { return JSON.parse(JSON.stringify({ data: file.data, version: file.version })); },
    async writeData(name, data, version) {
      if (version !== file.version) throw Object.assign(new Error('Changed since it was read'), { status: 409, data: {} });
      this.writes++;
      file.data = JSON.parse(JSON.stringify(data));
      file.version = (file.version || 0) + 1;
      return { version: file.version };
    },
  };
}

let n = 0;
const make = (bridge) => createQuotes(bridge, { now: () => 1000 + n, newId: () => `id-${++n}` });

test('adds quotes newest first, cleaning the text and author', async () => {
  const bridge = memoryBridge();
  const quotes = make(bridge);
  await quotes.add({ text: 'Less, but better.', author: 'Dieter Rams' });
  const q = await quotes.add({ text: '“Good design is honest.”', author: '— Rams', articles: ['visual-hierarchy', 'thoughts/craft', 'Bad Slug!'] });
  assert.equal(q.text, 'Good design is honest.');
  assert.equal(q.author, 'Rams');
  assert.deepEqual(q.articles, ['visual-hierarchy', 'thoughts/craft']);
  assert.deepEqual((await quotes.list()).map((x) => x.text), ['Good design is honest.', 'Less, but better.']);
});

test('refuses an empty quote and a duplicate, returning the one already saved', async () => {
  const quotes = make(memoryBridge());
  await assert.rejects(quotes.add({ text: '  ' }), { status: 400 });
  const first = await quotes.add({ text: 'Less, but better.' });
  await assert.rejects(quotes.add({ text: '"less but better"' }), (err) => err.status === 409 && err.data.quote.id === first.id);
});

test('edits never blank the text; deletes can be undone in date order', async () => {
  const quotes = make(memoryBridge());
  const a = await quotes.add({ text: 'One' });
  const b = await quotes.add({ text: 'Two' });
  assert.equal((await quotes.update(a.id, { text: '', note: 'kept' })).text, 'One');
  await assert.rejects(quotes.update('missing', { note: 'x' }), { status: 404 });
  const gone = await quotes.remove(b.id);
  assert.deepEqual((await quotes.list()).map((x) => x.id), [a.id]);
  await quotes.restore(gone);
  await quotes.restore(gone); // twice is harmless
  assert.deepEqual((await quotes.list()).map((x) => x.id), [b.id, a.id]);
});

test('quotes follow a renamed article, without saving when nothing changes', async () => {
  const bridge = memoryBridge();
  const quotes = make(bridge);
  const q = await quotes.add({ text: 'Moved', articles: ['old-name'] });
  await quotes.renameArticle('old-name', 'new-name');
  assert.deepEqual((await quotes.list()).find((x) => x.id === q.id).articles, ['new-name']);
  const writes = bridge.writes;
  await quotes.renameArticle('not-there', 'whatever');
  assert.equal(bridge.writes, writes);
});

test('a save made elsewhere in the meantime is kept, not overwritten', async () => {
  const bridge = memoryBridge();
  const here = make(bridge);
  const there = make(bridge); // another tab
  await here.add({ text: 'From this tab' });
  await there.add({ text: 'From the other tab' }); // here's copy is now stale
  await here.add({ text: 'This tab again' }); // refused once, retried on the latest copy
  assert.deepEqual((await here.list()).map((x) => x.text), ['This tab again', 'From the other tab', 'From this tab']);
});

test('list returns copies, so changing them doesn’t change what is saved', async () => {
  const quotes = make(memoryBridge());
  await quotes.add({ text: 'Original' });
  (await quotes.list())[0].text = 'Changed';
  assert.equal((await quotes.list())[0].text, 'Original');
});
