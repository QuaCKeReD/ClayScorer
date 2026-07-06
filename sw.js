const CACHE_NAME = 'clayscorer-v4';
const ICON_URL = 'https://img.icons8.com/ios-filled/512/target.png';
const ASSETS = [
  './',
  './index.html',
  './sporting.html',
  './sportrap.html',
  './compak.html',
  './skeet.html',
  './manifest.json',
  './assets/scorer.css',
  './assets/scorer.js',
  ICON_URL,
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://html2canvas.hertzen.com/dist/html2canvas.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
