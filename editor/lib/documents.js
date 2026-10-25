/*
 * Documents — articles, thoughts, quick notes and journal entries — and their
 * version history. Runs in the page (window.DBDocuments) and in Node (require,
 * for tests). It reads and writes plain files through the bridge
 * (public/bridge.js), so the same rules work with the Node server today and a
 * native app later.
 *
 * A document is <folder>/<slug>.md. Its versions live in <folder>/.history/<slug>/,
 * one file per version, named after when that text was saved
 * (2026-10-03T14-05-22-123Z.md), with names for named versions in labels.json.
 * Deleted documents go to <folder>/.trash, their history with them.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./markdown') : root.DBMarkdown);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBDocuments = api;
})(typeof self !== 'undefined' ? self : globalThis, function (md) {
  'use strict';

  const FOLDERS = { articles: 'articles', thoughts: 'thoughts', notes: 'quick-notes', journal: 'journal' };
  // Quick notes and journal entries are plain: no title, slug or status in front matter.
  const isPlain = (kind) => kind === 'notes' || kind === 'journal';

  const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
  const isSlug = (slug) => SLUG.test(slug);

  // File names from titles: "The Conductor’s Role" → "the-conductors-role".
  function slugify(text) {
    return String(text)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || 'untitled';
  }

  const GAP = 5 * 60 * 1000; // at most one automatic version every 5 minutes
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const VERSION = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
  const isVersion = (id) => VERSION.test(id);
  const versionId = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
  const versionTime = (id) => Date.parse(id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));

  const pad = (n) => String(n).padStart(2, '0');
  const dayName = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, data: { error: message, ...extra } });

  // What the sidebar, Home and search show for a document.
  function summary(kind, slug, content, mtime) {
    const { words, minutes } = md.stats(content);
    const plain = isPlain(kind);
    const title = kind === 'journal'
      ? md.dayTitle(slug) || md.displayTitle(content) || slug
      : (plain ? md.displayTitle(content) : md.title(content)) || (plain ? 'Untitled note' : slug);
    const added = md.created(content); // { ms, hasTime } from created: in the front matter
    const base = { slug, title, words, mtime, created: added?.ms ?? null, createdHasTime: !!added?.hasTime, published: md.published(content) };
    if (plain) return { ...base, excerpt: md.excerpt(content, 140) };
    const doc = { ...base, status: md.status(content), excerpt: md.excerpt(content), minutes };
    if (kind === 'thoughts') doc.category = String(md.frontMatter(content).data.category || '').trim();
    return doc;
  }

  function createDocuments(bridge, { now = () => Date.now() } = {}) {
    const folderOf = (kind) => {
      if (!FOLDERS[kind]) throw fail(400, `Unknown kind of document: ${kind}`);
      return FOLDERS[kind];
    };
    const fileOf = (kind, slug) => {
      if (!isSlug(slug)) throw fail(400, 'Invalid name');
      return `${folderOf(kind)}/${slug}.md`;
    };
    const historyOf = (kind, slug) => `${folderOf(kind)}/.history/${slug}`;
    const notThere = (err) => err.status === 404;

    // ---------------------------------------------------------------------
    // Documents

    async function list(kind) {
      const entries = await bridge.listFiles(folderOf(kind), { content: true });
      return entries
        .filter((e) => !e.dir && e.name.endsWith('.md') && isSlug(e.name.slice(0, -3)))
        .map((e) => summary(kind, e.name.slice(0, -3), e.content, e.mtime))
        .sort((a, b) => b.mtime - a.mtime);
    }

    async function read(kind, slug) {
      const { content, mtime } = await bridge.readFile(fileOf(kind, slug));
      return { slug, content, mtime };
    }

    // Creates <slug>.md, or <slug>-2.md and so on if the name is taken.
    async function createUnique(kind, base, content) {
      for (let n = 1; n < 500; n++) {
        const slug = n === 1 ? base : `${base}-${n}`;
        try {
          const { mtime } = await bridge.writeFile(fileOf(kind, slug), content, { create: true });
          return { slug, content, mtime };
        } catch (err) {
          if (err.status !== 409) throw err;
        }
      }
      throw fail(409, `Too many documents called ${base}`);
    }

    // A new document: { title } for an article or thought; {} for a quick note or
    // today's journal entry; { content, filename, name, published, date } to import a file.
    async function create(kind, { title, content: imported, filename, name: chosen, published: alreadyPublished, date } = {}) {
      const plain = isPlain(kind);
      const clean = String(title || '').trim();
      let base;
      let content;
      if (typeof imported === 'string') {
        // Importing a Markdown file: keep its text, name it after its title (or file name),
        // and make sure an article has one of our statuses.
        content = imported.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
        const stem = String(filename || '').replace(/\.[^.]*$/, '');
        const name = String(chosen || '').trim() || md.title(content) || stem || (plain ? 'note' : 'untitled');
        base = isSlug(name) ? name.toLowerCase() : slugify(name);
        if (!plain) {
          // Articles keep their title and file name in front matter (slug: is filled in below).
          content = md.liftTitle(content);
          if (!md.title(content)) content = md.setMeta(content, 'title', stem || 'Untitled', { first: true });
          if (!md.STATUSES.includes(String(md.frontMatter(content).data.status || '').toLowerCase())) {
            content = md.setMeta(content, 'status', md.DEFAULT_STATUS);
          }
          // A piece that was published before it came into DB Writer keeps its real publish date.
          if (alreadyPublished) {
            content = md.setMeta(content, 'status', 'published');
            if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) content = md.setMeta(content, 'date', date, { after: 'status' });
          }
        }
      } else if (kind === 'journal') {
        // One entry a day, named by its date: today's opens if it's already there.
        base = dayName(new Date(now()));
        try { return await read(kind, base); } catch (err) { if (!notThere(err)) throw err; }
        content = '';
      } else if (plain) {
        // Quick notes are named by when they were made: 2026-10-04-1532.md
        const d = new Date(now());
        base = `${dayName(d)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        content = clean ? `# ${clean}\n\n` : '';
      } else {
        base = slugify(clean || 'Untitled');
        content = md.setMeta('', 'title', clean || 'Untitled');
        content = md.setMeta(content, 'slug', base);
        if (kind === 'thoughts') {
          // The fields peterkaizer.com uses, ready to fill in.
          content = md.setMeta(content, 'category', '');
          content = md.setMeta(content, 'description', '');
          content = md.setMetaList(content, 'tags', []); // shown as Topics on the site
          content = md.setMeta(content, 'ogImage', ''); // e.g. /assets/images/thoughts/<slug>.png in the site
        }
        content = md.setMeta(content, 'status', md.DEFAULT_STATUS);
      }
      // Record when it was added (an imported file keeps a created: date it already has).
      if (!md.created(content)) content = md.setMeta(content, 'created', md.formatStamp(new Date(now())));
      if (plain) return createUnique(kind, base, content);
      // An article's slug: line names its file, so it's set once the name is known.
      for (let n = 1; n < 500; n++) {
        const slug = n === 1 ? base : `${base}-${n}`;
        const text = md.setMeta(content, 'slug', slug, { after: 'title' });
        try {
          const { mtime } = await bridge.writeFile(fileOf(kind, slug), text, { create: true });
          return { slug, content: text, mtime };
        } catch (err) {
          if (err.status !== 409) throw err;
        }
      }
      throw fail(409, `Too many documents called ${base}`);
    }

    // Saves the text. `previous` is what was last read or saved ({ content, mtime }):
    // if the file is still that, and the newest version is a few minutes old, that
    // text is kept as a version first. Fails with status 409 and data { slug,
    // content, mtime } (what's on disk) if the file changed since it was read.
    async function save(kind, slug, content, { previous = null, force = false, keepalive = false } = {}) {
      const file = fileOf(kind, slug);
      if (previous && !keepalive) {
        await beforeWrite(kind, slug, previous).catch((err) => console.error('history:', err));
      }
      try {
        const { mtime } = await bridge.writeFile(file, content, { mtime: force ? null : previous?.mtime ?? null, keepalive });
        return { slug, mtime };
      } catch (err) {
        if (err.status === 409 && err.data?.current) {
          throw fail(409, 'Changed on disk', { slug, ...err.data.current });
        }
        throw err;
      }
    }

    // Renames the file (and its history), keeping slug: in step for articles and thoughts.
    // Fails with status 409 if the name is taken. Returns the document as it now is.
    async function rename(kind, slug, to) {
      const next = isSlug(String(to || '')) ? String(to).toLowerCase() : slugify(to || '');
      if (next !== slug) {
        await bridge.moveFile(fileOf(kind, slug), fileOf(kind, next)).catch((err) => {
          throw err.status === 409 ? fail(409, `${folderOf(kind)}/${next}.md already exists`) : err;
        });
        await bridge.moveFile(historyOf(kind, slug), historyOf(kind, next)).catch((err) => {
          if (!notThere(err)) console.error('history:', err);
        });
        newest.delete(`${kind}/${slug}`);
      }
      let doc = await read(kind, next);
      if (!isPlain(kind) && md.frontMatter(doc.content).data.slug !== next) {
        const content = md.setMeta(doc.content, 'slug', next, { after: 'title' });
        const { mtime } = await bridge.writeFile(fileOf(kind, next), content, { mtime: doc.mtime });
        doc = { slug: next, content, mtime };
      }
      return doc;
    }

    // Moves it to <folder>/.trash, with its history.
    async function trash(kind, slug) {
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const to = `${folderOf(kind)}/.trash/${slug}-${stamp}`;
      await bridge.moveFile(fileOf(kind, slug), `${to}.md`);
      await bridge.moveFile(historyOf(kind, slug), `${to}.history`).catch((err) => {
        if (!notThere(err)) console.error('history:', err);
      });
      newest.delete(`${kind}/${slug}`);
      return { trashed: `${to}.md` };
    }

    // ---------------------------------------------------------------------
    // Version history

    const newest = new Map(); // "kind/slug" → id of its newest version (or null), once known

    async function versionIds(kind, slug) {
      const entries = await bridge.listFiles(historyOf(kind, slug));
      return entries.filter((e) => !e.dir && e.name.endsWith('.md') && isVersion(e.name.slice(0, -3)))
        .map((e) => e.name.slice(0, -3)).sort().reverse();
    }

    async function readLabels(kind, slug) {
      try { return JSON.parse((await bridge.readFile(`${historyOf(kind, slug)}/labels.json`)).content); } catch { return {}; }
    }

    // [{ id, time, label, words }], newest first.
    async function versions(kind, slug) {
      const [entries, labels] = await Promise.all([bridge.listFiles(historyOf(kind, slug), { content: true }), readLabels(kind, slug)]);
      return entries.filter((e) => !e.dir && e.name.endsWith('.md') && isVersion(e.name.slice(0, -3)))
        .map((e) => { const id = e.name.slice(0, -3); return { id, time: versionTime(id), label: labels[id] || '', words: md.stats(e.content).words }; })
        .sort((a, b) => b.time - a.time);
    }

    async function version(kind, slug, id) {
      if (!isVersion(id)) throw fail(400, 'Invalid version');
      return { id, content: (await bridge.readFile(`${historyOf(kind, slug)}/${id}.md`)).content };
    }

    // Keeps `content` as a version from time `ms`, unless the newest version is
    // already identical. Returns the id of the version that holds this text.
    async function snapshot(kind, slug, content, ms, label = '') {
      const dir = historyOf(kind, slug);
      const [latest] = await versionIds(kind, slug);
      let id = latest && (await version(kind, slug, latest)).content === content ? latest : null;
      if (!id) {
        id = versionId(ms);
        await bridge.writeFile(`${dir}/${id}.md`, content, { create: true }).catch((err) => { if (err.status !== 409) throw err; });
        newest.set(`${kind}/${slug}`, id > (latest || '') ? id : latest);
      }
      if (label) {
        const labels = await readLabels(kind, slug);
        labels[id] = label;
        await bridge.writeFile(`${dir}/labels.json`, JSON.stringify(labels, null, 2));
      }
      await prune(kind, slug);
      return id;
    }

    // Before the file is overwritten: keep the text that's about to be replaced,
    // if the newest version is more than a few minutes older than it.
    async function beforeWrite(kind, slug, previous) {
      const key = `${kind}/${slug}`;
      if (!newest.has(key)) newest.set(key, (await versionIds(kind, slug))[0] || null);
      const latest = newest.get(key);
      if (latest && previous.mtime - versionTime(latest) < GAP) return;
      await snapshot(kind, slug, previous.content, previous.mtime);
    }

    // Saves the file as it is now as a (named) version.
    async function saveVersion(kind, slug, label = '') {
      const { content, mtime } = await read(kind, slug);
      return snapshot(kind, slug, content, mtime, String(label || '').trim().slice(0, 120));
    }

    // Keep everything from the last 2 days, then one version per hour for two
    // weeks, then one per day. Named versions are always kept.
    async function prune(kind, slug) {
      const [all, labels] = await Promise.all([versionIds(kind, slug), readLabels(kind, slug)]);
      const seen = new Set();
      for (const id of all) {
        const age = now() - versionTime(id);
        if (labels[id] || age < 2 * DAY) continue;
        const bucket = age < 14 * DAY ? `h${Math.floor(versionTime(id) / HOUR)}` : `d${Math.floor(versionTime(id) / DAY)}`;
        if (!seen.has(bucket)) { seen.add(bucket); continue; } // newest in its hour/day
        await bridge.deleteFile(`${historyOf(kind, slug)}/${id}.md`).catch(() => {});
      }
    }

    return { list, read, create, save, rename, trash, versions, version, saveVersion };
  }

  return { createDocuments, summary, slugify, isSlug, isPlain, FOLDERS, GAP };
});
