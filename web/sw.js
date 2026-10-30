// Service worker: makes SSH Portal installable and lets it open instantly
// (and offline: the bridge and your LAN don't need the internet).
// Bump VERSION to roll out a new app shell.
const VERSION = 'v9';
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime-v1';

const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'css/app.css',
  'js/main.js',
  'js/ui.js',
  'js/bridge.js',
  'js/bridge-setup.js',
  'js/config.js',
  'js/prefs.js',
  'js/files.js',
  'js/editor.js',
  'js/apps.js',
  'js/system.js',
  'js/network.js',
  'js/kit.js',
  'js/sudo.js',
  'js/logs.js',
  'js/services.js',
  'js/docker.js',
  'js/devices.js',
  'js/palette.js',
  'js/terminals.js',
  'js/desktop.js',
];

// Third-party code we load from CDNs (pinned versions, safe to cache forever).
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL && key !== RUNTIME) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never touch the local bridge (127.0.0.1 / localhost on another port).
  if (url.origin !== location.origin && !CDN.test(req.url)) return;

  // Pages: network first so updates arrive, cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html')),
    );
    return;
  }

  // CDN libraries and fonts: cache first.
  if (CDN.test(req.url)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok || res.type === 'opaque') {
              const copy = res.clone();
              caches.open(RUNTIME).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Own files: serve from cache, refresh in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
