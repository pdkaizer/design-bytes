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
  const html = md.render(fs.readFileSync(file, 'utf8'), { withTitle: true });
  assert.ok(html.startsWith('<h1 id="how-the-arts-and-crafts-movement-shaped-digital-product-design">'), 'title comes from front matter');
  assert.ok(!/\]\(|\*\*/.test(html), 'no raw link or bold syntax left');
  assert.ok(html.includes('<a href="https://m3.material.io/">Google’s Material Design</a>'));
});

test('front matter: status is read, hidden from output, and defaults to backlog', () => {
  const src = '---\nstatus: final\n---\n\n## Hi\n\nthe the x';
  assert.equal(md.status(src), 'final');
  assert.equal(md.title(src), 'Hi');
  assert.equal(r(src), '<h2 id="hi">Hi</h2>\n<p>the the x</p>');
  assert.equal(md.lint(src)[0].line, 7, 'lint line numbers count the front matter');
  assert.equal(md.status('## No front matter'), 'backlog');
  assert.equal(md.status('---\nstatus: nonsense\n---\n'), 'backlog');
});

test('front matter: a leading --- divider is not mistaken for front matter', () => {
  assert.equal(r('---\n\nText\n\n---\nmore'), '<hr>\n<p>Text</p>\n<hr>\n<p>more</p>');
});

test('setMeta adds or updates a key', () => {
  assert.equal(md.setMeta('\n## Hi\n', 'status', 'editing'), '---\nstatus: editing\n---\n\n## Hi\n');
  assert.equal(md.setMeta('---\ntitle: x\nstatus: backlog\n---\n\nBody', 'status', 'published'),
    '---\ntitle: x\nstatus: published\n---\n\nBody');
  assert.equal(md.setMeta('---\ntitle: x\n---\nBody', 'status', 'final'), '---\ntitle: x\nstatus: final\n---\nBody');
});

test('forPublishing strips front matter and title, and repairs double-pasted links', () => {
  const src = '---\nstatus: final\n---\n\n## The Title\n\nSee [x]([https://a.com](https://a.com/)).\n\n## Next\n';
  assert.equal(md.forPublishing(src), 'See [x](https://a.com/).\n\n## Next\n');
  assert.equal(md.forPublishing(src, { includeTitle: true }), '## The Title\n\nSee [x](https://a.com/).\n\n## Next\n');
  assert.equal(md.forPublishing('Intro first.\n\n## Section'), 'Intro first.\n\n## Section\n');
});

test('notes: split and join round-trip, and stay out of everything published', () => {
  const file = '---\nstatus: editing\n---\n\n## Title\n\nKept sentence.\n\n<!-- notes\nCut sentence.\n\nAnother idea.\n-->\n';
  const { article, notes } = md.splitNotes(file);
  assert.equal(article, '---\nstatus: editing\n---\n\n## Title\n\nKept sentence.\n');
  assert.equal(notes, 'Cut sentence.\n\nAnother idea.');
  assert.equal(md.joinNotes(article, notes), file);
  assert.equal(md.joinNotes('Body\n', ''), 'Body\n', 'no notes leaves the file untouched');
  assert.equal(md.joinNotes('Body', 'a --> b'), 'Body\n\n<!-- notes\na -- > b\n-->\n');

  assert.ok(!md.render(file).includes('Cut'));
  assert.equal(md.stats(file).words, 3);
  assert.ok(!md.forPublishing(file).includes('Cut'));
  assert.ok(!md.excerpt(file).includes('Cut'));
  assert.equal(md.lint('Fine.\n\n<!-- notes\nthe the\n-->\n').length, 0, 'notes are not linted');
  assert.equal(md.status(md.setMeta(file, 'status', 'final')), 'final');
  assert.ok(md.setMeta(file, 'status', 'final').endsWith('<!-- notes\nCut sentence.\n\nAnother idea.\n-->\n'));
});

test('notes: cuts keep their location and round-trip', () => {
  const notes = 'Free idea.\n\n[cut] {"before":"Hello ","after":" world.","lead":"","trail":""}\nbig\n[/cut]';
  const parsed = md.parseNotes(notes);
  assert.equal(parsed.text, 'Free idea.');
  assert.deepEqual(parsed.cuts, [{ text: 'big', before: 'Hello ', after: ' world.', lead: '', trail: '' }]);
  assert.equal(md.formatNotes(parsed), notes);
  assert.deepEqual(md.parseNotes('Just text'), { text: 'Just text', cuts: [] });
  // Cut text never leaks into the published article.
  assert.ok(!md.render(md.joinNotes('Hi.\n', notes)).includes('big'));
});

test('findCutSpot finds where a cut came from, even after other edits', () => {
  const cut = { before: 'There is something ', after: 'about finding things.' };
  assert.equal(md.findCutSpot('There is something about finding things.', cut), 19);
  // Edited earlier text: the full context no longer matches, a shorter one does.
  assert.equal(md.findCutSpot('Here is something about finding things.', cut), 18);
  // Start and end of the article.
  assert.equal(md.findCutSpot('Body text here.\n', { before: '', after: 'Body text' }), 0);
  assert.equal(md.findCutSpot('Body text here.\n', { before: 'text here.\n\n', after: '' }), 15);
  // Gone entirely.
  assert.equal(md.findCutSpot('Completely different.', cut), -1);
});

test('diffText finds edited, added and removed paragraphs', () => {
  const before = '# Title\n\nKeep this paragraph.\n\nThe quick brown fox jumps.\n\nDelete me entirely.';
  const after = '# Title\n\nKeep this paragraph.\n\nThe quick red fox leaps.\n\nA brand new paragraph.';
  const d = md.diffText(before, after);
  assert.deepEqual(d.slice(0, 2).map((b) => b.type), ['same', 'same']);
  assert.equal(d[2].type, 'change');
  assert.deepEqual(d[2].parts.filter((p) => p.type !== 'same').map((p) => `${p.type}:${p.text}`),
    ['del:brown', 'add:red', 'del:jumps', 'add:leaps']);
  assert.deepEqual(d.slice(3).map((b) => `${b.type}:${b.text}`), ['del:Delete me entirely.', 'add:A brand new paragraph.']);
  assert.deepEqual(md.diffText('Same.\n\nText.', 'Same.\n\nText.').map((b) => b.type), ['same', 'same']);
});

test('readability flags long sentences, passive voice, adverbs and wordy phrases', () => {
  const long = Array.from({ length: 26 }, (_, i) => `word${i}`).join(' ') + '.';
  const src = `---\nstatus: editing\n---\n\n# A heading that is not prose\n\nThe app was designed by a small team. It moved quickly.\n\nWe did this in order to ship. ${long}\n\n\`\`\`\ncode was written here\n\`\`\`\n`;
  const r = md.readability(src);
  const found = r.issues.map((i) => `${i.kind}:${src.slice(i.start, i.end)}`);
  assert.ok(found.includes('passive:was designed'), found.join(' | '));
  assert.ok(found.includes('adverb:quickly'));
  assert.ok(found.includes('wordy:in order to'));
  assert.ok(found.includes(`long:${long}`));
  assert.ok(!found.some((f) => f.includes('heading') || f.includes('written')), 'headings and code are ignored');
  assert.equal(r.sentences, 4);
  assert.ok(r.grade > 0);
});

test('readability ignores link URLs and handles abbreviations', () => {
  const src = 'Read [the essay](https://example.com/was-designed-quickly) today, e.g. on Sunday.';
  const r = md.readability(src);
  assert.equal(r.sentences, 1);
  assert.deepEqual(r.issues, []);
});

test('readability: "just as" and "rather than" are not filler', () => {
  const kinds = (s) => md.readability(s).issues.map((i) => s.slice(i.start, i.end));
  assert.deepEqual(kinds('Just as Morris said, form rather than ornament.'), []);
  assert.deepEqual(kinds('It was just rather good.'), ['just', 'rather']);
});

test('front matter from other tools (YAML lists, title:) is understood', () => {
  const src = '---\ntitle: "From Obsidian"\ntags:\n  - design\n  - craft\naliases: []\n---\n\nBody text.\n';
  const fm = md.frontMatter(src);
  assert.equal(fm.data.title, 'From Obsidian');
  assert.equal(fm.body, '\nBody text.\n');
  assert.equal(md.title(src), 'From Obsidian');
  assert.equal(md.render(src), '<p>Body text.</p>');
  const withStatus = md.setMeta(src, 'status', 'backlog');
  assert.ok(withStatus.startsWith('---\ntitle: "From Obsidian"\ntags:\n  - design\n  - craft\naliases: []\nstatus: backlog\n---\n'));
  // A list between dividers is still content, not front matter.
  assert.equal(md.frontMatter('---\n- one\n- two\n---\n').end, 0);
});

test('created: dates are written, read back and survive other edits', () => {
  const stamp = md.formatStamp(new Date(2026, 9, 4, 19, 32));
  assert.equal(stamp, '2026-10-04 19:32');
  const src = md.setMeta(md.setMeta('# Hi\n', 'status', 'backlog'), 'created', stamp);
  assert.deepEqual(md.created(src), { ms: new Date(2026, 9, 4, 19, 32).getTime(), hasTime: true });
  assert.deepEqual(md.created('---\ncreated: 2026-10-01\n---\n'), { ms: new Date(2026, 9, 1).getTime(), hasTime: false });
  assert.equal(md.created('# No front matter'), null);
  assert.equal(md.created(md.setMeta(src, 'status', 'final')).ms, new Date(2026, 9, 4, 19, 32).getTime(), 'status changes keep it');
  assert.ok(!md.render(src).includes('2026'), 'never shown in the article');
});

test('article titles live in front matter', () => {
  const old = '---\nstatus: backlog\ncreated: 2026-10-01\n---\n\n# The Conductor’s Role\n\n## Why Design Work\n\nBody.\n';
  const lifted = md.liftTitle(old);
  assert.equal(lifted, '---\ntitle: The Conductor’s Role\nstatus: backlog\ncreated: 2026-10-01\n---\n\n## Why Design Work\n\nBody.\n');
  assert.equal(md.liftTitle(lifted), lifted, 'already lifted: unchanged');
  assert.equal(md.liftTitle('Intro first.\n\n# Later heading\n'), 'Intro first.\n\n# Later heading\n', 'only a leading heading is lifted');
  assert.equal(md.title(lifted), 'The Conductor’s Role');
  assert.ok(md.render(lifted, { withTitle: true }).startsWith('<h1 id="the-conductors-role">The Conductor’s Role</h1>\n<h2'));
  assert.ok(!md.render(lifted).includes('<h1'), 'body render has no title');
  // Copy for Ghost no longer strips the first section heading.
  assert.equal(md.forPublishing(lifted), '## Why Design Work\n\nBody.\n');
  assert.equal(md.forPublishing(lifted, { includeTitle: true }), '# The Conductor’s Role\n\n## Why Design Work\n\nBody.\n');
  assert.equal(md.setMeta('', 'title', 'Design: A Story'), '---\ntitle: "Design: A Story"\n---\n\n');
  assert.equal(md.title('---\ntitle: "Design: A Story"\n---\n'), 'Design: A Story');
});

test('quoteMarkdown formats a quote with its attribution', () => {
  assert.equal(md.quoteMarkdown({ text: 'Useful or beautiful.', author: 'William Morris', source: 'The Beauty of Life' }),
    '> Useful or beautiful.\n>\n> — William Morris, *The Beauty of Life*');
  assert.equal(md.quoteMarkdown({ text: 'Less, but better.', author: 'Dieter Rams', source: 'https://example.com/rams' }),
    '> Less, but better.\n>\n> — [Dieter Rams](https://example.com/rams)');
  assert.equal(md.quoteMarkdown({ text: 'Line one.\nLine two.' }), '> Line one.\n>\n> Line two.');
  assert.ok(md.render(md.quoteMarkdown({ text: 'Hi.', author: 'Me' })).startsWith('<blockquote>'));
});
