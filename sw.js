// Service worker: app disponibile offline + cache delle mappe e dell'altimetria
const SHELL = 'cp-shell-v19';
// solo risposte CORS: le risposte "opache" Chrome le conta ~7 MB l'una e satura lo spazio del sito
const TILES = 'cp-tiles-v2';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/config.js', 'js/db.js', 'js/icons.js', 'js/geo.js', 'js/dem.js', 'js/weather.js',
  'js/engine.js', 'js/sources.js', 'js/contours.js', 'js/analysis.js', 'js/gpx.js', 'js/finds.js', 'js/drive.js', 'js/climate.js', 'js/gauges.js', 'js/access.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const TILE_HOSTS = ['tile.opentopomap.org', 'tile.openstreetmap.org', 'server.arcgisonline.com', 'elevation-tiles-prod'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith('cp-shell-') && k !== SHELL) || k === 'cp-tiles') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Mappe e altimetria: prima la cache, poi la rete (e salva)
  if (TILE_HOSTS.some((h) => url.href.includes(h))) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type !== 'opaque') c.put(req.url, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // File dell'app: prima la rete (aggiornamenti), poi la cache
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(req, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? c.match('index.html') : new Response('', { status: 504 }));
      }
    })());
  }
});
