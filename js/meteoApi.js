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

  const AWC_BASE = 'https://aviationweather.gov/api/data';
  const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';

  // NASA GIBS — Cloud Top Height (mosaico global, CORS abierto, no requiere
  // key). El producto MODIS Cloud Top Pressure de Aqua/Terra es la mejor
  // aproximación pública a "altura de tope de nube". El portal EUMETView
  // expone el CTH MSG 0° pero sólo a usuarios autenticados con OAuth, no
  // admite token en query — por eso usamos GIBS.
  const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
  const GIBS_LAYER = 'MODIS_Aqua_Cloud_Top_Pressure_Day';
  const GIBS_LAYER_TITLE = 'Cloud Top Height (NASA GIBS · MODIS Aqua)';
  // Imagen estática con la escala. Si el layer no tuviera leyenda, omite.
  const GIBS_LEGEND = 'https://gibs.earthdata.nasa.gov/legend/MODIS_Aqua_Cloud_Top_Pressure_Day_H.svg';

  // Proxy CORS para APIs que no devuelven Access-Control-Allow-Origin (AWC).
  // corsproxy.io es gratuito; si va lento o cae cambia a allorigins.
  const CORS_PROXY = 'https://corsproxy.io/?';

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

  // NASA GIBS WMS — devuelve { url, options, title, legendUrl } para
  // L.tileLayer.wms.
  function getGibsCloudWMS() {
    return {
      url: GIBS_WMS,
      title: GIBS_LAYER_TITLE,
      legendUrl: GIBS_LEGEND,
      options: {
        layers: GIBS_LAYER,
        format: 'image/png',
        transparent: true,
        version: '1.1.1',
        attribution: '© NASA EOSDIS GIBS',
      },
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
  const AR_OAUTH = 'https://api.autorouter.aero/v1.0/oauth2/token';
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
    const c = getStoredArCreds();
    return !!(c && c.email && c.password);
  }

  // Fetch + fallback proxy CORS (igual que safeFetch pero soporta options).
  async function _arFetch(url, options) {
    options = options || {};
    if (isFileProtocol()) {
      throw new Error('Las APIs externas no funcionan abriendo el HTML con file://. Sirve por HTTP (start.bat).');
    }
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      throw new Error('HTTP ' + res.status);
    } catch (e) {
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
    const url = getGrametUrl(plan, format);
    if (!url) throw new Error('Plan inválido');
    const token = await getArToken();
    const res = await _arFetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.status === 401) {
      sessionStorage.removeItem(AR_TOKEN_KEY);
      throw new Error('TOKEN_REJECTED');
    }
    if (!res.ok) throw new Error('GRAMET HTTP ' + res.status);
    return await res.blob();
  }

  function getGrametUrl(plan, format) {
    if (!plan || !plan.coords || plan.coords.length < 2) return null;
    format = format || 'png';
    // Sólo waypoints con código tipo ICAO/navaid; si no quedan ≥2 caemos a
    // origen + destino (que ya están validados por el grafo).
    const valid = plan.coords
      .map(c => c.name)
      .filter(n => /^[A-Z][A-Z0-9]{1,4}$/.test(n));
    const waypoints = valid.length >= 2 ? valid.join(' ') : `${plan.origin} ${plan.destination}`;
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
    return 'https://api.autorouter.aero/v1.0/met/gramet?' + params.toString();
  }

  return {
    fetchMETAR, fetchTAF, fetchWeatherForAirports,
    getRainviewerCloudUrl, getGibsCloudWMS,
    fetchCloudsForPoints, getGrametUrl, fetchGramet,
    hasArCreds, setStoredArCreds, clearStoredArAuth,
  };
})();
