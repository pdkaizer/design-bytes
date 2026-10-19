'use strict';

// Reads a web page's title, description and site name, for saving a link.
// The page asks for this through the bridge; a native app would do the same
// fetch itself. Never throws: on any problem it returns what it can.

const FETCH_TIMEOUT = 8000;
const MAX_PAGE = 768 * 1024;

const decode = (s) => String(s || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return '';
}

async function pageDetails(href) {
  const url = new URL(href);
  if (!/^https?:$/.test(url.protocol)) return {};
  try {
    const res = await fetch(href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) DBWriter/1.0', Accept: 'text/html,application/xhtml+xml' },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/html/i.test(type)) {
      // A PDF or image: name it after the file.
      const file = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
      return { title: file };
    }
    // Read just the start of the page — the <head> is all we need.
    const reader = res.body.getReader();
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < MAX_PAGE) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    return {
      title: meta(html, ['og:title', 'twitter:title']) || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
      description: meta(html, ['og:description', 'description', 'twitter:description']),
      site: meta(html, ['og:site_name']),
    };
  } catch {
    return {};
  }
}

module.exports = { pageDetails };
