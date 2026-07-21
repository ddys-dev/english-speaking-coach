/* Simple offline-first cache for the app shell.
   Bump CACHE version when you change files. */
const CACHE = 'speakprep-v16';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=16',
  './app.js?v=16',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // Take over as soon as we are installed. Waiting for the user to tap 更新
  // meant a stale worker could keep serving an old bundle indefinitely, and
  // escaping it needed a manual hard reload — the one thing the update button
  // is supposed to spare them. The page decides what to do about the handover
  // (see the controllerchange listener in app.js).
  self.skipWaiting();
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

/* The app shell is network-first: a cache-first worker will happily serve a
   stale app.js forever, which is exactly what stranded the app on an old
   version. Icons stay cache-first — they don't change. Anything cross-origin
   (Gemini, GitHub sync) is left entirely alone. */
const SHELL = /\.(?:html|css|js|webmanifest)$/;

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  const isShell = e.request.mode === 'navigate' || SHELL.test(url.pathname);

  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
