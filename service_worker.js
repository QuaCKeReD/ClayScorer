const CACHE_NAME = 'clayscorer-v1';

// Same-origin assets: `cache.addAll` is all-or-nothing, but these are local files
// we control, so a hard-fail here is the right behaviour.
const LOCAL_ASSETS = [
  './',
  './index.html',
  './sporting.html',
  './sportrap.html',
  './compak.html',
  './skeet.html',
  './manifest.json',
  './assets/scorer.css',
  './assets/scorer.js',
  './assets/vendor/tailwindcss-3.4.17.js',
  './assets/vendor/lucide-0.468.0.min.js',
  './assets/vendor/html2canvas-1.4.1.min.js',
  './assets/target.png',
  './assets/target.ico',
  './favicon.ico',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(LOCAL_ASSETS);
    } catch (err) {
      console.warn('SW local addAll failed', err);
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Cache-first with runtime caching: on a miss, fetch from the network and stash a
// clone for next time.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && (res.status === 200 || res.type === 'opaque')) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});
