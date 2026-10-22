/*
 * Publishing Thoughts to peterkaizer.com — an 11ty site in its own repo (set by
 * THOUGHTS_SITE). The rules live here and run in the page (window.DBThoughtSite)
 * and in Node (require, for tests): the site's version of a draft, its date, the
 * check before replacing a post, and the categories in use. The bridge does the
 * rest — listing the site's thoughts, writing one, and committing and pushing it
 * — so the same rules work with git on the Mac and, later, GitHub's API on iOS.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./markdown') : root.DBMarkdown);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBThoughtSite = api;
})(typeof self !== 'undefined' ? self : globalThis, function (md) {
  'use strict';

  // Front matter DB Writer uses for itself, never sent to the site.
  const DRAFT_ONLY = new Set(['status', 'created', 'slug']);
  const DEFAULT_CATEGORIES = ['Layout', 'Typography', 'Color', 'Motion', 'Interaction', 'Philosophy', 'Language'];

  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, data: { error: message, ...extra } });

  const today = (date = new Date()) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
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

  // What publishing `draftText` as <slug>.md does, given the site's current file
  // (null if there isn't one): { draft, content, changed, message }, where draft is
  // the updated draft (status: published, date: filled in if missing) and content
  // the site's file. Fails with 409 (data.needsConfirm) rather than replace a
  // different post DB Writer didn't publish, unless overwrite is set.
  function prepare(slug, draftText, existing, { overwrite = false, date = today() } = {}) {
    const data = md.frontMatter(draftText).data;
    const title = String(data.title || '').trim();
    if (!title) throw fail(400, 'Give the thought a title: before publishing.');

    // The site needs a date; keep the one the draft has, or use today's.
    let draft = draftText;
    if (!String(data.date || '').trim()) {
      const after = data.description !== undefined ? 'description' : data.category !== undefined ? 'category' : 'title';
      draft = md.setMeta(draft, 'date', date, { after });
    }
    const content = siteVersion(draft);

    // Don't silently replace a post that DB Writer didn't publish.
    const ownedHere = md.status(draftText) === 'published';
    if (existing != null && existing !== content && !ownedHere && !overwrite) {
      throw fail(409, `peterkaizer.com already has a different thoughts/${slug}.md.`, { needsConfirm: true });
    }
    return {
      draft: md.setMeta(draft, 'status', 'published'),
      content,
      changed: existing !== content,
      message: `${existing == null ? 'Add' : 'Update'} thought: ${title}`,
    };
  }

  // Categories used on the site (from its posts' front matter), most used first;
  // the usual ones are always offered.
  function categories(texts) {
    const counts = new Map(DEFAULT_CATEGORIES.map((c) => [c, 0]));
    for (const text of texts) {
      const c = String(md.frontMatter(text).data.category || '').trim();
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  }

  // bridge: siteThoughts() → [{ name, content }] (fails with 503 if the site isn't set
  // up), writeSiteThought(name, content), commitSiteThought(name, message) →
  // { committed, pushed, note }.
  function createThoughtSite(bridge, { now = () => new Date() } = {}) {
    return {
      async categories() {
        try {
          return categories((await bridge.siteThoughts()).filter((f) => f.name.endsWith('.md')).map((f) => f.content));
        } catch {
          return [...DEFAULT_CATEGORIES];
        }
      },
      // { draft, file, committed, pushed, note }.
      async publish(slug, draftText, { overwrite = false } = {}) {
        const name = `${slug}.md`;
        const existing = (await bridge.siteThoughts()).find((f) => f.name === name)?.content ?? null;
        const p = prepare(slug, draftText, existing, { overwrite, date: today(now()) });
        if (p.changed) await bridge.writeSiteThought(name, p.content);
        const result = await bridge.commitSiteThought(name, p.message);
        return { draft: p.draft, file: `src/thoughts/${name}`, committed: !!result.committed, pushed: !!result.pushed, note: result.note || '' };
      },
    };
  }

  return { createThoughtSite, prepare, siteVersion, categories, DEFAULT_CATEGORIES };
});
