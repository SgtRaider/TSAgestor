/* TSAgestor — Service Worker
 *
 * Estrategia:
 *   - App shell (HTML, CSS, JS, iconos, librerías CDN) -> cache-first.
 *   - APIs externas (/api/*, AWC, EUMETView, RainViewer, Open-Meteo, Autorouter,
 *     tiles, fuentes Google) -> network-first con fallback a cache si existe.
 *   - Navegaciones (request.mode === 'navigate') sin red -> cache de index.html.
 *
 * Para forzar invalidación al desplegar nueva versión, sube CACHE_VERSION.
 */

const CACHE_VERSION = 'tsagestor-v193';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './assets/icon.svg',
  './assets/rokiski-blanco.svg',
  './assets/rokiski-blanco.png',
  './assets/logo-ea-azul.png',
  './js/geom.js',
  './js/offlineGeo.js',
  './js/aipData.js',
  './js/airways.js',
  './js/airspace.js',
  './js/settings.js',
  './js/savedPlans.js',
  './js/meteoApi.js',
  './js/metarDecode.js',
  './js/parser.js',
  './js/scheduleFmt.js',
  './js/filters.js',
  './js/mapView.js',
  './js/trafficLayer.js',
  './js/b1Layout.js',
  './js/notamView.js',
  './js/notamHub.js',
  './js/kmlIO.js',
  './js/crossSection.js',
  './js/flightPlan.js',
  './js/pdfExport.js',
  './js/app.js',
  // Librerías CDN (mismo origen no, pero las cacheamos para uso offline)
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
];

// Hosts que deben ir siempre por red (datos en tiempo real). Sin esto
// la estrategia cache-first del SW serviria la PRIMERA respuesta para
// siempre, congelando posiciones de aviones, METARs, tiles de RainViewer
// etc. airplanes.live se anadio explicitamente porque su /point/...
// devuelve snapshots ADS-B y necesita ir siempre por red.
const NETWORK_FIRST_HOSTS = [
  'api.open-meteo.com',
  'aviationweather.gov',
  'tilecache.rainviewer.com',
  'view.eumetsat.int',
  'api.autorouter.aero',
  'api.airplanes.live',
  'globe.airplanes.live',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll falla si una sola respuesta falla. Usamos add individual con catch
      // para que un CDN caído no bloquee la instalación del SW.
      // cache:'reload' fuerza la descarga desde la red ignorando la cache HTTP
      // del navegador, asi al subir CACHE_VERSION garantizamos assets frescos
      // (sin esto, un styles.css con max-age largo se quedaria viejo).
      Promise.all(
        SHELL_ASSETS.map((url) => {
          const req = new Request(url, { cache: 'reload' });
          return cache.add(req).catch((err) => {
            console.warn('[SW] no se pudo cachear', url, err);
          });
        })
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  console.info('[SW] activando', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => {
            console.info('[SW] borrando cache vieja', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

function isNetworkFirst(url) {
  if (url.pathname.startsWith('/api/')) return true;
  return NETWORK_FIRST_HOSTS.some((h) => url.hostname.endsWith(h));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Navegaciones: intenta red, cae a index.html cacheado.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('./index.html').then((r) => r || caches.match('./'))
      )
    );
    return;
  }

  // Si nada en cache ni en red puede satisfacer la peticion, devolvemos
  // una Response opaca (Network Error 504) en lugar de undefined. Esto
  // evita el "Failed to convert value to 'Response'" que rompia el SW.
  const networkErrorResponse = () => new Response('', {
    status: 504,
    statusText: 'SW network error fallback',
  });

  // APIs y tiles meteo: network-first.
  if (isNetworkFirst(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cachea solo respuestas OK para tener algo offline después.
          if (res && res.ok && (req.method === 'GET')) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || networkErrorResponse()))
    );
    return;
  }

  // App shell y todo lo demás: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached || networkErrorResponse());
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
