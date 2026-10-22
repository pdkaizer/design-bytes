'use strict';

// Sends what the page asks Claude (see lib/claude.js) to the Anthropic API,
// using the key from ANTHROPIC_API_KEY — put it in a .env file at the project
// root (npm start loads it) or export it in your shell. This is the bridge's
// askClaude; the key never reaches the page.

const { Anthropic } = require('@anthropic-ai/sdk');

const EFFORTS = ['low', 'medium', 'high'];

class ClaudeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new ClaudeError(503,
      'Suggestions need an Anthropic API key. Add ANTHROPIC_API_KEY=… to a .env file in the project folder, then restart the writer.');
  }
  client ??= new Anthropic();
  return client;
}

// { model, system, prompt, schema, maxTokens, effort } → { text, model, stopReason }.
// The answer is JSON matching `schema`.
async function askClaude({ model, system, prompt, schema, maxTokens = 2000, effort = 'low' } = {}) {
  if (!/^claude-[a-z0-9.-]+$/.test(String(model || ''))) throw new ClaudeError(400, 'Unknown model');
  if (typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim() || system.length + prompt.length > 40000) {
    throw new ClaudeError(400, 'A system prompt and a message are needed');
  }
  if (!schema || typeof schema !== 'object') throw new ClaudeError(400, 'An answer format is needed');
  const anthropic = getClient();
  let response;
  try {
    response = await anthropic.beta.messages.create({
      model,
      max_tokens: Math.min(Math.max(Number(maxTokens) || 2000, 256), 8000),
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORTS.includes(effort) ? effort : 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new ClaudeError(503, 'Your Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.');
    if (err instanceof Anthropic.RateLimitError) throw new ClaudeError(429, 'Rate limited by the Anthropic API — try again in a moment.');
    if (err instanceof Anthropic.APIError) throw new ClaudeError(502, `Anthropic API error ${err.status ?? ''}: ${err.message}`.trim());
    throw new ClaudeError(502, `Couldn’t reach the Anthropic API: ${err.message}`);
  }
  const block = response.content.find((b) => b.type === 'text');
  return { text: block?.text || '', model: response.model, stopReason: response.stop_reason };
}

module.exports = { askClaude, ClaudeError };
