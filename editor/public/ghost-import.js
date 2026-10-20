/* DB Writer — importing published posts from a Ghost export (.json) as articles. */
(() => {
  'use strict';

  const { toast, prefs } = window.dbw;
  const $ = (sel, root = document) => root.querySelector(sel);
  const PLACEHOLDER = '__GHOST_URL__';

  // Ghost serves resized copies at /content/images/size/w1200/…; download the original.
  const originalImage = (src) => src.replace(/\/content\/images\/size\/[^/]+\//, '/content/images/');
  // Name a downloaded image after its path, so it's recognisable: /content/images/2024/03/photo.jpg → 2024-03-photo.jpg.
  function imageName(src) {
    try {
      const parts = decodeURIComponent(new URL(originalImage(src)).pathname).split('/').filter(Boolean);
      return parts.slice(-3).join('-').replace(/^content-images-/, '').replace(/^images-/, '');
    } catch {
      return '';
    }
  }

  const h = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };

  // ---------------------------------------------------------------------------
  // HTML → Markdown, for Ghost's post HTML (including its "cards").

  const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'FIGURE', 'DIV', 'TABLE', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'IFRAME', 'VIDEO', 'AUDIO', 'DETAILS']);

  // Embedded players become ordinary links to the video's page.
  function mediaLink(src) {
    const yt = src.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/);
    if (yt) return `[Watch on YouTube](https://www.youtube.com/watch?v=${yt[1]})`;
    const vimeo = src.match(/player\.vimeo\.com\/video\/(\d+)/);
    if (vimeo) return `[Watch on Vimeo](https://vimeo.com/${vimeo[1]})`;
    return `[Embedded media](${src})`;
  }

  function converter(resolve) {
    const esc = (s) => s.replace(/([\\`*_[\]])/g, '\\$1');

    function inline(node) {
      let out = '';
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { out += esc(n.textContent.replace(/\s+/g, ' ')); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        const inner = () => inline(n);
        const wrap = (mark) => {
          const t = inner();
          const lead = t.match(/^\s*/)[0];
          const trail = t.match(/\s*$/)[0];
          const core = t.trim();
          return core ? `${lead}${mark}${core}${mark}${trail}` : t;
        };
        if (tag === 'STRONG' || tag === 'B') out += wrap('**');
        else if (tag === 'EM' || tag === 'I') out += wrap('_');
        else if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') out += wrap('~~');
        else if (tag === 'CODE') out += `\`${n.textContent}\``;
        else if (tag === 'BR') out += '  \n';
        else if (tag === 'IMG') out += image(n);
        else if (tag === 'A') {
          const text = inner().trim() || n.getAttribute('href') || '';
          const href = resolve(n.getAttribute('href') || '', false);
          out += href ? `[${text}](${href})` : text;
        } else out += inner();
      }
      return out;
    }

    function image(img) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (!src) return '';
      return `![${(img.getAttribute('alt') || '').replace(/[[\]]/g, '')}](${resolve(src, true)})`;
    }

    function list(el, depth) {
      const ordered = el.tagName === 'OL';
      let n = Number(el.getAttribute('start')) || 1;
      const lines = [];
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue;
        const marker = ordered ? `${n++}. ` : '- ';
        const pad = ' '.repeat(marker.length);
        const text = [];
        const nested = [];
        for (const c of li.childNodes) {
          if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(list(c, depth + 1));
          else if (c.nodeType === 1 && c.tagName === 'P') text.push(inline(c).trim());
          else if (c.nodeType === 1 && BLOCK.has(c.tagName)) text.push(blocks(c).join('\n\n'));
          else text.push(c.nodeType === 3 ? esc(c.textContent.replace(/\s+/g, ' ')) : inline(h('span', {}, c.cloneNode(true))));
        }
        const body = text.join(' ').replace(/\s+\n/g, '\n').trim().split('\n').map((l, i) => (i ? pad + l : l)).join('\n');
        lines.push(marker + body);
        for (const sub of nested) lines.push(sub.split('\n').map((l) => pad + l).join('\n'));
      }
      return lines.join('\n');
    }

    function table(el) {
      const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
      return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
    }

    function card(el) {
      const cls = el.className || '';
      if (/kg-bookmark-card/.test(cls)) {
        const a = el.querySelector('a');
        const title = (el.querySelector('.kg-bookmark-title')?.textContent || a?.textContent || '').trim();
        return a ? `[${esc(title || a.href)}](${resolve(a.getAttribute('href'), false)})` : '';
      }
      if (/kg-embed-card|kg-video-card|kg-audio-card/.test(cls)) {
        const frame = el.querySelector('iframe, video, audio, source');
        const src = frame?.getAttribute('src');
        const link = el.querySelector('a[href]');
        if (src) return mediaLink(resolve(src, false));
        if (link) return `[${esc(link.textContent.trim() || 'Embedded post')}](${resolve(link.getAttribute('href'), false)})`;
        return '';
      }
      if (/kg-callout-card/.test(cls)) {
        const emoji = el.querySelector('.kg-callout-emoji')?.textContent.trim();
        const text = inline(el.querySelector('.kg-callout-text') || el).trim();
        return `> ${emoji ? `${emoji} ` : ''}${text}`;
      }
      if (/kg-button-card/.test(cls)) {
        const a = el.querySelector('a');
        return a ? `[${esc(a.textContent.trim())}](${resolve(a.getAttribute('href'), false)})` : '';
      }
      if (/kg-toggle-card/.test(cls)) {
        const head = el.querySelector('.kg-toggle-heading-text, h4')?.textContent.trim();
        const content = el.querySelector('.kg-toggle-content');
        return [head ? `**${esc(head)}**` : '', content ? blocks(content).join('\n\n') : ''].filter(Boolean).join('\n\n');
      }
      return null;
    }

    function figure(el) {
      const special = card(el);
      if (special !== null) return special;
      const imgs = [...el.querySelectorAll('img')];
      const caption = el.querySelector('figcaption');
      const parts = imgs.map(image);
      // Captions become one italic line (plain text, so nested emphasis can't break it).
      if (caption && caption.textContent.trim()) parts.push(`_${esc(caption.textContent.replace(/\s+/g, ' ').trim())}_`);
      if (!imgs.length) return blocks(el).join('\n\n');
      return parts.join('\n\n');
    }

    function blocks(container) {
      const out = [];
      let pending = '';
      const flush = () => { if (pending.trim()) out.push(pending.trim()); pending = ''; };
      for (const n of container.childNodes) {
        if (n.nodeType === 3) { pending += esc(n.textContent.replace(/\s+/g, ' ')); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (!BLOCK.has(tag) && !/^H[1-6]$/.test(tag)) { pending += inline(h('span', {}, n.cloneNode(true))); continue; }
        flush();
        if (tag === 'P') out.push(inline(n).trim());
        else if (/^H[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${inline(n).trim()}`);
        else if (tag === 'UL' || tag === 'OL') out.push(list(n, 0));
        else if (tag === 'BLOCKQUOTE') out.push(blocks(n).join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
        else if (tag === 'PRE') {
          const code = n.querySelector('code');
          const lang = (code?.className.match(/language-(\S+)/) || [])[1] || '';
          out.push(`\`\`\`${lang}\n${(code || n).textContent.replace(/\n$/, '')}\n\`\`\``);
        } else if (tag === 'HR') out.push('---');
        else if (tag === 'FIGURE') out.push(figure(n));
        else if (tag === 'TABLE') out.push(table(n));
        else if (tag === 'IFRAME' || tag === 'VIDEO' || tag === 'AUDIO') {
          const src = n.getAttribute('src') || n.querySelector('source')?.getAttribute('src');
          if (src) out.push(mediaLink(resolve(src, false)));
        } else {
          const special = card(n);
          out.push(special !== null ? special : blocks(n).join('\n\n'));
        }
      }
      flush();
      return out.filter((b) => b && b.trim());
    }

    return (html) => {
      const doc = new DOMParser().parseFromString(`<!doctype html><body>${html || ''}</body>`, 'text/html');
      return blocks(doc.body).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    };
  }

  // ---------------------------------------------------------------------------
  // Reading the export

  function parseExport(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    const db = Array.isArray(data?.db) ? data.db[0]?.data : data?.data;
    if (!db || !Array.isArray(db.posts)) return null;
    const tags = new Map((db.tags || []).map((t) => [t.id, t]));
    const postTags = new Map();
    for (const pt of [...(db.posts_tags || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))) {
      const t = tags.get(pt.tag_id);
      if (!t || t.visibility === 'internal' || String(t.name).startsWith('#')) continue;
      if (!postTags.has(pt.post_id)) postTags.set(pt.post_id, []);
      postTags.get(pt.post_id).push(t.name);
    }
    const title = (db.settings || []).find((s) => s.key === 'title')?.value;
    const posts = db.posts
      .filter((p) => (p.type || 'post') === 'post' && p.status === 'published')
      .map((p) => ({ ...p, tagNames: postTags.get(p.id) || [] }))
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    // Guess the site address from any absolute image or link in the export.
    const seen = text.match(/https?:\/\/[^"\\\s]+?(?=\/content\/images\/)/);
    return { posts, siteTitle: title, siteGuess: seen ? seen[0] : '' };
  }

  const yaml = (v) => (/^[\w][\w .,&’'!?()-]*$/.test(v) && !/: |\s#|^-/.test(v) ? v : JSON.stringify(String(v)));
  const isoDay = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ---------------------------------------------------------------------------
  // The dialog and the import itself

  async function importGhost(file) {
    const parsed = parseExport(await file.text());
    if (!parsed) { toast('That .json file isn’t a Ghost export — export it from Ghost Admin → Settings → Advanced → Import/Export'); return; }
    if (!parsed.posts.length) { toast('No published posts in that Ghost export'); return; }
    const have = new Set(window.dbw.articles().filter((a) => a.kind === 'articles').map((a) => a.slug));

    const dialog = $('#ghost-dialog');
    const site = $('#ghost-site');
    site.value = prefs.get('ghost-site', '') || parsed.siteGuess;
    $('#ghost-sub').textContent = `${parsed.posts.length} published post${parsed.posts.length === 1 ? '' : 's'}${parsed.siteTitle ? ` from “${parsed.siteTitle}”` : ''}. They’ll come in as Published articles with their original dates.`;
    const boxes = parsed.posts.map((p) => {
      const exists = have.has(p.slug);
      const box = h('input', { type: 'checkbox' });
      box.checked = !exists;
      const date = new Date(p.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const row = h('label', { class: 'ghost-row' }, box, h('span', {},
        h('span', { class: 't' }, p.title),
        h('span', { class: 'm' }, [date, p.tagNames.join(', '), exists ? 'already in DB Writer' : ''].filter(Boolean).join(' · '))));
      return { p, box, row };
    });
    const count = () => {
      const n = boxes.filter((b) => b.box.checked).length;
      $('#ghost-ok').textContent = n ? `Import ${n}` : 'Import';
      $('#ghost-ok').disabled = !n;
    };
    boxes.forEach((b) => b.box.addEventListener('change', count));
    $('#ghost-list').replaceChildren(...boxes.map((b) => b.row));
    $('#ghost-all').onclick = () => { boxes.forEach((b) => { b.box.checked = true; }); count(); };
    $('#ghost-none').onclick = () => { boxes.forEach((b) => { b.box.checked = false; }); count(); };
    count();

    const ok = await new Promise((resolve) => {
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
      dialog.showModal();
    });
    if (!ok) return;

    const siteUrl = site.value.trim().replace(/\/+$/, '');
    if (siteUrl) prefs.set('ghost-site', siteUrl);
    const download = $('#ghost-images').checked;
    const chosen = boxes.filter((b) => b.box.checked).map((b) => b.p);
    await runImport(chosen, siteUrl, download);
  }

  async function runImport(posts, siteUrl, download) {
    const images = new Map(); // web address → ../images/name (one download per image)
    let downloaded = 0;
    const failedImages = [];
    const failed = [];
    let last = null;

    for (const [i, p] of posts.entries()) {
      toast(`Importing ${i + 1} of ${posts.length}: ${p.title}…`);
      const absolute = (src) => (src || '').replace(PLACEHOLDER, siteUrl || PLACEHOLDER);
      // First pass: find the images; download them; second pass writes local paths.
      const wanted = new Set();
      const collect = converter((src, isImage) => { if (isImage) wanted.add(absolute(src)); return absolute(src); });
      collect(p.html || '');
      if (p.feature_image) wanted.add(absolute(p.feature_image));
      if (download) {
        for (const src of wanted) {
          if (images.has(src) || !/^https?:/i.test(src)) continue;
          try {
            const r = await window.DBBridge.downloadImage(originalImage(src), imageName(src));
            images.set(src, r.path);
            if (!r.reused) downloaded++;
          } catch (err) {
            failedImages.push(src);
          }
        }
      }
      const toMd = converter((src, isImage) => (isImage && images.has(absolute(src)) ? images.get(absolute(src)) : absolute(src)));
      const body = toMd(p.html || '') || (p.plaintext || '').trim();

      const fm = [`title: ${yaml(p.title)}`, `slug: ${p.slug}`];
      if (p.tagNames.length) fm.push('tags:', ...p.tagNames.map((t) => `  - ${yaml(t)}`));
      if (p.custom_excerpt) fm.push(`excerpt: ${JSON.stringify(p.custom_excerpt)}`);
      if (p.feature_image) fm.push(`feature_image: ${images.get(absolute(p.feature_image)) || absolute(p.feature_image)}`);
      const content = `---\n${fm.join('\n')}\n---\n\n${body}\n`;
      try {
        last = await window.dbw.documents.create('articles', { content, filename: `${p.slug}.md`, name: p.slug, published: true, date: isoDay(p.published_at) });
      } catch (err) {
        failed.push(`${p.title} (${err.message})`);
      }
    }

    await window.dbw.loadList();
    if (last) window.dbw.openDoc('articles', last.slug);
    const done = posts.length - failed.length;
    const parts = [`Imported ${done} article${done === 1 ? '' : 's'} from Ghost`];
    if (download) parts.push(`${downloaded} image${downloaded === 1 ? '' : 's'} downloaded`);
    if (failedImages.length) parts.push(`${failedImages.length} image${failedImages.length === 1 ? '' : 's'} couldn’t be downloaded${siteUrl ? '' : ' (add your site address)'} and still point to Ghost`);
    if (failed.length) parts.push(`couldn’t import ${failed.join(', ')}`);
    toast(parts.join(' · '));
    if (failedImages.length) console.warn('Images that could not be downloaded:', failedImages);
  }

  window.dbw.importGhost = importGhost;
  window.dbw.ghostToMarkdown = (html, resolve = (s) => s) => converter(resolve)(html); // for tests
})();
