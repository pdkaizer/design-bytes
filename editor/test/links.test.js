'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLinks, cleanTags } = require('../lib/links');
const memoryBridge = require('./memory-bridge');

let n = 0;
// A bridge whose page fetch and tag suggestions are stand-ins.
function bridgeWith({ details = { title: 'A page', description: 'About it', site: 'Example' }, tags = [] } = {}) {
  const bridge = memoryBridge();
  bridge.fetched = [];
  bridge.pageDetails = async (url) => { bridge.fetched.push(url); if (details instanceof Error) throw details; return details; };
  bridge.suggestTags = async (link) => { bridge.asked = link; return { tags }; };
  return bridge;
}
const make = (bridge) => createLinks(bridge, { now: () => 1000 + n, newId: () => `id-${++n}` });

test('saves a link with the page’s details, adding https:// when it’s missing', async () => {
  const bridge = bridgeWith();
  const links = make(bridge);
  const link = await links.add('example.com/post');
  assert.equal(link.url, 'https://example.com/post');
  assert.deepEqual([link.title, link.description, link.site], ['A page', 'About it', 'Example']);
  assert.deepEqual(bridge.fetched, ['https://example.com/post']);
  await assert.rejects(links.add(''), { status: 400 });
  await assert.rejects(links.add('ftp://example.com'), { status: 400 });
});

test('when the page can’t be read, names the link after its site and path', async () => {
  const link = await make(bridgeWith({ details: new Error('offline') })).add('https://www.example.com/a/b');
  assert.deepEqual([link.title, link.site, link.description], ['example.com/a/b', 'example.com', '']);
});

test('a link saved before (other scheme, www, slash or tracking codes) is found, not fetched again', async () => {
  const bridge = bridgeWith();
  const links = make(bridge);
  const first = await links.add('https://example.com/post/');
  await assert.rejects(links.add('http://www.example.com/post?utm_source=x'), (err) => err.status === 409 && err.data.link.id === first.id);
  assert.equal(bridge.fetched.length, 1);
});

test('edits clean tags, keep the title and refuse a bad address', async () => {
  const links = make(bridgeWith());
  const l = await links.add('https://example.com/x');
  const edited = await links.update(l.id, { title: '  ', tags: ['Design Systems', '#ux', 'ux'], articles: ['visual-hierarchy', 'bad slug'] });
  assert.equal(edited.title, 'A page');
  assert.deepEqual(edited.tags, ['design-systems', 'ux']);
  assert.deepEqual(edited.articles, ['visual-hierarchy']);
  await assert.rejects(links.update(l.id, { url: 'mailto:me@example.com' }), { status: 400 });
  assert.deepEqual(cleanTags('One, Two  Words,, ---'), ['one', 'two-words']);
});

test('delete, undo and following a renamed piece', async () => {
  const links = make(bridgeWith());
  const a = await links.add('https://example.com/a');
  await links.update(a.id, { articles: ['old-slug'] });
  const b = await links.add('https://example.com/b');
  const gone = await links.remove(a.id);
  await links.restore(gone);
  assert.deepEqual((await links.list()).map((l) => l.id), [b.id, a.id]);
  await links.renameArticle('old-slug', 'thoughts/new-slug');
  assert.deepEqual((await links.list()).find((l) => l.id === a.id).articles, ['thoughts/new-slug']);
});

test('tag suggestions see the library’s tags and leave out ones the link has', async () => {
  const bridge = bridgeWith({ tags: ['UX', 'Typography', 'design-systems'] });
  const links = make(bridge);
  const a = await links.add('https://example.com/a');
  await links.update(a.id, { tags: ['typography'] });
  const b = await links.add('https://example.com/b');
  const { tags } = await links.suggestTags(b.id, ['design-systems']);
  assert.deepEqual(tags, ['ux', 'typography']);
  assert.deepEqual(bridge.asked.existing, ['design-systems', 'typography']);
  assert.deepEqual(bridge.asked.current, ['design-systems']);
});
