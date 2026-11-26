// Offline support: the whole app is cached on first visit and served from the
// cache from then on, so Cue Pad works with no internet. Bump VERSION whenever
// app files change so devices pick up the update.
const VERSION = 'cuepad-v1.10.0';
const FILES = [
  './',
  './index.html',
  './css/app.css',
  './js/main.js',
  './js/app.js',
  './js/pairing.js',
  './js/remote-host.js',
  './js/remote-client.js',
  './vendor/qrcode.js',
  './vendor/jsQR.js',
  './js/volume.js',
  './js/layout.js',
  './js/transport.js',
  './js/icons.js',
  './js/upload.js',
  './assets/logo.svg',
  './js/engine.js',
  './js/db.js',
  './js/backup.js',
  './js/editor.js',
  './js/audiotools.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (req.mode === 'navigate') {
      const hit = await cache.match('./index.html');
      if (hit) return hit;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // Cache optional extras (such as the logo) the first time they load.
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
