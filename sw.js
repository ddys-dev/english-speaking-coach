/* Simple offline-first cache for the app shell.
   Bump CACHE version when you change files. */
const CACHE = 'speakprep-v7';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // Do NOT auto-skipWaiting — wait for the user to tap "更新" in the app,
  // which posts SKIP_WAITING below. This powers the update banner.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls (Gemini + GitHub sync) — always go to network.
  if (url.hostname.includes('generativelanguage.googleapis.com')) return;
  if (url.hostname.includes('api.github.com') || url.hostname.includes('raw.githubusercontent.com')) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
