'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaude, alternativesRequest, tagsRequest, MODEL } = require('../lib/claude');

const answering = (json, extra = {}) => {
  const bridge = { asked: [], async askClaude(req) { bridge.asked.push(req); return { text: typeof json === 'string' ? json : JSON.stringify(json), model: MODEL, stopReason: 'end_turn', ...extra }; } };
  return bridge;
};

test('asks for rewordings of the highlight in its paragraph', async () => {
  const bridge = answering({ suggestions: [
    { text: 'crucial', note: 'More concise' }, { text: 'very important', note: 'Same' }, { text: 'crucial', note: 'Again' }, { text: '  ', note: 'Blank' }, { text: 'key', note: 'Plainer' },
  ] });
  const r = await createClaude(bridge).suggestAlternatives({ selection: 'very important', before: 'This is a ', after: ' point.', title: 'Craft' });
  assert.deepEqual(r.suggestions.map((s) => s.text), ['crucial', 'key']); // no repeats, blanks or the original
  const req = bridge.asked[0];
  assert.equal(req.model, MODEL);
  assert.match(req.prompt, /^Article: Craft\n\n.*\nThis is a ⟦very important⟧ point\.\n\nHighlighted text: very important$/s);
  assert.equal(req.schema.required[0], 'suggestions');
  assert.equal(req.effort, 'low');
});

test('refuses an empty or very long highlight before asking', () => {
  assert.throws(() => alternativesRequest({ selection: '  ' }), { status: 400 });
  assert.throws(() => alternativesRequest({ selection: 'x'.repeat(1501) }), { status: 400 });
});

test('tags: tells Claude the link’s tags and the library’s', async () => {
  const bridge = answering({ tags: ['ux', 'typography'] });
  const r = await createClaude(bridge).suggestTags({ title: 'On Type', url: 'https://x.com', current: ['design'], existing: ['design', 'ux'] });
  assert.deepEqual(r.tags, ['ux', 'typography']);
  assert.match(bridge.asked[0].prompt, /Tags this link already has: design/);
  assert.match(bridge.asked[0].prompt, /Tags already in the library: design, ux/);
  assert.match(tagsRequest({ title: 'T', url: 'u' }).prompt, /The library has no tags yet\./);
});

test('a refusal or an unreadable answer becomes a clear error', async () => {
  await assert.rejects(createClaude(answering('{}', { stopReason: 'refusal' })).suggestTags({}), { status: 422 });
  await assert.rejects(createClaude(answering('not json')).suggestAlternatives({ selection: 'x' }), { status: 502 });
});
