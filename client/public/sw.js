const CACHE_NAME = 'echelon-v1';
const urlsToCache = [
  '/',
  '/picking',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const pathname = new URL(event.request.url).pathname.toLowerCase();
  // Admin preview authorization must be checked online for every visit. Never
  // restore its page or API responses from a previous administrator's cache.
  const privatePreviewPrefixes = ['/return-portal', '/returns/portal-preview', '/api/returns/admin/portal-preview'];
  if (privatePreviewPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
