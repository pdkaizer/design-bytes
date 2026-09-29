'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const md = require('../lib/markdown');

const r = (src) => md.render(src).trim();

test('headings get ids, and duplicate ids are numbered', () => {
  assert.equal(r('## Hello World'), '<h2 id="hello-world">Hello World</h2>');
  assert.equal(r('# A\n\n# A'), '<h1 id="a">A</h1>\n<h1 id="a-1">A</h1>');
  assert.equal(r('Title\n====='), '<h1 id="title">Title</h1>');
  assert.equal(r('#hashtag'), '<p>#hashtag</p>');
});

test('inline formatting', () => {
  assert.equal(r('**bold** and _it_ and *it* and ~~no~~'),
    '<p><strong>bold</strong> and <em>it</em> and <em>it</em> and <del>no</del></p>');
  assert.equal(r('***both***'), '<p><strong><em>both</em></strong></p>');
  assert.equal(r('snake_case_name'), '<p>snake_case_name</p>');
  assert.equal(r('`a *b* <c>`'), '<p><code>a *b* &lt;c&gt;</code></p>');
  assert.equal(r('\\*not em\\*'), '<p>*not em*</p>');
  assert.equal(r('line  \nbreak'), '<p>line<br>\nbreak</p>');
});

test('links and images', () => {
  assert.equal(r('[Morris](https://en.wikipedia.org/wiki/William_Morris)'),
    '<p><a href="https://en.wikipedia.org/wiki/William_Morris">Morris</a></p>');
  assert.equal(r('[a](https://x.com/a_(b))'), '<p><a href="https://x.com/a_(b)">a</a></p>');
  assert.equal(r('[t](https://x.com "Title")'), '<p><a href="https://x.com" title="Title">t</a></p>');
  assert.equal(r('![Logo](../images/db-logo.png)'),
    '<p><img src="../images/db-logo.png" alt="Logo" loading="lazy"></p>');
  assert.equal(r('see https://example.com.'), '<p>see <a href="https://example.com">https://example.com</a>.</p>');
  assert.equal(r('[x](javascript:alert(1))'), '<p><a href="#">x</a></p>');
});

test('a link pasted over a link resolves to the inner URL', () => {
  assert.equal(r('[37 Signal’s]([https://37signals.com](https://37signals.com/))'),
    '<p><a href="https://37signals.com/">37 Signal’s</a></p>');
});

test('raw HTML is escaped', () => {
  assert.equal(r('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('lists: tight, loose, ordered, nested, tasks', () => {
  assert.equal(r('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  assert.equal(r('- a\n\n- b'), '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>');
  assert.equal(r('3. c\n4. d'), '<ol start="3">\n<li>c</li>\n<li>d</li>\n</ol>');
  assert.equal(r('- a\n  - b\n- c'), '<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n<li>c</li>\n</ul>');
  assert.equal(r('1. a\n  - b'), '<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ol>');
  assert.equal(r('- [x] done\n- [ ] todo'),
    '<ul class="tasks">\n<li class="task"><input type="checkbox" disabled checked> done</li>\n' +
    '<li class="task"><input type="checkbox" disabled> todo</li>\n</ul>');
  assert.equal(r('- a\nlazy'), '<ul>\n<li>a\nlazy</li>\n</ul>');
});

test('blocks: quotes, code, rules, tables', () => {
  assert.equal(r('> quoted\n> more'), '<blockquote>\n<p>quoted\nmore</p>\n</blockquote>');
  assert.equal(r('```js\nconst a = 1 < 2;\n```'), '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>');
  assert.equal(r('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
  assert.equal(r('* * *'), '<hr>');
  assert.equal(r('| A | B |\n|:--|--:|\n| 1 | 2 |'),
    '<div class="table-wrap"><table><thead><tr><th style="text-align:left">A</th><th style="text-align:right">B</th></tr></thead>' +
    '<tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table></div>');
});

test('title, stats and excerpt', () => {
  const src = '\n## How the **Arts** Shaped Design\n\nFirst paragraph here.\n\nSecond.';
  assert.equal(md.title(src), 'How the Arts Shaped Design');
  assert.equal(md.excerpt(src), 'First paragraph here.');
  assert.equal(md.stats('one two [three](https://x.com/four-five)').words, 3);
});

test('lint finds pasted-twice links, repeated words and double spaces', () => {
  const issues = md.lint('A [b]([https://x.com](https://x.com)) the the end.\nToo  many\n`the the`');
  assert.deepEqual(issues.map((i) => [i.line, i.message.split(' ')[0]]), [
    [1, 'Link'], [1, 'Repeated'], [2, 'Extra'],
  ]);
});

test('renders the real article without leaking markdown', () => {
  const file = path.join(__dirname, '..', '..', 'articles', 'morris-material.md');
  if (!fs.existsSync(file)) return;
  const html = md.render(fs.readFileSync(file, 'utf8'));
  assert.ok(html.startsWith('<h2 id="how-the-arts-and-crafts-movement-shaped-digital-product-design">'));
  assert.ok(!/\]\(|\*\*/.test(html), 'no raw link or bold syntax left');
  assert.ok(html.includes('<a href="https://m3.material.io/">Google’s Material Design</a>'));
});
