// Cloudflare Pages Function — proxy de notamhub.duckdns.org.
//
// API ICARO NOTAM/TSA: TSAs activas, NOTAMs por aerodromo / FIR, boletines.
// Doc: https://notamhub.duckdns.org/docs
//
// Inyecta el x-user-token desde env var NOTAMHUB_USER_TOKEN si esta
// configurada en Cloudflare Pages, o desde DEFAULT_TOKEN si no.
//
// Ruta: /api/notamhub/<endpoint>?<params>
//   →   https://notamhub.duckdns.org/<endpoint>?<params>

const UPSTREAM = 'https://notamhub.duckdns.org';

// Token compartido del usuario (scope user). Si NOTAMHUB_USER_TOKEN esta
// en env vars de CF Pages, prevalece.
const DEFAULT_TOKEN = 'FPIy1bgWG5gGRviMKSxeLInxZvjD1KYhILgof0WVgfg';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-user-token, x-admin-token',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  try {
    const { request, params, env } = context;
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

    // Token: cliente -> env var -> default. El cliente puede pasar el suyo
    // propio via x-user-token; si no lo hace, usamos el del server.
    const clientToken = request.headers.get('x-user-token');
    const serverToken = (env && env.NOTAMHUB_USER_TOKEN) || DEFAULT_TOKEN;
    const token = clientToken || serverToken;

    const headers = {
      'User-Agent': 'TSAgestor-CFProxy/1.0 (+https://tsagestor.pages.dev)',
      'Accept': 'application/json',
    };
    if (token) headers['x-user-token'] = token;

    const init = { method, headers };
    if (method === 'POST') {
      const ct = request.headers.get('Content-Type');
      if (ct) headers['Content-Type'] = ct;
      init.body = await request.text();
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

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Function crashed', detail: String(err && err.stack || err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
