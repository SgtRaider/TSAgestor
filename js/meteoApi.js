// Cliente de APIs meteorológicas:
//   • NOAA Aviation Weather Center (AWC) — METAR / TAF, sin key.
//     https://aviationweather.gov/data/api/
//   • RainViewer — capa de satélite IR (nubes), sin key.
//   • EUMETView WMS — RGB natural color de Meteosat, requiere token.
//
// Las peticiones cruzan CORS (las tres APIs lo permiten desde navegadores
// modernos abriendo el index.html con file://).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.meteoApi = (function () {
  'use strict';

  const MODULE_BUILD = 'meteoApi v9 (gramet: full salta si no hay >=2 ICAO reales)';
  console.info('[TSAgestor]', MODULE_BUILD);

  // Detección de entorno: en deploy HTTPS no-local asumimos que tenemos
  // disponibles las Cloudflare Pages Functions /api/awc/* y
  // /api/autorouter/* como proxies del MISMO ORIGEN (sin CORS). En local
  // (file:// o localhost/127.0.0.1) llamamos directo y caemos a un proxy
  // CORS público si el navegador bloquea.
  const ON_REMOTE = typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    !/^(localhost|127\.|192\.168\.|10\.)/i.test(location.hostname);

  const AWC_BASE = ON_REMOTE
    ? '/api/awc'
    : 'https://aviationweather.gov/api/data';
  const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';

  // EUMETVIEW — Cloud Top Height MSG 0 degree (MeteoSat). Cobertura
  // Europa/África/Atlántico cada 15 min. Requiere access_token en query.
  // Doc: https://data.eumetsat.int/product/EO:EUM:DAT:MSG:CTH
  // Capabilities verificadas: layer "cth", time dimension hasta el último
  // mosaico publicado (default = más reciente).
  const EUMET_WMS = 'https://view.eumetsat.int/geoserver/msg_fes/cth/ows';
  const EUMET_TOKEN = '5fa55ec9-2aa7-38f9-861b-660bd9845672';
  const EUMET_LAYER = 'cth';
  const EUMET_TITLE = 'Cloud Top Height (MSG 0° · EUMETSAT)';

  // Proxy CORS público, sólo se usa en local cuando el navegador bloquea
  // (en producción usamos las Cloudflare Pages Functions del mismo origen,
  // ver AWC_BASE / AR_BASE arriba). corsproxy.io ha empezado a devolver 403
  // desde dominios *.pages.dev, allorigins.win es alternativa estable.
  const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

  // ── Helpers de fetch ────────────────────────────────────────────────

  function isFileProtocol() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  // Envuelve fetch con dos comportamientos:
  //  • Si el sitio está abierto con file://, falla rápido con mensaje claro.
  //  • Si el fetch directo falla (CORS / red), reintenta vía proxy CORS público.
  async function safeFetch(url, label) {
    if (isFileProtocol()) {
      throw new Error(
        'Las APIs externas (' + label + ') no funcionan abriendo el HTML directamente (file://). ' +
        'Ejecuta start.bat o "python serve.py" y abre http://127.0.0.1:8000/index.html.'
      );
    }
    // Intento directo
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      // Algunos endpoints devuelven 403/blocked sin cabeceras CORS — caemos al proxy.
      if (res.status === 403 || res.status === 0) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      // TypeError "Failed to fetch" → casi siempre CORS bloqueado. Reintenta vía proxy.
      console.warn('[meteo] Fetch directo falló para', label, '— reintentando vía CORS proxy.');
      try {
        const proxied = CORS_PROXY + encodeURIComponent(url);
        const res2 = await fetch(proxied);
        if (!res2.ok) throw new Error('HTTP ' + res2.status);
        return res2;
      } catch (e2) {
        throw new Error(
          `${label}: bloqueado por CORS y el proxy también falló (${e2.message || e2}). ` +
          `Revisa la conexión o desactiva extensiones que bloqueen tráfico.`
        );
      }
    }
  }

  // ── METAR / TAF ─────────────────────────────────────────────────────

  async function fetchMETAR(icaoList) {
    if (!icaoList || !icaoList.length) return {};
    const ids = icaoList.join(',');
    // AWC acepta la coma sin codificar y devuelve el último METAR por defecto.
    const url = `${AWC_BASE}/metar?ids=${ids}&format=json`;
    const res = await safeFetch(url, 'METAR (AWC)');
    if (!res.ok) throw new Error(`METAR HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    for (const m of data) {
      if (out[m.icaoId]) continue;          // sólo el más reciente
      out[m.icaoId] = {
        raw: m.rawOb,
        category: m.fltCat || null,
        obsTime: m.obsTime || null,
        temp: m.temp,
        dewp: m.dewp,
        wdir: m.wdir,
        wspd: m.wspd,
        wgst: m.wgst,
        visib: m.visib,
        altim: m.altim,
        wxString: m.wxString,
        clouds: m.clouds || [],
        name: m.name || null,
        lat: m.lat,
        lon: m.lon,
      };
    }
    return out;
  }

  async function fetchTAF(icaoList) {
    if (!icaoList || !icaoList.length) return {};
    const ids = icaoList.join(',');
    const url = `${AWC_BASE}/taf?ids=${ids}&format=json`;
    const res = await safeFetch(url, 'TAF (AWC)');
    if (!res.ok) throw new Error(`TAF HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    for (const t of data) {
      if (out[t.icaoId]) continue;
      out[t.icaoId] = {
        raw: t.rawTAF,
        issueTime: t.issueTime || null,
        validFrom: t.validTimeFrom,
        validTo: t.validTimeTo,
      };
    }
    return out;
  }

  async function fetchWeatherForAirports(icaoList) {
    if (!icaoList || !icaoList.length) {
      return { airports: {}, errors: {} };
    }
    const errors = {};
    const [metars, tafs] = await Promise.all([
      fetchMETAR(icaoList).catch(e => { errors.metar = e.message; return {}; }),
      fetchTAF(icaoList).catch(e => { errors.taf = e.message; return {}; }),
    ]);
    const airports = {};
    for (const icao of icaoList) {
      airports[icao] = {
        metar: metars[icao] || null,
        taf:   tafs[icao]   || null,
      };
    }
    return { airports, errors };
  }

  // ── Capa de nubosidad ───────────────────────────────────────────────

  // RainViewer: el endpoint devuelve los timestamps disponibles. Intenta
  // primero satélite IR (nubes); si no hay, cae a radar (precipitación).
  // Devuelve { url, kind } donde kind = 'satellite' | 'radar'.
  let _rvCache = null;
  let _rvCacheTime = 0;
  async function getRainviewerCloudUrl() {
    const now = Date.now();
    if (_rvCache && now - _rvCacheTime < 5 * 60 * 1000) return _rvCache;
    const res = await safeFetch(RAINVIEWER_INDEX, 'RainViewer');
    if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
    const data = await res.json();

    const sat = (data.satellite && data.satellite.infrared) || [];
    if (sat.length) {
      const latest = sat[sat.length - 1];
      _rvCache = {
        url: `${data.host}${latest.path}/512/{z}/{x}/{y}/0/0_0.png`,
        kind: 'satellite',
      };
      _rvCacheTime = now;
      return _rvCache;
    }

    // Fallback: radar (precipitación) — el más reciente entre past y nowcast.
    const past = (data.radar && data.radar.past) || [];
    const now2 = (data.radar && data.radar.nowcast) || [];
    const allRadar = past.concat(now2);
    if (allRadar.length) {
      const latest = allRadar[allRadar.length - 1];
      _rvCache = {
        url: `${data.host}${latest.path}/512/{z}/{x}/{y}/2/1_1.png`,
        kind: 'radar',
      };
      _rvCacheTime = now;
      return _rvCache;
    }

    throw new Error('RainViewer no devolvió ni satélite ni radar.');
  }

  // EUMETVIEW MSG CTH WMS — devuelve { url, options, title, legendUrl }
  // para L.tileLayer.wms. La capa tiene una time dimension cuyo "default"
  // es el último mosaico publicado, así que NO pasamos TIME y dejamos que
  // GeoServer sirva la imagen más reciente automáticamente.
  function getEumetCthWMS() {
    const legendUrl = `${EUMET_WMS}?service=WMS&version=1.3.0` +
      `&request=GetLegendGraphic&format=image/png&width=640&height=80` +
      `&layer=${EUMET_LAYER}&access_token=${EUMET_TOKEN}`;
    return {
      url: EUMET_WMS,
      title: EUMET_TITLE,
      legendUrl,
      options: {
        layers: EUMET_LAYER,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        attribution: '© EUMETSAT · MSG CTH',
        access_token: EUMET_TOKEN,
      },
    };
  }

  // Niveles ISA estándar disponibles en Open-Meteo (subset usado).
  // ft = altitud aproximada en atmósfera estándar.
  const ISA_LEVELS = [
    { hPa: 1000, ft:   364 },
    { hPa:  925, ft:  2553 },
    { hPa:  850, ft:  4781 },
    { hPa:  700, ft:  9882 },
    { hPa:  600, ft: 13801 },
    { hPa:  500, ft: 18289 },
    { hPa:  400, ft: 23574 },
    { hPa:  300, ft: 30065 },
    { hPa:  250, ft: 33999 },
    { hPa:  200, ft: 38662 },
    { hPa:  150, ft: 44647 },
    { hPa:  100, ft: 53083 },
  ];

  function closestPressureLevel(fl) {
    const ft = (fl || 0) * 100;
    return ISA_LEVELS.reduce((best, l) =>
      Math.abs(l.ft - ft) < Math.abs(best.ft - ft) ? l : best, ISA_LEVELS[0]);
  }

  // Vientos en altura para cada punto al nivel ISA más cercano al FL pedido.
  // Devuelve siempre los pronósticos HORARIOS completos por punto
  // (past_days=2 + forecast_days=7) para que el caller pueda interpolar
  // según la ETA de cada waypoint.
  //   { level: {hPa, ft}, source: 'forecast',
  //     pointsHourly: [{ times: [iso...], windSpeedKt: [...], windDir: [...] }, ...] }
  async function fetchWindsAloft(points, fl) {
    if (!points || !points.length) return { level: null, pointsHourly: [] };
    const level = closestPressureLevel(fl);
    const lats = points.map(p => p.lat.toFixed(4)).join(',');
    const lons = points.map(p => p.lon.toFixed(4)).join(',');
    const vars = `wind_speed_${level.hPa}hPa,wind_direction_${level.hPa}hPa`;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
                `&hourly=${vars}&windspeed_unit=kn&past_days=2&forecast_days=7&timezone=UTC`;
    const res = await safeFetch(url, 'Open-Meteo (vientos pronóstico)');
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];

    return {
      level,
      source: 'forecast',
      pointsHourly: arr.map(d => {
        const times = (d.hourly && d.hourly.time) || [];
        const ws    = (d.hourly && d.hourly[`wind_speed_${level.hPa}hPa`]) || [];
        const wd    = (d.hourly && d.hourly[`wind_direction_${level.hPa}hPa`]) || [];
        return { times, windSpeedKt: ws, windDir: wd };
      }),
    };
  }

  // Devuelve {windSpeedKt, windDir, atTime} del pronóstico horario más cercano
  // al timestamp atMs (en ms epoch). Útil para que un caller mire vientos por
  // ETA distinta en cada waypoint.
  function lookupWindAt(pointHourly, atMs) {
    if (!pointHourly || !pointHourly.times || !pointHourly.times.length) return null;
    let bestIdx = 0, bestDiff = Infinity;
    for (let i = 0; i < pointHourly.times.length; i++) {
      const t = new Date(pointHourly.times[i] + 'Z').getTime();
      const diff = Math.abs(t - atMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return {
      windSpeedKt: pointHourly.windSpeedKt[bestIdx],
      windDir:     pointHourly.windDir[bestIdx],
      atTime:      pointHourly.times[bestIdx] + 'Z',
    };
  }

  // Open-Meteo (gratuito, CORS abierto, sin key) — devuelve cloud cover
  // por bandas de altitud (low/mid/high) y total para cada punto solicitado.
  // Se acepta un array de {lat, lon}; los devuelve en el mismo orden.
  async function fetchCloudsForPoints(points) {
    if (!points || !points.length) return [];
    const lats = points.map(p => p.lat.toFixed(4)).join(',');
    const lons = points.map(p => p.lon.toFixed(4)).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
                `&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high`;
    const res = await safeFetch(url, 'Open-Meteo (nubes)');
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];
    return arr.map(d => ({
      time: d.current && d.current.time,
      cover:     d.current && d.current.cloud_cover,
      coverLow:  d.current && d.current.cloud_cover_low,
      coverMid:  d.current && d.current.cloud_cover_mid,
      coverHigh: d.current && d.current.cloud_cover_high,
    }));
  }

  // GRAMET (Autorouter.aero) — corte vertical meteorológico de la ruta.
  // REQUIERE OAuth 2.0 client_credentials con email + password de cuenta
  // autorouter.aero (que además debe tener acceso API habilitado por
  // ticket de soporte). Doc: https://www.autorouter.aero/wiki/api/
  const AR_BASE = ON_REMOTE
    ? '/api/autorouter'
    : 'https://api.autorouter.aero/v1.0';
  const AR_OAUTH = `${AR_BASE}/oauth2/token`;
  const AR_TOKEN_KEY = 'tsagestor_ar_token';
  const AR_CREDS_KEY = 'tsagestor_ar_creds';

  function getStoredArCreds() {
    try { return JSON.parse(sessionStorage.getItem(AR_CREDS_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function setStoredArCreds(email, password) {
    sessionStorage.setItem(AR_CREDS_KEY, JSON.stringify({ email, password }));
  }
  function clearStoredArAuth() {
    sessionStorage.removeItem(AR_CREDS_KEY);
    sessionStorage.removeItem(AR_TOKEN_KEY);
  }
  function hasArCreds() {
    if (_serverAuthConfigured === true) return true;
    const c = getStoredArCreds();
    return !!(c && c.email && c.password);
  }

  // Modo server-auth: si la Pages Function /api/autorouter/* tiene
  // AUTOROUTER_USER/PASS en env vars, el frontend puede llamar a la API
  // sin Authorization y la function inyecta el Bearer. Comprobamos via
  // /api/autorouter-status. null = aun no comprobado, true/false = sabido.
  let _serverAuthConfigured = null;

  async function checkServerAuth() {
    if (!ON_REMOTE) { _serverAuthConfigured = false; return false; }
    if (_serverAuthConfigured !== null) return _serverAuthConfigured;
    try {
      const r = await fetch('/api/autorouter-status');
      if (r.ok) {
        const d = await r.json();
        _serverAuthConfigured = !!d.configured;
      } else {
        _serverAuthConfigured = false;
      }
    } catch (_) {
      _serverAuthConfigured = false;
    }
    return _serverAuthConfigured;
  }

  // Fetch + fallback proxy CORS (igual que safeFetch pero soporta options).
  // Si la URL es relativa (/api/...), NO usamos fallback: ya estamos en
  // el mismo origen via Cloudflare Pages Function, no hay problema CORS
  // y allorigins no sabe resolver relativas.
  async function _arFetch(url, options) {
    options = options || {};
    if (isFileProtocol()) {
      throw new Error('Las APIs externas no funcionan abriendo el HTML con file://. Sirve por HTTP (start.bat).');
    }
    const isSameOrigin = url.startsWith('/');
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      if (isSameOrigin) return res;          // 5xx mismo origen: devuelve tal cual
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (isSameOrigin) throw e;             // sin fallback CORS para mismo origen
      console.warn('[autorouter] Fetch directo falló — reintentando vía CORS proxy.');
      const proxied = CORS_PROXY + encodeURIComponent(url);
      return await fetch(proxied, options);
    }
  }

  async function getArToken() {
    // Token cacheado válido?
    try {
      const cached = JSON.parse(sessionStorage.getItem(AR_TOKEN_KEY) || 'null');
      if (cached && cached.exp > Date.now() + 30000) return cached.token;
    } catch (_) {}
    const creds = getStoredArCreds();
    if (!creds || !creds.email || !creds.password) {
      throw new Error('NO_CREDS');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.email,
      client_secret: creds.password,
    }).toString();
    const res = await _arFetch(AR_OAUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 400) throw new Error('BAD_CREDS');
      throw new Error('Login Autorouter: HTTP ' + res.status);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error('Respuesta inesperada de Autorouter');
    const exp = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    sessionStorage.setItem(AR_TOKEN_KEY, JSON.stringify({ token: data.access_token, exp }));
    return data.access_token;
  }

  async function fetchGramet(plan, format) {
    // Si el server-side tiene AUTOROUTER_USER/PASS en env vars, llamamos
    // sin Authorization y la Pages Function inyecta el token.
    const serverAuth = await checkServerAuth();
    const reqInit = {};
    if (!serverAuth) {
      const token = await getArToken();
      reqInit.headers = { 'Authorization': 'Bearer ' + token };
    }

    // Escalado en 3 estrategias hasta obtener algo:
    //   1) full   - ruta tal cual (puede fallar si Autorouter no conoce
    //               algun fix RNAV nuevo del AIP).
    //   2) nearby - sustituye fixes no reconocidos por aeropuerto/navaid
    //               mas cercano (radio 80 NM) -> meteo aproximada en cada
    //               punto de la ruta original.
    //   3) minimal - origen + destino, gran circulo (ultimo recurso).
    const strategies = ['full', 'nearby', 'minimal'];
    let url = null, res = null, usedStrategy = null, usedWaypoints = null;
    for (let i = 0; i < strategies.length; i++) {
      const strat = strategies[i];
      const tryWaypoints = buildWaypointsString(plan, strat);
      const tryUrl = getGrametUrl(plan, format, strat);
      if (!tryUrl) continue;
      // No repetir si la URL es identica a la anterior (ej. plan tan corto
      // que full y nearby producen lo mismo).
      if (url && tryUrl === url) continue;
      url = tryUrl;
      usedStrategy = strat;
      usedWaypoints = tryWaypoints;
      res = await _arFetch(url, reqInit);
      if (res.ok || res.status === 401) break;
      if (i + 1 < strategies.length) {
        console.warn('[gramet] Estrategia "' + strat + '" fallo (HTTP ' + res.status + '). Reintentando con "' + strategies[i + 1] + '"...');
      }
    }
    if (!url || !res) throw new Error('Plan inválido');
    if (res.status === 401) {
      if (!serverAuth) sessionStorage.removeItem(AR_TOKEN_KEY);
      // Intentamos leer el JSON con el reason que devuelve la Function.
      let reason = null;
      try {
        const data = await res.clone().json();
        reason = data && data.reason;
      } catch (_) {}
      if (reason === 'no_credentials' || reason === 'server_auth_failed') {
        const e = new Error('SERVER_NO_CREDS');
        e.detail = reason;
        throw e;
      }
      throw new Error('TOKEN_REJECTED');
    }
    if (!res.ok) {
      // Cuerpo JSON con mensaje (p.ej. de la Function) -> mejor diagnóstico.
      let detail = '';
      try {
        const data = await res.clone().json();
        detail = data && (data.error || data.detail) ? (' — ' + (data.error || data.detail)) : '';
      } catch (_) {}
      // Si no era JSON, intentamos texto (p.ej. error en HTML/plain del upstream).
      if (!detail) {
        try {
          const txt = (await res.clone().text()).trim();
          if (txt) detail = ' — ' + txt.slice(0, 300);
        } catch (_) {}
      }
      // Loguear la URL completa para poder reproducir el problema fuera del navegador.
      console.error('[gramet] HTTP', res.status, 'URL:', url, 'detail:', detail);
      throw new Error('GRAMET HTTP ' + res.status + detail);
    }
    const blob = await res.blob();
    return {
      blob,
      strategy: usedStrategy,
      waypoints: usedWaypoints ? usedWaypoints.split(/\s+/) : [],
    };
  }

  // Estrategias de construccion de la cadena de waypoints para GRAMET:
  //   'full'    -> ruta completa filtrando solo nombres tipo ICAO/navaid.
  //   'nearby'  -> sustituye cada fix RNAV no reconocido por el aeropuerto
  //                o navaid mas cercano (radio 80 NM) para que Autorouter
  //                pueda muestrear meteo cerca de la linea real.
  //   'minimal' -> solo origen + destino (gran circulo).
  // Limites empiricos de Autorouter /met/gramet para evitar HTTP 500/504:
  //   - mas de ~15 waypoints o totaleet > ~6h hace que el upstream falle.
  //   - origen == destino con 0 NM intermedios (caso circuito) tambien.
  const MAX_GRAMET_WAYPOINTS = 20;
  const MAX_GRAMET_TOTALEET  = 6 * 3600;

  function getGrametUrl(plan, format, strategy) {
    if (!plan || !plan.coords || plan.coords.length < 2) return null;
    format = format || 'png';
    strategy = strategy || 'full';
    const waypoints = buildWaypointsString(plan, strategy);
    if (!waypoints) return null;
    const departuretime = Math.floor(plan.departureUTC.getTime() / 1000);
    const totalSec = Math.round((plan.timeMinutes || 0) * 60);
    // Capamos a 6h: el chart muestra los primeros tramos (lo mas relevante
    // para la planificacion meteo de salida); rutas mas largas haran que
    // Autorouter responda 500.
    const totaleet = totalSec > MAX_GRAMET_TOTALEET ? MAX_GRAMET_TOTALEET : totalSec;
    const altitude = (plan.flightLevel || 350) * 100;
    const params = new URLSearchParams({
      waypoints,
      departuretime: String(departuretime),
      totaleet: String(totaleet),
      altitude: String(altitude),
      format,
    });
    return `${AR_BASE}/met/gramet?` + params.toString();
  }

  // Decima un array conservando primer y ultimo elemento + muestreo
  // uniforme del interior, hasta un maximo de "max" entradas.
  function decimateList(arr, max) {
    if (arr.length <= max) return arr;
    if (max < 2) return arr.slice(0, max);
    const out = [arr[0]];
    const inner = arr.slice(1, -1);
    const need = max - 2;
    if (need > 0 && inner.length > 0) {
      for (let i = 0; i < need; i++) {
        const idx = Math.min(inner.length - 1, Math.floor((i + 0.5) * inner.length / need));
        out.push(inner[idx]);
      }
    }
    out.push(arr[arr.length - 1]);
    return out;
  }
  function dedupeConsecutive(arr) {
    const out = [];
    for (const w of arr) {
      if (out.length && out[out.length - 1] === w) continue;
      out.push(w);
    }
    return out;
  }

  // Para circuitos (origen == destino) el 'minimal' "LEBZ LEBZ" es
  // degenerado y Autorouter lo rechaza. Buscamos el waypoint del plan mas
  // alejado del origen y lo mapeamos al aeropuerto/NAVAID conocido mas
  // cercano (cualquier distancia, no solo <80 NM).
  function midpointForCircuit(plan) {
    const aw = window.TSAgestor && window.TSAgestor.airways;
    if (!aw || !aw.waypoints || !aw.waypointTypes) return null;
    const origin = aw.waypoints[plan.origin];
    if (!origin) return null;
    let farLat = origin[0], farLon = origin[1], farD = 0;
    for (const c of plan.coords) {
      const dla = (c.lat - origin[0]) * 60;
      const ml  = ((origin[0] + c.lat) / 2) * Math.PI / 180;
      const dlo = (c.lon - origin[1]) * 60 * Math.cos(ml);
      const d = Math.sqrt(dla * dla + dlo * dlo);
      if (d > farD) { farD = d; farLat = c.lat; farLon = c.lon; }
    }
    let best = null, bestD = Infinity;
    for (const [id, pt] of Object.entries(aw.waypoints)) {
      const type = aw.waypointTypes[id];
      if (type !== 'AIRPORT' && type !== 'NAVAID' && type !== 'RNAV') continue;
      if (id === plan.origin) continue; // evita devolver el propio origen
      const dla = (pt[0] - farLat) * 60;
      const ml  = ((pt[0] + farLat) / 2) * Math.PI / 180;
      const dlo = (pt[1] - farLon) * 60 * Math.cos(ml);
      const d = Math.sqrt(dla * dla + dlo * dlo);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  function buildWaypointsString(plan, strategy) {
    const isCircuit = plan.origin === plan.destination;
    let words;

    if (strategy === 'minimal') {
      // Para circuitos, inyectamos un midpoint para no enviar "LEBZ LEBZ"
      // (Autorouter responde 500). Para rutas A->B no hace falta.
      if (isCircuit) {
        const mid = midpointForCircuit(plan);
        if (mid && mid !== plan.origin) {
          return `${plan.origin} ${mid} ${plan.destination}`;
        }
      }
      return `${plan.origin} ${plan.destination}`;
    }

    if (strategy === 'nearby') {
      words = buildNearbyWaypoints(plan).split(/\s+/).filter(Boolean);
    } else {
      // 'full': mantener nombres del plan filtrados a patron tipo ICAO. Si
      // no hay suficientes intermedios validos (caso tipico: drawnVia con
      // nombres TSA o coords DCT), devolvemos null para que fetchGramet
      // pase directo a "nearby" — no nos interesa que "full" tenga exito
      // con solo origen+destino+midpoint y oculte el muestreo bueno.
      const valid = plan.coords
        .map(c => c.name)
        .filter(n => /^[A-Z][A-Z0-9]{1,4}$/.test(n));
      // Quita origen/destino del recuento para "intermedios reales".
      const intermediates = valid.filter(n => n !== plan.origin && n !== plan.destination);
      if (intermediates.length < 2) return null;
      words = valid;
    }
    words = dedupeConsecutive(words);
    words = decimateList(words, MAX_GRAMET_WAYPOINTS);
    words = dedupeConsecutive(words);

    if (words.length < 2) return null;
    return words.join(' ');
  }

  // Construye la ruta efectiva para GRAMET muestreando a lo largo de la
  // polilinea real del plan. Para cada aeropuerto/NAVAID conocido se mide
  // la distancia perpendicular MINIMA a cada segmento de la ruta; si es
  // <= threshold, entra como candidato anclado al along-track del
  // segmento donde mejor encaja.
  //
  // Threshold adaptativo: empezamos con 30 NM (preferencia del usuario),
  // pero si la ruta es offshore o pasa lejos de aerodromos costeros y no
  // hay suficientes candidatos, ampliamos a 60 NM y luego a 100 NM. Asi
  // rutas cortas terrestres mantienen precision y rutas largas siempre
  // tienen suficientes anclas para que GRAMET sea util.
  function buildNearbyWaypoints(plan) {
    const aw = window.TSAgestor && window.TSAgestor.airways;
    if (!aw || !aw.waypoints || !aw.waypointTypes) return `${plan.origin} ${plan.destination}`;
    if (!plan.coords || plan.coords.length < 2) return `${plan.origin} ${plan.destination}`;

    // Catalogo Autorouter: aeropuertos OACI, NAVAIDs y fixes RNAV. Los
    // RNAV de 5 letras (NAPES, CLANA, TUTIS, ...) son intersecciones
    // publicadas en el AIP que Eurocontrol EAD reconoce, asi que pueden
    // entrar en /met/gramet sin problema.
    const known = [];
    for (const [id, pt] of Object.entries(aw.waypoints)) {
      const type = aw.waypointTypes[id];
      if (type === 'AIRPORT' || type === 'NAVAID' || type === 'RNAV') {
        known.push({ id, lat: pt[0], lon: pt[1], type });
      }
    }
    if (!known.length) return `${plan.origin} ${plan.destination}`;

    function approxNM(la, lo, lb, bo) {
      const dla = (lb - la) * 60;
      const ml = ((la + lb) / 2) * Math.PI / 180;
      const dlo = (bo - lo) * 60 * Math.cos(ml);
      return Math.sqrt(dla * dla + dlo * dlo);
    }
    function projectOnSeg(P, A, B) {
      const ml = ((A[0] + B[0]) / 2) * Math.PI / 180;
      const cosml = Math.cos(ml);
      const dx = (B[1] - A[1]) * 60 * cosml;
      const dy = (B[0] - A[0]) * 60;
      const px = (P[1] - A[1]) * 60 * cosml;
      const py = (P[0] - A[0]) * 60;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = A[1] + (B[1] - A[1]) * t;
      const cy = A[0] + (B[0] - A[0]) * t;
      return { t, dist: approxNM(P[0], P[1], cy, cx) };
    }

    const path = plan.coords.map(c => [c.lat, c.lon]);
    const segLens = [];
    const cumNM = [0];
    for (let i = 0; i < path.length - 1; i++) {
      const len = approxNM(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
      segLens.push(len);
      cumNM.push(cumNM[i] + len);
    }

    // Pre-calculo: para cada known, MEJOR proyeccion sobre cada segmento
    // (distancia + along) — no depende del threshold, asi que lo cacheamos.
    const allHits = []; // {id, along, dist}
    for (const k of known) {
      for (let i = 0; i < path.length - 1; i++) {
        const proj = projectOnSeg([k.lat, k.lon], path[i], path[i + 1]);
        const along = cumNM[i] + proj.t * segLens[i];
        allHits.push({ id: k.id, along, dist: proj.dist });
      }
    }

    function buildList(thresholdNM) {
      const filtered = allHits.filter(h => h.dist <= thresholdNM);
      filtered.sort((a, b) => a.along - b.along);
      const out = [];
      for (const c of filtered) {
        if (out.length && out[out.length - 1].id === c.id) continue;
        out.push(c);
      }
      // ID unicos para el conteo de "candidatos reales".
      const uniqueIds = new Set(out.map(c => c.id));
      return { ordered: out, uniqueCount: uniqueIds.size };
    }

    // Adaptativo: 30 -> 60 -> 100 NM hasta tener al menos MIN_HITS unicos.
    const THRESHOLDS = [30, 60, 100];
    const MIN_HITS = 4;
    let chosen = null, usedNM = THRESHOLDS[0];
    for (const t of THRESHOLDS) {
      const r = buildList(t);
      chosen = r;
      usedNM = t;
      if (r.uniqueCount >= MIN_HITS) break;
    }
    if (usedNM > 30) {
      console.info('[gramet] Pocos aerodromos a <=30 NM; ampliado el corredor a', usedNM, 'NM (', chosen.uniqueCount, 'puntos unicos)');
    }

    let names = chosen.ordered.map(c => c.id);
    if (!names.length || names[0] !== plan.origin) names.unshift(plan.origin);
    if (names[names.length - 1] !== plan.destination) names.push(plan.destination);
    const result = [];
    for (const n of names) {
      if (result.length && result[result.length - 1] === n) continue;
      result.push(n);
    }
    return result.length >= 2 ? result.join(' ') : `${plan.origin} ${plan.destination}`;
  }

  return {
    fetchMETAR, fetchTAF, fetchWeatherForAirports,
    getRainviewerCloudUrl, getEumetCthWMS,
    fetchCloudsForPoints, fetchWindsAloft, lookupWindAt,
    getGrametUrl, fetchGramet,
    hasArCreds, setStoredArCreds, clearStoredArAuth, checkServerAuth,
    // alias retro-compatible para código que aún usa el nombre antiguo
    getGibsCloudWMS: getEumetCthWMS,
  };
})();
