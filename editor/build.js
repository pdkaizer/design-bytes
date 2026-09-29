#!/usr/bin/env node
'use strict';

// Renders every article in /articles to a static site in /dist:
//   dist/index.html            — article list
//   dist/articles/<slug>.html  — one page per article
//   dist/images/               — copied from /images

const fsp = require('fs').promises;
const path = require('path');
const store = require('./lib/store');
const { renderArticle, renderIndex } = require('./lib/template');

const OUT = path.join(store.ROOT, 'dist');

(async () => {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(path.join(OUT, 'articles'), { recursive: true });
  await fsp.cp(store.IMAGES, path.join(OUT, 'images'), {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith('.'),
  });

  const articles = await store.listArticles();
  for (const { slug, mtime } of articles) {
    const { content } = await store.readArticle(slug);
    await fsp.writeFile(path.join(OUT, 'articles', `${slug}.html`), renderArticle(content, { mtime }));
  }
  await fsp.writeFile(path.join(OUT, 'index.html'), renderIndex(articles));

  console.log(`Built ${articles.length} article${articles.length === 1 ? '' : 's'} → ${path.relative(process.cwd(), OUT) || OUT}/`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
