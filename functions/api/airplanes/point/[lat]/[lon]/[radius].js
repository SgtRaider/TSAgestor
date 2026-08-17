// Cloudflare Pages Function — proxy del endpoint /point de la API publica
// de airplanes.live. api.airplanes.live NO envia Access-Control-Allow-Origin
// para el dominio *.pages.dev, asi que el navegador bloquea el fetch directo.
// Pasamos por aqui server-side y devolvemos con CORS abierto.
//
// Ruta: /api/airplanes/point/<lat>/<lon>/<radiusNM>
//   -> https://api.airplanes.live/v2/point/<lat>/<lon>/<radiusNM>

const UPSTREAM = 'https://api.airplanes.live/v2/point';

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

    const lat = params && params.lat;
    const lon = params && params.lon;
    const radius = params && params.radius;

    if (!/^-?\d+(?:\.\d+)?$/.test(String(lat)) ||
        !/^-?\d+(?:\.\d+)?$/.test(String(lon)) ||
        !/^\d+$/.test(String(radius))) {
      return new Response(JSON.stringify({ error: 'Invalid params', lat, lon, radius }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);
    const rN = parseInt(radius, 10);
    if (latN < -90 || latN > 90 || lonN < -180 || lonN > 180 || rN <= 0 || rN > 250) {
      return new Response(JSON.stringify({ error: 'Params out of range' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const target = `${UPSTREAM}/${lat}/${lon}/${radius}`;

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          'User-Agent': 'TSAgestor-CFProxy/1.0 (+https://tsagestor.pages.dev)',
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
    respHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Function crashed', detail: String(err && err.stack || err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
