const CACHE_NAME = 'clayscorer-v3';
const ICON_URL = 'https://img.icons8.com/ios-filled/512/target.png';

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
  './assets/target.png',
  './assets/target.ico',
  './favicon.ico',
];

// Cross-origin assets: fetched with `mode: 'no-cors'` so redirects and CORS-less
// responses (e.g. cdn.tailwindcss.com) still produce cacheable opaque responses.
// Wrapped in Promise.allSettled so any single failure just gets logged — install
// still completes and the fetch handler below will pick the asset up next time
// the page is online. This is what fixes the "SW addAll failed on tailwindcss"
// error: previously one bad CDN URL aborted the whole install and NO assets
// ended up cached.
const CROSS_ORIGIN_ASSETS = [
  ICON_URL,
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://html2canvas.hertzen.com/dist/html2canvas.min.js',
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
    await Promise.allSettled(CROSS_ORIGIN_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'no-cors', cache: 'reload' });
        await cache.put(url, res);
      } catch (err) {
        console.warn('SW pre-cache skipped', url, err);
      }
    }));
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
// clone (including opaque cross-origin responses) for next time.
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
