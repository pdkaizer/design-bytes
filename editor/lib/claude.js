/*
 * What DB Writer asks Claude, and how it reads the answers: rewordings for the
 * Alternatives panel (⌘J) and subject tags for saved links. Runs in the page
 * (window.DBClaude) and in Node (require, for tests). The request itself goes
 * through the bridge's askClaude, which holds the API key.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBClaude = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MODEL = 'claude-opus-5-5';
  const MAX_SELECTION = 1500;

  const fail = (status, message) => Object.assign(new Error(message), { status, data: { error: message } });

  // ---------------------------------------------------------------------------
  // Alternatives

  const ALTERNATIVES_SYSTEM = `You are the line editor for Design Bytes, a blog of essays about design, craft and technology.

The writer has highlighted part of an article and wants alternative wordings for it. Offer five alternatives that:
- fit the surrounding sentence exactly, so each one can replace the highlighted text as-is (same grammatical role, capitalization and punctuation at the edges);
- keep the writer's meaning, voice and any Markdown formatting or links inside the highlight;
- differ from each other in a useful way — for example more concise, more vivid, plainer, more precise, or a different rhythm — rather than being near-synonyms of one another.

For a single word, give real word alternatives that suit the context. For a sentence or longer passage, rewrite it. Never return the original wording unchanged.

For each alternative, add a note of two to five words saying what it does differently (for example "More concise", "Warmer tone", "Stronger verb").`;

  const ALTERNATIVES_SCHEMA = {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Replacement for the highlighted text' },
            note: { type: 'string', description: 'Two to five words on what this alternative does differently' },
          },
          required: ['text', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  };

  // The request for five rewordings of `selection`, seen in its paragraph.
  function alternativesRequest({ selection, before = '', after = '', title = '' }) {
    const text = String(selection || '').trim();
    if (!text) throw fail(400, 'Highlight some text first.');
    if (text.length > MAX_SELECTION) throw fail(400, 'That selection is too long — highlight a sentence or two at most.');
    const prompt = [
      ...(title ? [`Article: ${title}`, ''] : []),
      'The highlighted text is marked with ⟦ ⟧ in its paragraph:',
      `${String(before).slice(-1500)}⟦${text}⟧${String(after).slice(0, 1500)}`,
      '',
      `Highlighted text: ${text}`,
    ].join('\n');
    // Low effort keeps this snappy; rewording a phrase doesn't need deep reasoning.
    return { model: MODEL, system: ALTERNATIVES_SYSTEM, prompt, schema: ALTERNATIVES_SCHEMA, maxTokens: 4000, effort: 'low' };
  }

  // The rewordings in an answer, without blanks, repeats or the original wording.
  function parseAlternatives(answer, selection) {
    const parsed = readJson(answer, 'Claude declined to suggest alternatives for this passage.');
    const seen = new Set([String(selection || '').trim()]);
    return (parsed.suggestions || [])
      .map((s) => ({ text: String(s?.text || '').trim(), note: String(s?.note || '').trim() }))
      .filter((s) => s.text && !seen.has(s.text) && seen.add(s.text));
  }

  // ---------------------------------------------------------------------------
  // Tags for saved links

  const TAGS_SYSTEM = `You help a design writer organise a library of saved links by subject.

Given one link (its title, address and description) and the tags already used in the library, suggest 2 to 5 tags describing what the link is about.
- Reuse an existing tag whenever it fits, so the library's vocabulary stays consistent; only add a new tag for a subject the existing ones don't cover.
- Tags are short, lowercase, and use dashes instead of spaces (for example "design-systems", "typography", "ai").
- Describe the subject matter, not the format or the website (avoid tags like "article", "blog", or the site's name).`;

  const TAGS_SCHEMA = {
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' }, description: 'Subject tags for the link' },
    },
    required: ['tags'],
    additionalProperties: false,
  };

  function tagsRequest({ title = '', url = '', description = '', note = '', current = [], existing = [] }) {
    const lines = [`Title: ${title}`, `Address: ${url}`];
    if (description) lines.push(`Description: ${description}`);
    if (note) lines.push(`The writer's note: ${note}`);
    if (current.length) lines.push(`Tags this link already has: ${current.join(', ')} — suggest only additional ones, not variations of these.`);
    lines.push('', existing.length ? `Tags already in the library: ${existing.join(', ')}` : 'The library has no tags yet.');
    return { model: MODEL, system: TAGS_SYSTEM, prompt: lines.join('\n'), schema: TAGS_SCHEMA, maxTokens: 2000, effort: 'low' };
  }

  const parseTags = (answer) => {
    const tags = readJson(answer, 'Claude declined to suggest tags for this link.').tags;
    return Array.isArray(tags) ? tags.map(String) : [];
  };

  // ---------------------------------------------------------------------------

  // answer: { text, stopReason } from the bridge's askClaude.
  function readJson(answer, declined) {
    if (answer?.stopReason === 'refusal') throw fail(422, declined);
    try {
      const parsed = JSON.parse(answer?.text || '');
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through */ }
    throw fail(502, 'Got an unexpected response — try again.');
  }

  // bridge.askClaude({ model, system, prompt, schema, maxTokens, effort }) → { text, model, stopReason }.
  function createClaude(bridge) {
    return {
      async suggestAlternatives(request) {
        const answer = await bridge.askClaude(alternativesRequest(request));
        return { suggestions: parseAlternatives(answer, request.selection), model: answer.model };
      },
      async suggestTags(link) {
        return { tags: parseTags(await bridge.askClaude(tagsRequest(link))) };
      },
    };
  }

  return { createClaude, alternativesRequest, parseAlternatives, tagsRequest, parseTags, MODEL };
});
