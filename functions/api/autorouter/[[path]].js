// Cloudflare Pages Function — proxy de api.autorouter.aero.
//
// Reenvía OAuth (POST /oauth2/token) y GRAMET (GET /met/gramet) hacia
// Autorouter, propagando método, body y cabecera Authorization. Devuelve
// la respuesta tal cual (PNG, PDF o JSON) con cabeceras CORS.
//
// Si el cliente NO envía Authorization y existen las env vars
//   AUTOROUTER_USER  /  AUTOROUTER_PASS
// configuradas en el dashboard de Cloudflare Pages
//   (Project → Settings → Environment Variables, marcar "Encrypt"),
// la función obtiene un token OAuth server-side, lo cachea en memoria
// del isolate, y lo inyecta en la petición. Asi el frontend puede llamar
// a /api/autorouter/met/gramet sin pasar por el flujo de login.
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

// Cache de token a nivel de isolate (mejor esfuerzo; CF Workers pueden
// arrancar isolates nuevos sin estado, en cuyo caso simplemente pedimos
// otro token la primera vez).
let _cachedToken = null;
let _cachedTokenExp = 0;

async function getServerToken(env) {
  if (_cachedToken && Date.now() < _cachedTokenExp - 30_000) {
    return _cachedToken;
  }
  if (!env || !env.AUTOROUTER_USER || !env.AUTOROUTER_PASS) {
    return null;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id:  env.AUTOROUTER_USER,
    client_secret: env.AUTOROUTER_PASS,
  }).toString();
  let r;
  try {
    r = await fetch(`${UPSTREAM}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (_) {
    return null;
  }
  if (!r.ok) return null;
  let data;
  try { data = await r.json(); } catch (_) { return null; }
  if (!data || !data.access_token) return null;
  _cachedToken = data.access_token;
  _cachedTokenExp = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _cachedToken;
}

function endpointNeedsAuth(path) {
  // Todas las rutas excepto /oauth2/token requieren Bearer.
  return path && !path.startsWith('oauth2/');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
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

    const headers = {
      'User-Agent': 'TSAgestor-CFProxy/1.0 (+https://tsagestor.pages.dev)',
    };

    // Authorization: cliente -> server-side env -> ninguno.
    let auth = request.headers.get('Authorization');
    let serverAuthAttempted = false;
    let serverAuthFailed = false;
    if (!auth && endpointNeedsAuth(path)) {
      const hasServerCreds = !!(env && env.AUTOROUTER_USER && env.AUTOROUTER_PASS);
      if (hasServerCreds) {
        serverAuthAttempted = true;
        const token = await getServerToken(env);
        if (token) {
          auth = 'Bearer ' + token;
        } else {
          serverAuthFailed = true;
        }
      }
    }

    if (endpointNeedsAuth(path) && !auth) {
      const reason = serverAuthFailed
        ? 'server_auth_failed'
        : (serverAuthAttempted ? 'server_auth_unknown' : 'no_credentials');
      return jsonResponse(401, {
        error: 'Authorization required',
        reason,
        hint: 'Configure AUTOROUTER_USER / AUTOROUTER_PASS en Cloudflare Pages → Settings → Environment Variables.',
      });
    }

    if (auth) headers['Authorization'] = auth;
    const ct = request.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;

    const init = { method, headers };
    if (method === 'POST') init.body = await request.text();

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (e) {
      return jsonResponse(502, { error: 'Upstream fetch failed', detail: String(e) });
    }

    // Si upstream rechaza el token cacheado, lo invalidamos para que la
    // siguiente petición pida uno nuevo.
    if (upstream.status === 401 && auth && auth.startsWith('Bearer ')) {
      _cachedToken = null;
      _cachedTokenExp = 0;
    }

    const respHeaders = new Headers(CORS_HEADERS);
    const upCT = upstream.headers.get('Content-Type');
    if (upCT) respHeaders.set('Content-Type', upCT);
    const cd = upstream.headers.get('Content-Disposition');
    if (cd) respHeaders.set('Content-Disposition', cd);

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Function crashed', detail: String(err && err.stack || err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
