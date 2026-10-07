'use strict';

// Rewording suggestions from Claude for a highlighted word, phrase or sentence.
// Needs ANTHROPIC_API_KEY — put it in a .env file at the project root
// (npm start loads it) or export it in your shell.

const { Anthropic } = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';
const MAX_SELECTION = 1500;

const SYSTEM = `You are the line editor for Design Bytes, a blog of essays about design, craft and technology.

The writer has highlighted part of an article and wants alternative wordings for it. Offer five alternatives that:
- fit the surrounding sentence exactly, so each one can replace the highlighted text as-is (same grammatical role, capitalization and punctuation at the edges);
- keep the writer's meaning, voice and any Markdown formatting or links inside the highlight;
- differ from each other in a useful way — for example more concise, more vivid, plainer, more precise, or a different rhythm — rather than being near-synonyms of one another.

For a single word, give real word alternatives that suit the context. For a sentence or longer passage, rewrite it. Never return the original wording unchanged.

For each alternative, add a note of two to five words saying what it does differently (for example "More concise", "Warmer tone", "Stronger verb").`;

const SCHEMA = {
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

class SuggestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new SuggestError(503,
      'Suggestions need an Anthropic API key. Add ANTHROPIC_API_KEY=… to a .env file in the project folder, then restart the writer.');
  }
  client ??= new Anthropic();
  return client;
}

async function suggest({ selection, before = '', after = '', title = '' }) {
  const text = String(selection || '').trim();
  if (!text) throw new SuggestError(400, 'Highlight some text first.');
  if (text.length > MAX_SELECTION) throw new SuggestError(400, 'That selection is too long — highlight a sentence or two at most.');

  const prompt = [
    ...(title ? [`Article: ${title}`, ''] : []),
    'The highlighted text is marked with ⟦ ⟧ in its paragraph:',
    `${String(before).slice(-1500)}⟦${text}⟧${String(after).slice(0, 1500)}`,
    '',
    `Highlighted text: ${text}`,
  ].join('\n');

  const anthropic = getClient();
  let response;
  try {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Low effort keeps this snappy; rewording a phrase doesn't need deep reasoning.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new SuggestError(503, 'Your Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.');
    if (err instanceof Anthropic.RateLimitError) throw new SuggestError(429, 'Rate limited by the Anthropic API — try again in a moment.');
    if (err instanceof Anthropic.APIError) throw new SuggestError(502, `Anthropic API error ${err.status ?? ''}: ${err.message}`.trim());
    throw new SuggestError(502, `Couldn’t reach the Anthropic API: ${err.message}`);
  }

  if (response.stop_reason === 'refusal') {
    throw new SuggestError(422, 'Claude declined to suggest alternatives for this passage.');
  }
  const block = response.content.find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(block?.text || '');
  } catch {
    throw new SuggestError(502, 'Got an unexpected response — try again.');
  }

  const seen = new Set([text]);
  const suggestions = (parsed.suggestions || [])
    .map((s) => ({ text: String(s.text || '').trim(), note: String(s.note || '').trim() }))
    .filter((s) => s.text && !seen.has(s.text) && seen.add(s.text));
  return { suggestions, model: response.model };
}

const TAG_SCHEMA = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' }, description: 'Subject tags for the link' },
  },
  required: ['tags'],
  additionalProperties: false,
};

const TAG_SYSTEM = `You help a design writer organise a library of saved links by subject.

Given one link (its title, address and description) and the tags already used in the library, suggest 2 to 5 tags describing what the link is about.
- Reuse an existing tag whenever it fits, so the library's vocabulary stays consistent; only add a new tag for a subject the existing ones don't cover.
- Tags are short, lowercase, and use dashes instead of spaces (for example "design-systems", "typography", "ai").
- Describe the subject matter, not the format or the website (avoid tags like "article", "blog", or the site's name).`;

// Suggests subject tags for a saved link, preferring tags already in use.
async function suggestTags({ title = '', url = '', description = '', note = '', current = [], existing = [] }) {
  const anthropic = getClient();
  const lines = [`Title: ${title}`, `Address: ${url}`];
  if (description) lines.push(`Description: ${description}`);
  if (note) lines.push(`The writer's note: ${note}`);
  if (current.length) lines.push(`Tags this link already has: ${current.join(', ')} — suggest only additional ones, not variations of these.`);
  lines.push('', existing.length ? `Tags already in the library: ${existing.join(', ')}` : 'The library has no tags yet.');
  const prompt = lines.join('\n');

  let response;
  try {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TAG_SCHEMA } },
      system: TAG_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new SuggestError(503, 'Your Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.');
    if (err instanceof Anthropic.RateLimitError) throw new SuggestError(429, 'Rate limited by the Anthropic API — try again in a moment.');
    if (err instanceof Anthropic.APIError) throw new SuggestError(502, `Anthropic API error ${err.status ?? ''}: ${err.message}`.trim());
    throw new SuggestError(502, `Couldn’t reach the Anthropic API: ${err.message}`);
  }
  if (response.stop_reason === 'refusal') throw new SuggestError(422, 'Claude declined to suggest tags for this link.');
  const block = response.content.find((b) => b.type === 'text');
  try {
    return { tags: JSON.parse(block?.text || '').tags || [] };
  } catch {
    throw new SuggestError(502, 'Got an unexpected response — try again.');
  }
}

module.exports = { suggest, suggestTags, SuggestError };
