'use strict';
// the record's service worker — precache the shell, keep last-read meetings,
// and let the page announce a fresher pressing. Cache name is the corpus
// fingerprint (deterministic; a new edition = a new cache).
const CACHE = 'cz-record-2.1.9-66c05a9544c70585';
const SHELL = ["/app/","/app/app.css?v=2.1.9","/app/app.js?v=2.1.9","/app/favicon.svg","/app/manifest.json","/app/stats.json","/app/s/","/app/watching/","/app/officials/","/app/p/","/app/r/","/app/ai/"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE && k.indexOf('cz-record-') === 0).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.indexOf('/app/') !== 0) return;
  // cache-first: the edition is immutable within a pressing; the shell and any
  // meeting you've read stay available offline. A bare-path navigation
  // (/app/s) falls to its canonical slash form before the network — the host
  // would have 301'd it there anyway, and offline has no host. Redirected
  // responses are never cached: serving one to a navigation is a browser
  // error, not a page.
  e.respondWith(caches.match(req)
    .then(hit => hit || (req.mode === 'navigate' && url.pathname.slice(-1) !== '/'
        ? caches.match(url.pathname + '/') : undefined))
    .then(hit => hit || fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic' && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => hit)));
});
