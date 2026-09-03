// Cloudflare Pages Function — proxy del endpoint de traza historica de
// tar1090 (globe.airplanes.live). El navegador NO puede pedirlo
// directamente porque el servidor no manda Access-Control-Allow-Origin
// consistentemente (Cloudflare lo bloquea en ciertas condiciones), asi
// que pasamos por aqui server-side y devolvemos con CORS abierto.
//
// Ruta: /api/airplanes/trace/<hex>
//   -> https://globe.airplanes.live/data/traces/<lastTwoOfHex>/trace_recent_<hex>.json

const UPSTREAM = 'https://globe.airplanes.live/data/traces';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  try {
    const { request, params } = context;
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }
    const hexRaw = (params && params.hex) ? String(params.hex) : '';
    const hex = hexRaw.toLowerCase().replace(/[^0-9a-f~]/g, '');
    if (!/^~?[0-9a-f]{6}$/.test(hex)) {
      return new Response(JSON.stringify({ error: 'Invalid hex', got: hexRaw }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const last2 = hex.slice(-2);
    const target = `${UPSTREAM}/${last2}/trace_recent_${hex}.json`;

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          // tar1090 puede mirar UA y Referer para bloquear bots.
          'User-Agent': 'TSAgestor-CFProxy/1.0 (+https://tsagestor.pages.dev)',
          'Referer':    'https://globe.airplanes.live/',
          'Accept':     'application/json',
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: String(e) }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const respHeaders = new Headers(CORS_HEADERS);
    const upCT = upstream.headers.get('Content-Type');
    if (upCT) respHeaders.set('Content-Type', upCT);
    // No cachear: la traza cambia rapido.
    respHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Function crashed', detail: String(err && err.stack || err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
