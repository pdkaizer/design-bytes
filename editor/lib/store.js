'use strict';

// File-system access. Documents live in collections — articles in /articles and
// quick notes in /quick-notes — as <slug>.md, each with its own .trash and
// .history. Images live in /images and are referenced as ../images/<name>.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const md = require('./markdown');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTICLES = path.join(ROOT, 'articles');
const NOTES = path.join(ROOT, 'quick-notes');
const IMAGES = path.join(ROOT, 'images');
const TRASH = path.join(ARTICLES, '.trash');

const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

const isSlug = (slug) => SLUG.test(slug);
const articlePath = (slug) => path.join(ARTICLES, `${slug}.md`);
const exists = (file) => fsp.access(file).then(() => true, () => false);

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


// Write via a temp file + rename so a crash never leaves a half-written article.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// A folder of Markdown documents.
function collection(kind) {
  const dir = { articles: ARTICLES, notes: NOTES }[kind];
  if (!dir) return null;
  const file = (slug) => path.join(dir, `${slug}.md`);
  const isNote = kind === 'notes';

  async function read(slug) {
    const [content, stat] = await Promise.all([fsp.readFile(file(slug), 'utf8'), fsp.stat(file(slug))]);
    return { slug, content, mtime: stat.mtimeMs };
  }

  async function list() {
    await fsp.mkdir(dir, { recursive: true });
    const names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.md') && isSlug(name.slice(0, -3)));
    const docs = await Promise.all(names.map(async (name) => {
      const { slug, content, mtime } = await read(name.slice(0, -3));
      const { words, minutes } = md.stats(content);
      const title = (isNote ? md.displayTitle(content) : md.title(content)) || (isNote ? 'Untitled note' : slug);
      return isNote
        ? { slug, title, excerpt: md.excerpt(content, 140), words, mtime }
        : { slug, title, status: md.status(content), excerpt: md.excerpt(content), words, minutes, mtime };
    }));
    return docs.sort((a, b) => b.mtime - a.mtime);
  }

  async function uniqueSlug(base) {
    let slug = base;
    for (let n = 2; await exists(file(slug)); n++) slug = `${base}-${n}`;
    return slug;
  }

  return {
    kind, dir, file, read, list, uniqueSlug,
    folder: path.basename(dir),
    trash: path.join(dir, '.trash'),
    history: path.join(dir, '.history'),
  };
}

const articles = collection('articles');
const readArticle = articles.read;
const listArticles = articles.list;

async function listImages() {
  await fsp.mkdir(IMAGES, { recursive: true });
  const names = (await fsp.readdir(IMAGES)).filter((name) => IMAGE_EXT.test(name));
  return Promise.all(names.map(async (name) => {
    const stat = await fsp.stat(path.join(IMAGES, name));
    return { name, size: stat.size, mtime: stat.mtimeMs, path: `../images/${name}` };
  }));
}

async function uniqueImageName(name) {
  const clean = path.basename(name).replace(/[^\w@.-]+/g, '-').replace(/^[-.]+/, '') || 'image.png';
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let candidate = clean;
  for (let n = 2; await exists(path.join(IMAGES, candidate)); n++) candidate = `${stem}-${n}${ext}`;
  return candidate;
}

module.exports = {
  ROOT, ARTICLES, NOTES, IMAGES, TRASH, IMAGE_EXT,
  isSlug, articlePath, exists, slugify, writeAtomic, collection,
  readArticle, listArticles, listImages, uniqueImageName,
};
