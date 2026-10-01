// Cloudflare Pages Function — proxy de NOAA Aviation Weather Center.
//
// AWC no devuelve cabeceras CORS desde orígenes externos, así que el
// navegador bloquea la petición directa. Esta función vive en el mismo
// dominio que la app (tsagestor.pages.dev/api/awc/...), reenvía la
// petición a aviationweather.gov y añade Access-Control-Allow-Origin
// para que el navegador acepte la respuesta.
//
// Ruta: /api/awc/<endpoint>?<params>
//   →   https://aviationweather.gov/api/data/<endpoint>?<params>
//
// Ejemplo: /api/awc/metar?ids=LEMD,LEBL&format=json

const UPSTREAM = 'https://aviationweather.gov/api/data';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, params } = context;
  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const path = segments.join('/');
  const url = new URL(request.url);
  const target = `${UPSTREAM}/${path}${url.search}`;

  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      headers: { 'User-Agent': 'TSAgestor-CFProxy/1.0 (+https://tsagestor.pages.dev)' },
      // Cache de Cloudflare: METAR/TAF se actualizan cada ~30 min, cachear 5 min.
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: String(e) }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const headers = new Headers(CORS_HEADERS);
  const ct = upstream.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=300');

  return new Response(upstream.body, { status: upstream.status, headers });
}
