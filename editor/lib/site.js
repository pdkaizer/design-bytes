'use strict';

// The server's side of publishing Thoughts (the rules are in lib/thoughtsite.js,
// run in the page): the site's thoughts, writing one, and committing and pushing
// it. The site is the 11ty repo set by THOUGHTS_SITE in .env; posts live in its
// src/thoughts/. Only that one file is ever committed, so other work in the site
// repo is left alone.

const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { writeAtomic } = require('./store');

const NAME = /^[a-z0-9][a-z0-9_-]{0,99}\.md$/i;

class SiteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function site() {
  const root = process.env.THOUGHTS_SITE;
  if (!root) throw new SiteError(503, 'Publishing needs THOUGHTS_SITE=<path to your 11ty site> in .env. Add it, then restart the writer.');
  await fsp.access(path.join(root, '.git')).catch(() => {
    throw new SiteError(503, `${root} isn’t a git repository — check THOUGHTS_SITE in .env.`);
  });
  return { root, dir: path.join(root, 'src', 'thoughts') };
}

const fileName = (name) => {
  if (!NAME.test(String(name || ''))) throw new SiteError(400, 'Not a thought’s file name');
  return String(name);
};

function git(root, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { timeout }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr: String(stderr || '').trim() }));
      else resolve(String(stdout || '').trim());
    });
  });
}

// [{ name, content }] for the posts in src/thoughts.
async function siteThoughts() {
  const { dir } = await site();
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => NAME.test(n));
  return Promise.all(names.map(async (name) => ({ name, content: await fsp.readFile(path.join(dir, name), 'utf8') })));
}

async function writeSiteThought(name, content) {
  const { dir } = await site();
  if (typeof content !== 'string') throw new SiteError(400, 'content must be text');
  await fsp.mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, fileName(name)), content);
  return { ok: true };
}

// Commits just src/thoughts/<name> (if it changed), then pushes if there's
// anything to push. { committed, pushed, note }: note explains a failed commit or push.
async function commitSiteThought(name, message) {
  const { root } = await site();
  const rel = path.join('src', 'thoughts', fileName(name));
  const result = { committed: false, pushed: false, note: '' };
  await git(root, ['add', '--', rel]);
  const changed = await git(root, ['diff', '--cached', '--quiet', '--', rel]).then(() => false, (err) => {
    if (err.code === 1) return true;
    throw err;
  });
  if (changed) {
    try {
      await git(root, ['commit', '-m', String(message || `Update thought: ${name}`).slice(0, 200), '--', rel]);
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

module.exports = { siteThoughts, writeSiteThought, commitSiteThought, SiteError };
