'use strict';

// HTML page templates for published articles. The article styles are the same
// file the editor preview uses, so what you see while writing is what ships.

const fs = require('fs');
const path = require('path');
const md = require('./markdown');

const ARTICLE_CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'article.css'), 'utf8');
const esc = md.escape;

const PAGE_CSS = `
body { margin: 0; background: var(--a-paper); color: var(--a-ink); }
.site, .index { max-width: 68ch; margin: 0 auto; padding: 32px 20px 0; font: 1.125rem/1.7 var(--a-serif); }
.site img { display: block; height: 28px; width: auto; }
main.article { padding: 56px 20px 96px; }
.index { padding-bottom: 96px; }
.index h1 { font: 700 1rem/1.2 var(--a-sans); text-transform: uppercase; letter-spacing: .08em; color: var(--a-soft); margin: 56px 0 8px; }
.index ol { list-style: none; margin: 0; padding: 0; }
.index li { padding: 28px 0; border-bottom: 1px solid var(--a-rule); }
.index a { color: inherit; text-decoration: none; }
.index h2 { font: 700 1.5em/1.2 var(--a-sans); letter-spacing: -.015em; margin: 0 0 .35em; text-wrap: balance; }
.index a:hover h2 { color: var(--a-link); }
.index p { margin: 0 0 .5em; }
.index .meta { font: .8em var(--a-sans); color: var(--a-soft); }
`;

const formatDate = (ms) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function page({ title, description = '', body, root }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}<link rel="icon" href="${root}images/db-icon.png">
<style>
${ARTICLE_CSS}
${PAGE_CSS}
</style>
</head>
<body>
<header class="site"><a href="${root}index.html"><img src="${root}images/db-logo@2x.png" alt="design bytes" width="152" height="29"></a></header>
${body}
</body>
</html>
`;
}

// Renders one article. Articles sit one level below the site root
// (articles/<slug>.html) so their ../images/ paths keep working.
function renderArticle(markdown, { mtime = Date.now() } = {}) {
  const { minutes } = md.stats(markdown);
  const meta = `<p class="meta">${formatDate(mtime)} · ${minutes} min read</p>`;
  let html = md.render(markdown, { withTitle: true });
  html = /^<h[12][ >]/.test(html)
    ? html.replace(/^(<h[12][^>]*>[\s\S]*?<\/h[12]>)/, `$1\n${meta}`)
    : `${meta}\n${html}`;
  return page({
    title: `${md.title(markdown) || 'Untitled'} · Design Bytes`,
    description: md.excerpt(markdown, 160),
    body: `<main class="article">\n${html}\n</main>`,
    root: '../',
  });
}

function renderIndex(articles) {
  const items = articles.map((a) => `<li><a href="articles/${esc(a.slug)}.html">
<h2>${esc(a.title)}</h2>
${a.excerpt ? `<p>${esc(a.excerpt)}</p>` : ''}
<span class="meta">${formatDate(a.mtime)} · ${a.minutes} min read</span>
</a></li>`).join('\n');
  return page({
    title: 'Design Bytes',
    body: `<main class="index">\n<h1>Articles</h1>\n<ol>\n${items}\n</ol>\n</main>`,
    root: '',
  });
}

module.exports = { renderArticle, renderIndex };
