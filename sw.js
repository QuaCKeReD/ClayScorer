const CACHE_NAME = 'sarge-sporting-v2';
const ICON_URL = 'https://cdn-icons-png.flaticon.com/512/3211/3211313.png';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  ICON_URL,
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://html2canvas.hertzen.com/dist/html2canvas.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
