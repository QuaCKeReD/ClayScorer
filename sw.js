const CACHE_NAME = 'sarge-sporting-v1';
const ICON_URL = 'https://img.icons8.com/ios-filled/512/target.png';
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
