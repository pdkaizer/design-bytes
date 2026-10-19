/* DB Writer — the bridge: the one place the page reaches outside itself.
 * Here it talks to the local Node server; a native Mac or iOS app would provide
 * the same calls from Swift, and everything else in the page stays the same. */
(() => {
  'use strict';

  async function call(method, url, data) {
    const res = await fetch(url, {
      method,
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, data: json });
    return json;
  }

  window.DBBridge = {
    // A data file (e.g. "quotes"): { data, version }, with data null if there isn't one yet.
    readData: (name) => call('GET', `/api/data/${encodeURIComponent(name)}`),
    // Save it. Fails with status 409 if it changed since `version` (another tab saved it).
    writeData: (name, data, version) => call('PUT', `/api/data/${encodeURIComponent(name)}`, { data, version }),

    // A web page's { title, description, site } (any of them may be missing).
    pageDetails: (url) => call('POST', '/api/page-details', { url }),

    // Claude, with the API key kept outside the page.
    // Five rewordings of a selection: { suggestions: [...] }.
    suggestAlternatives: (request) => call('POST', '/api/suggest', request),
    // Subject tags for a link: { tags: [...] }.
    suggestTags: (link) => call('POST', '/api/suggest-tags', link),
  };
})();
