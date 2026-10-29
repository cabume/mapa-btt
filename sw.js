// Mi Mapa BTT: guarda la app para que abra aunque el servidor local ya se haya cerrado.
const CACHE = 'mimapabtt-v3';
const FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'lib/leaflet.js', 'lib/leaflet.css', 'lib/images/layers.png', 'lib/images/layers-2x.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // Strava, mapas y fotos: directo
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key)));
});
