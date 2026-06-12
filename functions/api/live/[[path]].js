// Cloudflare Pages Function — proxy de /api/live/* hacia notamhub.duckdns.org.
//
// Workflow corp-proxy-livesync-diagnose (5 lentes paralelos + 3 votos
// adversarial). Causa raiz: en PCs corporativos NotamHub funcionaba via
// Pages Function same-origin (*.pages.dev whitelisted) pero LiveSync
// iba DIRECTO cross-origin a duckdns.org (NO whitelisted) -> firewall
// corporativo cerraba TCP con ERR_CONNECTION_CLOSED.
//
// Fix: este proxy paralelo al de NotamHub tunela /api/live/* desde el
// edge de Cloudflare. Asi el cliente solo ve trafico a *.pages.dev y
// el firewall corporativo lo deja pasar.
//
// Diferencias vs el proxy de NotamHub:
//   - Soporta TODOS los metodos (GET, POST, PUT, DELETE) — LiveSync usa
//     PUT para session upsert y DELETE para deleteRemote.
//   - Reenvia Authorization: Bearer <token> (LiveSync auth scheme).
//   - No inyecta token desde env var — el cliente envia el suyo y este
//     proxy es transparente (a diferencia de NotamHub donde el token
//     es de unidad compartido).
//
// Ruta: /api/live/<endpoint>?<params>
//   →   https://notamhub.duckdns.org/api/live/<endpoint>?<params>

const UPSTREAM = 'https://notamhub.duckdns.org';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-request-id, x-user-token',
  'Access-Control-Max-Age':       '600',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  try {
    const { request, params } = context;
    const method = request.method;
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
    const path = segments.join('/');
    const url = new URL(request.url);
    // Upstream expects /api/live/<path> (NotamHub backend uses that exact
    // prefix). El segments[] vendra de Cloudflare ya sin /api/live, asi
    // que lo restituimos aqui.
    const target = `${UPSTREAM}/api/live/${path}${url.search}`;

    // Headers de proxy: reenvia Authorization tal cual (token de unidad
    // gestionado por el cliente). Content-Type para body JSON.
    const headers = {
      'User-Agent': 'TSAgestor-LiveSync-Proxy/1.0 (+https://tsagestor.pages.dev)',
      'Accept': 'application/json',
    };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;
    const ct = request.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;
    const reqId = request.headers.get('x-request-id');
    if (reqId) headers['x-request-id'] = reqId;

    const init = { method, headers };
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      // DELETE puede no llevar body (RFC 9110 lo permite vacio); leemos
      // bytes para no perder lo que el cliente envia.
      const bodyText = await request.text();
      if (bodyText) init.body = bodyText;
    }

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
    // Reenvia tambien rate-limit / cacheability si vienen.
    ['x-ratelimit-remaining', 'x-request-id', 'retry-after'].forEach(h => {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    });

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Function crashed', detail: String(err && err.stack || err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
