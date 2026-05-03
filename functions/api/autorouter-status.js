// Endpoint de probe: indica al frontend si el server-side tiene credenciales
// de Autorouter configuradas (env vars AUTOROUTER_USER / AUTOROUTER_PASS).
// El frontend lo consulta al cargar para saber si puede saltarse el modal de
// login y pedir GRAMET directamente.
//
// Nunca devuelve los valores - solo un booleano.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const env = context.env || {};
  const configured = !!(env.AUTOROUTER_USER && env.AUTOROUTER_PASS);
  return new Response(JSON.stringify({ configured }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
