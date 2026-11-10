// Service Worker: App-Dateien zuerst aus dem Netz (damit Updates sofort ankommen),
// bei fehlender Verbindung aus dem Cache. Supabase, Karten und OSM-Abfragen
// gehen immer direkt ins Netz.
const CACHE = 'hideseek-v10';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/config.js',
  'js/version.js',
  'js/sb.js',
  'js/ui.js',
  'js/geo.js',
  'js/osm.js',
  'js/catalog.js',
  'js/photo.js',
  'js/mapview.js',
  'js/views/home.js',
  'js/views/join.js',
  'js/views/create.js',
  'js/views/game.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
