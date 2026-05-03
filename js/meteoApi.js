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

    // Intento 1: ruta completa con todos los waypoints reconocidos.
    let url = getGrametUrl(plan, format, false);
    if (!url) throw new Error('Plan inválido');

    let res = await _arFetch(url, reqInit);

    // Si falla con 4xx/5xx (probable: waypoint AIP no reconocido por
    // Autorouter o ruta demasiado larga), reintentamos con solo origen+destino.
    if (!res.ok && res.status !== 401) {
      const minimalUrl = getGrametUrl(plan, format, true);
      if (minimalUrl && minimalUrl !== url) {
        console.warn('[gramet] Reintentando con solo ' + plan.origin + '->' + plan.destination + ' (HTTP ' + res.status + ')');
        url = minimalUrl;
        res = await _arFetch(minimalUrl, reqInit);
      }
    }
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
    return await res.blob();
  }

  function getGrametUrl(plan, format, minimal) {
    if (!plan || !plan.coords || plan.coords.length < 2) return null;
    format = format || 'png';
    let waypoints;
    if (minimal) {
      waypoints = `${plan.origin} ${plan.destination}`;
    } else {
      // Sólo waypoints con código tipo ICAO/navaid; si no quedan ≥2 caemos a
      // origen + destino (que ya están validados por el grafo).
      const valid = plan.coords
        .map(c => c.name)
        .filter(n => /^[A-Z][A-Z0-9]{1,4}$/.test(n));
      waypoints = valid.length >= 2 ? valid.join(' ') : `${plan.origin} ${plan.destination}`;
    }
    const departuretime = Math.floor(plan.departureUTC.getTime() / 1000);
    const totaleet = Math.round((plan.timeMinutes || 0) * 60);
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
