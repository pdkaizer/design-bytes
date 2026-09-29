'use strict';

// File-system access for articles and images. Articles live in /articles as
// <slug>.md; images live in /images and are referenced as ../images/<name>.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const md = require('./markdown');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTICLES = path.join(ROOT, 'articles');
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

async function uniqueSlug(base) {
  let slug = base;
  for (let n = 2; await exists(articlePath(slug)); n++) slug = `${base}-${n}`;
  return slug;
}

// Write via a temp file + rename so a crash never leaves a half-written article.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function readArticle(slug) {
  const file = articlePath(slug);
  const [content, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
  return { slug, content, mtime: stat.mtimeMs };
}

async function listArticles() {
  await fsp.mkdir(ARTICLES, { recursive: true });
  const names = (await fsp.readdir(ARTICLES))
    .filter((name) => name.endsWith('.md') && isSlug(name.slice(0, -3)));
  const articles = await Promise.all(names.map(async (name) => {
    const { slug, content, mtime } = await readArticle(name.slice(0, -3));
    const { words, minutes } = md.stats(content);
    return { slug, title: md.title(content) || slug, excerpt: md.excerpt(content), words, minutes, mtime };
  }));
  return articles.sort((a, b) => b.mtime - a.mtime);
}

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
  ROOT, ARTICLES, IMAGES, TRASH, IMAGE_EXT,
  isSlug, articlePath, exists, slugify, uniqueSlug, writeAtomic,
  readArticle, listArticles, listImages, uniqueImageName,
};
