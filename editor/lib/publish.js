'use strict';

// Publishing Thoughts to peterkaizer.com — an 11ty site in its own repo, set by
// THOUGHTS_SITE in .env. Publishing writes src/thoughts/<slug>.md in the site's
// front matter format, then commits just that file and pushes, so the site deploys.

const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const md = require('./markdown');
const { writeAtomic } = require('./store');

// Front matter DB Writer uses for itself, never sent to the site.
const DRAFT_ONLY = new Set(['status', 'created', 'slug']);
const DEFAULT_CATEGORIES = ['Layout', 'Typography', 'Color', 'Motion', 'Interaction', 'Philosophy', 'Language'];

class PublishError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function site() {
  const root = process.env.THOUGHTS_SITE;
  if (!root) throw new PublishError(503, 'Publishing needs THOUGHTS_SITE=<path to your 11ty site> in .env. Add it, then restart the writer.');
  return { root, dir: path.join(root, 'src', 'thoughts') };
}

function git(root, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { timeout }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr: String(stderr || '').trim() }));
      else resolve(String(stdout || '').trim());
    });
  });
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// The site's version of a draft: its front matter minus DB Writer's own fields,
// and the text minus private notes.
function siteVersion(draft) {
  const text = String(draft).replace(/\r\n?/g, '\n');
  const fm = md.frontMatter(text);
  const block = text.slice(0, fm.end).split('\n');
  const inner = block.slice(1, block.lastIndexOf('---') > 0 ? block.lastIndexOf('---') : block.length - 1);
  const kept = [];
  let skipping = false;
  for (const line of inner) {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (key) skipping = DRAFT_ONLY.has(key);
    else if (!/^(\s+\S|-\s)/.test(line)) skipping = false; // blank / comment lines end a skipped key
    if (!skipping && line.trim()) kept.push(line);
  }
  const body = md.splitNotes(fm.body).article.replace(/^\s*\n/, '').replace(/\s+$/, '');
  return `---\n${kept.join('\n')}\n---\n\n${body}\n`;
}

// Categories used on the site (from its posts and its new-thought script), most used first.
async function categories() {
  let dir;
  try { dir = site().dir; } catch { return DEFAULT_CATEGORIES; }
  const counts = new Map(DEFAULT_CATEGORIES.map((c) => [c, 0]));
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.md')) continue;
    const c = String(md.frontMatter(await fsp.readFile(path.join(dir, name), 'utf8')).data.category || '').trim();
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
}

// Publishes a draft. Returns { draft, file, committed, pushed, note }, where draft is
// the updated draft text (status: published, and date: filled in if it was missing).
async function publish(slug, draftText, { overwrite = false } = {}) {
  const { root, dir } = site();
  await fsp.access(path.join(root, '.git')).catch(() => {
    throw new PublishError(503, `${root} isn’t a git repository — check THOUGHTS_SITE in .env.`);
  });
  const data = md.frontMatter(draftText).data;
  if (!String(data.title || '').trim()) throw new PublishError(400, 'Give the thought a title: before publishing.');

  // The site needs a date; keep the one the draft has, or use today's.
  let draft = draftText;
  if (!String(data.date || '').trim()) {
    const after = data.description !== undefined ? 'description' : data.category !== undefined ? 'category' : 'title';
    draft = md.setMeta(draft, 'date', today(), { after });
  }
  const content = siteVersion(draft);
  const rel = path.join('src', 'thoughts', `${slug}.md`);
  const target = path.join(root, rel);

  // Don't silently replace a post that DB Writer didn't publish.
  const existing = await fsp.readFile(target, 'utf8').catch(() => null);
  const ownedHere = md.status(draftText) === 'published';
  if (existing != null && existing !== content && !ownedHere && !overwrite) {
    throw new PublishError(409, `peterkaizer.com already has a different thoughts/${slug}.md.`, { needsConfirm: true });
  }

  await fsp.mkdir(dir, { recursive: true });
  if (existing !== content) await writeAtomic(target, content);
  draft = md.setMeta(draft, 'status', 'published');

  // Commit just this file (other work in the site repo is left alone), then push.
  const result = { draft, file: rel, committed: false, pushed: false, note: '' };
  await git(root, ['add', '--', rel]);
  const changed = await git(root, ['diff', '--cached', '--quiet', '--', rel]).then(() => false, (err) => {
    if (err.code === 1) return true;
    throw err;
  });
  if (changed) {
    const verb = existing == null ? 'Add' : 'Update';
    try {
      await git(root, ['commit', '-m', `${verb} thought: ${String(data.title).trim()}`, '--', rel]);
      result.committed = true;
    } catch (err) {
      result.note = `Saved to the site, but committing failed: ${err.stderr || err.message}`;
      return result;
    }
  }
  try {
    const ahead = Number(await git(root, ['rev-list', '--count', '@{u}..HEAD']).catch(() => '1'));
    if (ahead > 0) {
      await git(root, ['push'], 90000);
      result.pushed = true;
    }
  } catch (err) {
    const why = (err.stderr || err.message).split('\n').find((l) => /rejected|error|fatal|hint/i.test(l)) || err.message;
    result.note = `Committed, but pushing to GitHub failed: ${why.trim()} — push from ${path.basename(root)} when you can.`;
  }
  return result;
}

module.exports = { publish, categories, siteVersion, PublishError };
