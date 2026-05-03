// Cloudflare Pages Function — proxy de api.autorouter.aero.
//
// Reenvía OAuth (POST /oauth2/token) y GRAMET (GET /met/gramet) hacia
// Autorouter, propagando método, body y cabecera Authorization. Devuelve
// la respuesta tal cual (PNG, PDF o JSON) con cabeceras CORS.
//
// Ruta: /api/autorouter/<endpoint>?<params>
//   →   https://api.autorouter.aero/v1.0/<endpoint>?<params>

const UPSTREAM = 'https://api.autorouter.aero/v1.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Disposition',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const { request, params } = context;
  const method = request.method;
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (method !== 'GET' && method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }

  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const path = segments.join('/');
  const url = new URL(request.url);
  const target = `${UPSTREAM}/${path}${url.search}`;

  const headers = {
    'User-Agent': 'TSAgestor-CFProxy/1.0 (+https://tsagestor.pages.dev)',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  const ct = request.headers.get('Content-Type');
  if (ct) headers['Content-Type'] = ct;

  const init = { method, headers };
  if (method === 'POST') init.body = await request.text();

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: String(e) }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const respHeaders = new Headers(CORS_HEADERS);
  const upCT = upstream.headers.get('Content-Type');
  if (upCT) respHeaders.set('Content-Type', upCT);
  const cd = upstream.headers.get('Content-Disposition');
  if (cd) respHeaders.set('Content-Disposition', cd);

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
