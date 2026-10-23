/* DB Writer — the bridge: the one place the page reaches outside itself.
 * Here it talks to the local Node server; a native Mac or iOS app would provide
 * the same calls from Swift, and everything else in the page stays the same. */
(() => {
  'use strict';

  async function call(method, url, data, { keepalive = false } = {}) {
    const res = await fetch(url, {
      method,
      keepalive,
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, data: json });
    return json;
  }
  const q = (params) => new URLSearchParams(params).toString();

  window.DBBridge = {
    // Files in the writing folders (articles/, thoughts/, quick-notes/, journal/), by path
    // relative to the project, e.g. "articles/morris-material.md". Each has a version (mtime).
    // [{ name, dir, mtime, content? }] — with content: true, the text of each .md/.json file.
    listFiles: (dir, { content = false } = {}) => call('GET', `/api/files?${q({ dir, ...(content && { content: 1 }) })}`).then((r) => r.entries),
    // { content, mtime }; fails with status 404 if it isn't there.
    readFile: (path) => call('GET', `/api/files?${q({ path })}`),
    // { mtime }. With mtime, fails with status 409 (data.current = what's on disk) if the file
    // changed since; with create, fails with 409 if it already exists.
    writeFile: (path, content, { mtime = null, create = false, keepalive = false } = {}) =>
      call('PUT', '/api/files', { path, content, mtime, create }, { keepalive }),
    // A file or folder; fails with 409 if something is already at `to`, 404 if `from` is missing.
    moveFile: (from, to) => call('POST', '/api/files/move', { from, to }),
    deleteFile: (path) => call('DELETE', `/api/files?${q({ path })}`),

    // A data file (e.g. "quotes"): { data, version }, with data null if there isn't one yet.
    readData: (name) => call('GET', `/api/data/${encodeURIComponent(name)}`),
    // Save it. Fails with status 409 if it changed since `version` (another tab saved it).
    writeData: (name, data, version) => call('PUT', `/api/data/${encodeURIComponent(name)}`, { data, version }),

    // Images, saved in images/ and used in articles as ../images/<name>. Names are made unique.
    // Saves an image file (a File or Blob): { name, path }.
    saveImage: async (file, name) => {
      const res = await fetch(`/api/images?${q({ name })}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, data: json });
      return json;
    },
    // Downloads a web image, saving it as `name` (or reusing an identical copy): { name, path, reused }.
    downloadImage: (url, name) => call('POST', '/api/images/fetch', { url, name }),

    // peterkaizer.com (the 11ty site set by THOUGHTS_SITE). The rules are in lib/thoughtsite.js.
    // The posts in its src/thoughts: [{ name, content }]. Fails with 503 if the site isn't set up.
    siteThoughts: () => call('GET', '/api/site/thoughts'),
    // Writes src/thoughts/<name>.
    writeSiteThought: (name, content) => call('PUT', '/api/site/thoughts', { name, content }),
    // Writes a social preview image to src/assets/images/thoughts/<name> (a File or Blob).
    writeSiteImage: async (name, blob) => {
      const res = await fetch(`/api/site/images?${q({ name })}`, { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, data: json });
      return json;
    },
    // Commits just that post and its image (if they changed) and pushes: { committed, pushed, note }.
    commitSiteThought: (name, message, image = null) => call('POST', '/api/site/commit', { name, message, image }),

    // A web page's { title, description, site } (any of them may be missing).
    pageDetails: (url) => call('POST', '/api/page-details', { url }),

    // Claude, with the API key kept outside the page. The page writes the request
    // (lib/claude.js): { model, system, prompt, schema, maxTokens, effort }; the answer is
    // { text (JSON matching schema), model, stopReason }.
    askClaude: (request) => call('POST', '/api/claude', request),
  };
})();
