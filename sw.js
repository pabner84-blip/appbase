/* =========================================================================
   SERVICE WORKER — TIENDA 1 (app instalable y offline)
   Guarda en caché los archivos de la app para que abra como una app y
   funcione sin internet (los datos se sincronizan cuando hay conexión).
   ========================================================================= */

const CACHE = 'stockferre-v1';

// Archivos esenciales para que la app arranque sin conexión.
// Los CDNs (Firebase, Tesseract, lector de barras, fuentes) también se
// pre-cachean: con una sola visita quedan listos para usar offline.
const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './firebase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://unpkg.com/@zxing/library@0.20.0',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js',
  'https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Cormorant+Garamond:ital,wght@1,300&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => {
        // addAll falla si UNA sola URL no responde; para que el SW se instale
        // igual aunque un CDN esté caído, se precachean una por una.
        return Promise.allSettled(
          PRECACHE.map((u) => cache.add(new Request(u, { mode: 'cors' })))
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // Firebase, ventas, etc. pasan normal

  const url = new URL(req.url);
  const esNavegacion = req.mode === 'navigate';

  // Pedidos opacos (imágenes de la web, Google Fonts con no-cors, etc.):
  // se dejan pasar sin tocar para no guardar respuestas ilegibles.
  if (req.mode !== 'cors' && url.origin !== self.location.origin) {
    return; // el navegador los maneja normal
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Navegación: primero red (para ver lo nuevo), si falla usa la copia.
    if (esNavegacion) {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const copia = await cache.match('./index.html');
        if (copia) return copia;
        return new Response('Sin conexión y sin copia guardada.', { status: 503 });
      }
    }

    // Resto: usa la copia si existe y en segundo plano la actualiza.
    const cached = await cache.match(req);
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) return cached;
    return (await network) || new Response('', { status: 504 });
  })());
});