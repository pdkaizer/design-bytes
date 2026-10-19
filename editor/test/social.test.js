'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSocial } = require('../lib/social');
const memoryBridge = require('./memory-bridge');

let n = 0;
const make = (bridge) => createSocial(bridge, { now: () => 1000 + n, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });

test('saves a draft with only the networks and versions it knows', async () => {
  const bridge = memoryBridge();
  const social = make(bridge);
  const post = await social.add({ text: ' New article \r\n out now ', networks: ['x', 'myspace', 'bluesky'], versions: { x: 'Short one', bluesky: '  ', tiktok: 'no' } });
  assert.equal(post.text, 'New article \n out now');
  assert.deepEqual(post.networks, ['x', 'bluesky']);
  assert.deepEqual(post.versions, { x: 'Short one' });
  assert.equal(post.status, 'draft');
  assert.deepEqual(bridge.file.data.posts.map((p) => p.id), [post.id]);
  await assert.rejects(social.add({ text: '  ' }), { status: 400 });
});

test('a post is Posted once every network it’s for is marked, and Ready again if one is unmarked', async () => {
  const social = make(memoryBridge());
  const post = await social.add({ text: 'Hello', networks: ['x', 'mastodon'], status: 'ready' });
  assert.equal((await social.update(post.id, { posted: { x: 5 } })).status, 'ready');
  assert.equal((await social.update(post.id, { posted: { x: 5, mastodon: 6 } })).status, 'posted');
  assert.equal((await social.update(post.id, { posted: { x: 5 } })).status, 'ready');
  await assert.rejects(social.update('missing', { text: 'x' }), { status: 404 });
});

test('keeps only valid shares and piece references', async () => {
  const social = make(memoryBridge());
  const ok = await social.add({ text: 'Quote', shares: { type: 'quote', id: '11111111-1111-4111-8111-111111111111' }, articles: ['visual-hierarchy', 'thoughts/craft', 'Not ok!'] });
  assert.deepEqual(ok.shares, { type: 'quote', id: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(ok.articles, ['visual-hierarchy', 'thoughts/craft']);
  assert.equal((await social.add({ text: 'Bad', shares: { type: 'video', id: 'x' } })).shares, null);
});

test('delete, undo in date order, and following a renamed piece', async () => {
  const social = make(memoryBridge());
  const a = await social.add({ text: 'Older', articles: ['old-slug'] });
  const b = await social.add({ text: 'Newer' });
  const gone = await social.remove(a.id);
  await social.restore(gone);
  await social.restore(gone);
  assert.deepEqual((await social.list()).map((p) => p.id), [b.id, a.id]);
  await social.renameArticle('old-slug', 'new-slug');
  assert.deepEqual((await social.list()).find((p) => p.id === a.id).articles, ['new-slug']);
});

test('two tabs saving posts keep both', async () => {
  const bridge = memoryBridge();
  const here = make(bridge);
  const there = make(bridge);
  await here.add({ text: 'One' });
  await there.add({ text: 'Two' });
  await here.add({ text: 'Three' });
  assert.deepEqual((await there.list()).map((p) => p.text), ['Three', 'Two', 'One']);
});
