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

  const MODULE_BUILD = 'meteoApi v16 (gramet usa cumTimeMin con holds + viento)';
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

  // EUMETVIEW — LI Accumulated Flash Area (MTG, 0°). Mosaico de actividad
  // electrica acumulada por el Lightning Imager. Refresco ~15 min.
  // Doc: https://data.eumetsat.int/product/EO:EUM:DAT:0687
  //
  // CTH usa el endpoint especifico /geoserver/msg_fes/cth/ows porque
  // EUMETSAT lo publica asi. Pero LI AFA y RGB Convection solo se sirven
  // desde el endpoint GLOBAL /geoserver/ows con el nombre de capa
  // prefijado por workspace (mtg_fd:li_afa, msg_fes:rgb_convection),
  // tal como aparece en los GetCapabilities oficiales que el usuario
  // adjunto. Las rutas /geoserver/<workspace>/<layer>/ows devuelven 404
  // para estos productos. Por eso ese 404 causaba el "tileerror" del SW.
  const EUMET_GLOBAL_WMS = 'https://view.eumetsat.int/geoserver/ows';

  const EUMET_LI_WMS   = EUMET_GLOBAL_WMS;
  const EUMET_LI_LAYER = 'mtg_fd:li_afa';
  const EUMET_LI_TITLE = 'Tormentas eléctricas (MTG · LI AFA)';

  // EUMETVIEW — RGB Convection (MSG / SEVIRI, 0°). Composite RGB que
  // resalta tormentas convectivas severas (top frio + sobreimpulsos). 15 min.
  // Doc: https://data.eumetsat.int/product/EO:EUM:DAT:MSG:CON
  const EUMET_CON_WMS   = EUMET_GLOBAL_WMS;
  const EUMET_CON_LAYER = 'msg_fes:rgb_convection';
  const EUMET_CON_TITLE = 'RGB Convección (MSG · SEVIRI)';

  // Proxy CORS público, sólo se usa en local cuando el navegador bloquea
  // (en producción usamos las Cloudflare Pages Functions del mismo origen,
  // ver AWC_BASE / AR_BASE arriba). corsproxy.io ha empezado a devolver 403
  // desde dominios *.pages.dev, allorigins.win es alternativa estable.
  const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

  // ── Helpers de fetch ────────────────────────────────────────────────

  function isFileProtocol() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  // Envuelve fetch con tres comportamientos:
  //  • Si el sitio está abierto con file://, falla rápido con mensaje claro.
  //  • Si el fetch directo falla (CORS / red), reintenta vía proxy CORS público.
  //  • F2.3: timeout opcional via AbortController (default 12s) para evitar
  //    que un endpoint colgado (Open-Meteo en hora punta, etc.) bloquee
  //    flujos como el refetch de viento en vuelo.
  async function safeFetch(url, label, opts) {
    opts = opts || {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12000;
    if (isFileProtocol()) {
      throw new Error(
        'Las APIs externas (' + label + ') no funcionan abriendo el HTML directamente (file://). ' +
        'Ejecuta start.bat o "python serve.py" y abre http://127.0.0.1:8000/index.html.'
      );
    }
    function fetchWithTimeout(targetUrl) {
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const tid = (ctrl && timeoutMs > 0)
        ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs)
        : null;
      const opt = ctrl ? { signal: ctrl.signal } : {};
      return fetch(targetUrl, opt).finally(() => { if (tid) clearTimeout(tid); });
    }
    // Intento directo
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return res;
      // Algunos endpoints devuelven 403/blocked sin cabeceras CORS — caemos al proxy.
      if (res.status === 403 || res.status === 0) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      // Si fue AbortError por timeout, propagar con mensaje claro y NO
      // reintentar via proxy (el proxy normalmente lo agravara).
      if (e && e.name === 'AbortError') {
        throw new Error(`${label}: timeout (${timeoutMs} ms). Endpoint no responde.`);
      }
      // TypeError "Failed to fetch" → casi siempre CORS bloqueado. Reintenta vía proxy.
      console.warn('[meteo] Fetch directo falló para', label, '— reintentando vía CORS proxy.');
      try {
        const proxied = CORS_PROXY + encodeURIComponent(url);
        const res2 = await fetchWithTimeout(proxied);
        if (!res2.ok) throw new Error('HTTP ' + res2.status);
        return res2;
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') {
          throw new Error(`${label}: timeout via proxy (${timeoutMs} ms).`);
        }
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

  // Calcula el TIME mas reciente disponible para CTH MSG. EumetSat publica
  // un mosaico nuevo cada 15 min (HH:00, HH:15, HH:30, HH:45) con un retraso
  // Cache-bust por slot de 15 minutos: parametro `cb` ignorado por el
  // servidor WMS pero que invalida la cache del navegador / SW cada vez
  // que cambia. Reemplaza al antiguo `time=ISO`: pasar un TIME explicito
  // hacia que EUMETSAT devolviese 5xx cuando el reloj del cliente caia
  // fuera de la ventana de datos publicados (caso del usuario con la
  // fecha del sistema en el futuro). Sin TIME, EUMETSAT sirve siempre
  // el mosaico mas reciente disponible — comportamiento por defecto.
  function eumetCacheBust(slotsBack) {
    const n = Math.max(1, Number(slotsBack) || 1);
    const slotMs = 15 * 60 * 1000;
    return Math.floor(Date.now() / slotMs) - n;
  }

  // EUMETVIEW MSG CTH WMS — devuelve { url, options, title, legendUrl }
  // para L.tileLayer.wms. Sin parametro TIME: el WMS devuelve el ultimo
  // mosaico publicado. cb=<slot> rota cada 15 min para forzar refresh
  // sin depender del reloj del cliente.
  function getEumetCthWMS() {
    const cb = eumetCacheBust(1);
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
        cb,
      },
    };
  }

  // Genera la config WMS para los otros dos productos EUMETVIEW (LI AFA y
  // RGB Convection). Misma mecanica que getEumetCthWMS: cb para cache-
  // bust + access_token requerido. LI AFA y Convection usan slotsBack=2
  // porque su publicacion suele tardar mas que CTH.
  function buildEumetWmsCfg({ url, layer, title, attribution, format, transparent, slotsBack }) {
    const cb = eumetCacheBust(slotsBack || 1);
    const legendUrl = `${url}?service=WMS&version=1.3.0` +
      `&request=GetLegendGraphic&format=image/png&width=400&height=200` +
      `&layer=${layer}&access_token=${EUMET_TOKEN}`;
    return {
      url, title, legendUrl,
      options: {
        layers: layer,
        format: format || 'image/png',
        transparent: transparent !== false,
        version: '1.3.0',
        attribution,
        access_token: EUMET_TOKEN,
        cb,
      },
    };
  }

  function getEumetLightningWMS() {
    return buildEumetWmsCfg({
      url: EUMET_LI_WMS, layer: EUMET_LI_LAYER, title: EUMET_LI_TITLE,
      attribution: '© EUMETSAT · MTG LI Accumulated Flash Area',
      slotsBack: 2,
    });
  }

  function getEumetConvectionWMS() {
    // RGB Convection es un composite raster (no transparente).
    return buildEumetWmsCfg({
      url: EUMET_CON_WMS, layer: EUMET_CON_LAYER, title: EUMET_CON_TITLE,
      attribution: '© EUMETSAT · MSG/SEVIRI RGB Convection',
      format: 'image/png', transparent: true,
      slotsBack: 2,
    });
  }

  // Niveles ISA disponibles en Open-Meteo (forecast pressure_level vars).
  // ft = altitud aproximada en atmosfera estandar. Incluye intermedios
  // (950, 800, 750, 650, 550, 450, 350, 225, 175 hPa) para que la
  // interpolacion del viento por FL no quede atrapada en brackets
  // demasiado anchos. Antes el salto 400(FL236)→300(FL301) era ~6500
  // ft; ahora 350 bisecta a FL266 (gap 3000 ft). Igual con 250(FL340)→
  // 200(FL387): 225 lo bisecta a FL362.
  // Niveles 275, 125 no estan en el catalogo de Open-Meteo y se omiten.
  const ISA_LEVELS = [
    { hPa: 1000, ft:   364 },
    { hPa:  950, ft:  1660 },
    { hPa:  925, ft:  2553 },
    { hPa:  850, ft:  4781 },
    { hPa:  800, ft:  6394 },
    { hPa:  750, ft:  8049 },
    { hPa:  700, ft:  9882 },
    { hPa:  650, ft: 11778 },
    { hPa:  600, ft: 13801 },
    { hPa:  550, ft: 15945 },
    { hPa:  500, ft: 18289 },
    { hPa:  450, ft: 20813 },
    { hPa:  400, ft: 23574 },
    { hPa:  350, ft: 26631 },
    { hPa:  300, ft: 30065 },
    { hPa:  250, ft: 33999 },
    { hPa:  225, ft: 36165 },
    { hPa:  200, ft: 38662 },
    { hPa:  175, ft: 41258 },
    { hPa:  150, ft: 44647 },
    { hPa:  100, ft: 53083 },
  ];

  function closestPressureLevel(fl) {
    const ft = (fl || 0) * 100;
    return ISA_LEVELS.reduce((best, l) =>
      Math.abs(l.ft - ft) < Math.abs(best.ft - ft) ? l : best, ISA_LEVELS[0]);
  }

  // Vientos en altura para cada punto en TODOS los niveles ISA. Una sola
  // llamada a Open-Meteo (lat,lon,lat,lon,... con N variables por nivel)
  // devuelve todos los pronosticos horarios; lookupWindAt(ph, atMs, fl)
  // luego interpola por altitud para cada waypoint segun su FL real.
  //
  //   { levels: [{hPa, ft}, ...],   // todos los niveles incluidos
  //     source: 'forecast',
  //     pointsHourly: [             // uno por punto
  //       { times: [iso...],
  //         byLevel: { '1000': {windSpeedKt:[...], windDir:[...]}, '925': {...}, ... }
  //       },
  //       ...
  //     ] }
  async function fetchWindsAloft(points /*, fl (ignored — fetchea todos) */) {
    if (!points || !points.length) return { levels: [], pointsHourly: [] };
    const lats = points.map(p => p.lat.toFixed(4)).join(',');
    const lons = points.map(p => p.lon.toFixed(4)).join(',');
    const vars = ISA_LEVELS.flatMap(l => [
      `wind_speed_${l.hPa}hPa`, `wind_direction_${l.hPa}hPa`,
      `temperature_${l.hPa}hPa`,
    ]).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
                `&hourly=${vars}&windspeed_unit=kn&past_days=2&forecast_days=7&timezone=UTC`;
    const res = await safeFetch(url, 'Open-Meteo (vientos pronóstico)');
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];

    return {
      levels: ISA_LEVELS.slice(),
      source: 'forecast',
      pointsHourly: arr.map(d => {
        const times = (d.hourly && d.hourly.time) || [];
        const byLevel = {};
        for (const lv of ISA_LEVELS) {
          byLevel[String(lv.hPa)] = {
            windSpeedKt:  (d.hourly && d.hourly[`wind_speed_${lv.hPa}hPa`])     || [],
            windDir:      (d.hourly && d.hourly[`wind_direction_${lv.hPa}hPa`]) || [],
            // Temperatura por nivel para calcular Density Altitude por
            // waypoint. Open-Meteo devuelve grados Celsius.
            temperatureC: (d.hourly && d.hourly[`temperature_${lv.hPa}hPa`])    || [],
          };
        }
        return { times, byLevel };
      }),
    };
  }

  // Para retrocompat con codigo viejo: lookupWindAt sobre estructura nueva.
  // Si se pasa fl, interpola entre los dos niveles ISA que lo encierran.
  // Si no, devuelve el viento al nivel 700hPa (cruise tipico) como fallback.
  function lookupWindAt(pointHourly, atMs, fl) {
    if (!pointHourly || !pointHourly.times || !pointHourly.times.length) return null;
    // Estructura legacy (un solo nivel) -> usar tal cual.
    if (pointHourly.windSpeedKt && !pointHourly.byLevel) {
      let bestIdx = 0, bestDiff = Infinity;
      for (let i = 0; i < pointHourly.times.length; i++) {
        const t = new Date(pointHourly.times[i] + 'Z').getTime();
        const diff = Math.abs(t - atMs);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      }
      return {
        windSpeedKt:  pointHourly.windSpeedKt[bestIdx],
        windDir:      pointHourly.windDir[bestIdx],
        temperatureC: pointHourly.temperatureC ? pointHourly.temperatureC[bestIdx] : null,
        atTime:       pointHourly.times[bestIdx] + 'Z',
      };
    }
    // Tiempo mas cercano a atMs.
    let bestIdx = 0, bestDiff = Infinity;
    for (let i = 0; i < pointHourly.times.length; i++) {
      const t = new Date(pointHourly.times[i] + 'Z').getTime();
      const diff = Math.abs(t - atMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    const atTime = pointHourly.times[bestIdx] + 'Z';
    // Niveles ISA ordenados de menor a mayor altitud.
    const sorted = ISA_LEVELS.slice().sort((a, b) => a.ft - b.ft);
    const ftWp = (Number.isFinite(fl) ? fl : 350) * 100;
    // Bracket por altitud.
    let lo = sorted[0], hi = sorted[sorted.length - 1];
    if (ftWp <= sorted[0].ft) { lo = hi = sorted[0]; }
    else if (ftWp >= sorted[sorted.length - 1].ft) { lo = hi = sorted[sorted.length - 1]; }
    else {
      for (let i = 0; i < sorted.length - 1; i++) {
        if (ftWp >= sorted[i].ft && ftWp <= sorted[i + 1].ft) {
          lo = sorted[i]; hi = sorted[i + 1]; break;
        }
      }
    }
    const dLo = pointHourly.byLevel[String(lo.hPa)];
    const dHi = pointHourly.byLevel[String(hi.hPa)];
    if (!dLo || !dHi) return null;
    const wsLo = dLo.windSpeedKt[bestIdx], wdLo = dLo.windDir[bestIdx];
    const wsHi = dHi.windSpeedKt[bestIdx], wdHi = dHi.windDir[bestIdx];
    if (!Number.isFinite(wsLo) && !Number.isFinite(wsHi)) return null;
    const t = lo.ft === hi.ft ? 0 : (ftWp - lo.ft) / (hi.ft - lo.ft);
    // Interpolacion vectorial (u, v) para no romper en 359°/0°.
    const toRad = d => d * Math.PI / 180;
    const uLo = -wsLo * Math.sin(toRad(wdLo));
    const vLo = -wsLo * Math.cos(toRad(wdLo));
    const uHi = -wsHi * Math.sin(toRad(wdHi));
    const vHi = -wsHi * Math.cos(toRad(wdHi));
    const u = uLo + (uHi - uLo) * t;
    const v = vLo + (vHi - vLo) * t;
    const speed = Math.sqrt(u * u + v * v);
    let dir = Math.atan2(-u, -v) * 180 / Math.PI;
    if (dir < 0) dir += 360;
    // Temperatura interpolada linealmente entre niveles. Si uno de los
    // dos niveles no trae temperatura, usamos el que si tenga.
    const tLo = dLo.temperatureC ? dLo.temperatureC[bestIdx] : null;
    const tHi = dHi.temperatureC ? dHi.temperatureC[bestIdx] : null;
    let temperatureC = null;
    if (Number.isFinite(tLo) && Number.isFinite(tHi))      temperatureC = tLo + (tHi - tLo) * t;
    else if (Number.isFinite(tLo))                         temperatureC = tLo;
    else if (Number.isFinite(tHi))                         temperatureC = tHi;
    return {
      windSpeedKt: speed,
      windDir: dir,
      temperatureC,
      atTime,
      levelLo: lo,
      levelHi: hi,
      interpFactor: t,
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

  // NOTAMs via Autorouter /v1.0/notam.
  //
  // Doc oficial: https://www.autorouter.aero/wiki/api/notams/
  //
  // Params:
  //   - itemas:        JSON-encoded array de ICAOs (aerodromos O FIRs).
  //                    Formato literal: ["EDDS"] (sin URL-encoding en
  //                    docs, pero URLSearchParams lo codifica solo).
  //   - offset/limit:  paginacion. limit MAX = 100 (Default = 100).
  //   - startvalidity: epoch segundos UTC. Default 0.
  //   - endvalidity:   epoch segundos UTC. Default 2^32-1.
  //
  // Respuesta: { "total": N, "rows": [...NotamOut...] }
  // (NO es array directo — eso pegaba antes y los descartabamos todos).
  //
  // Paginamos con offset hasta cubrir total (o agotar NOTAM_MAX_PAGES).
  const NOTAM_PAGE_SIZE = 100;
  const NOTAM_MAX_PAGES = 20;            // tope de seguridad: 2000 NOTAMs

  async function fetchNotamsForAerodromes(icaoList) {
    if (!icaoList) return [];
    const list = (Array.isArray(icaoList) ? icaoList : [icaoList])
      .map(s => String(s || '').trim().toUpperCase())
      .filter(s => /^[A-Z]{4}$/.test(s));
    if (!list.length) return [];
    const serverAuth = await checkServerAuth();
    const reqInit = {};
    if (!serverAuth) {
      const token = await getArToken();
      reqInit.headers = { 'Authorization': 'Bearer ' + token };
    }
    const itemas = JSON.stringify(list);
    const all = [];
    let total = null;
    let page = 0;
    for (page = 0; page < NOTAM_MAX_PAGES; page++) {
      const params = new URLSearchParams({
        itemas,
        offset: String(page * NOTAM_PAGE_SIZE),
        limit:  String(NOTAM_PAGE_SIZE),
      });
      const url = `${AR_BASE}/notam?${params.toString()}`;
      const res = await _arFetch(url, reqInit);
      if (res.status === 401) {
        if (!serverAuth) sessionStorage.removeItem(AR_TOKEN_KEY);
        let reason = null;
        try { const d = await res.clone().json(); reason = d && d.reason; } catch (_) {}
        if (reason === 'no_credentials' || reason === 'server_auth_failed') {
          const e = new Error('SERVER_NO_CREDS'); e.detail = reason; throw e;
        }
        throw new Error('TOKEN_REJECTED');
      }
      if (!res.ok) throw new Error('NOTAM HTTP ' + res.status);
      const data = await res.json();
      // Respuesta envelope: { total, rows }. Tambien aceptamos array
      // directo como fallback por si la API cambia.
      const rows = Array.isArray(data) ? data
                 : (data && Array.isArray(data.rows)) ? data.rows
                 : null;
      if (!rows) {
        console.warn('[notam] respuesta inesperada (ni array ni {rows}):', data);
        break;
      }
      if (page === 0 && typeof data.total === 'number') total = data.total;
      if (rows.length === 0) break;
      for (const n of rows) all.push(n);
      // Cortes: si ya tenemos el total declarado, o si la pagina llego
      // incompleta (ultima pagina).
      if (total != null && all.length >= total) break;
      if (rows.length < NOTAM_PAGE_SIZE) break;
    }
    if (page === NOTAM_MAX_PAGES) {
      console.warn(`[notam] Tope ${NOTAM_MAX_PAGES} paginas alcanzado con ${all.length} NOTAMs. ` +
                   `total reportado=${total}. Sube NOTAM_MAX_PAGES si falta.`);
    }
    if (all.length > 0) {
      const byIcao = {};
      for (const n of all) {
        const k = String(n.icaoLocation || n.location || '?').toUpperCase();
        byIcao[k] = (byIcao[k] || 0) + 1;
      }
      // Solo muestro los ICAOs solicitados — pero si el conteo es 0
      // para todos, hay un mismatch (campo distinto del esperado o
      // Autorouter devuelve cosa distinta).
      const requested = list.map(c => `${c}:${byIcao[c] || 0}`).join(' ');
      const allRequestedZero = list.every(c => !byIcao[c]);
      const presentSorted = Object.entries(byIcao)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      console.info(`[notam] Autorouter ${all.length}/${total != null ? total : '?'} NOTAMs ` +
                   `(${page + 1} req) — por ICAO pedido: ${requested}`);
      console.info(`[notam] Autorouter ICAOs presentes (top 15): ${presentSorted}`);
      if (allRequestedZero) {
        const sample = all[0] || {};
        console.warn('[notam] NINGUN NOTAM coincide con los ICAOs pedidos. ' +
                     'Probable mismatch de campo. Claves del primer NOTAM:',
                     Object.keys(sample));
        console.warn('[notam] Primer NOTAM completo (para ver shape):', JSON.parse(JSON.stringify(sample)));
      }
    } else {
      console.info(`[notam] Autorouter devolvio 0 NOTAMs para itemas=${itemas}` +
                   (total != null ? ` (total reportado=${total})` : ''));
    }
    // Normalizamos cada NOTAM al shape que el resto del codigo espera:
    // {notamId, icaoLocation, fromDate, toDate, text, raw}. Autorouter
    // devuelve los datos descompuestos por campo (series, number, year,
    // itema, iteme, code23, code45, traffic, lower, upper, lat, lon,
    // radius, startvalidity, endvalidity). Reconstruimos el formato
    // ICAO clasico ("Q) FIR/QXXYY/T/P/S/LOW/UP/LATLONRAD\nA) ICAO\n
    // E) body...") para que las regex de Q-line y de palabras clave
    // (RMK, EXC CONTROLLED AIRSPACE, ...) sigan funcionando.
    return all.map(normalizeAutorouterNotam);
  }

  function normalizeAutorouterNotam(n) {
    if (!n || typeof n !== 'object') return n;
    const series = n.series || '';
    const num = (n.number != null) ? String(n.number).padStart(4, '0') : '';
    const yr  = (n.year != null) ? String(n.year).slice(-2).padStart(2, '0') : '';
    const notamId = (series && num && yr) ? `${series}${num}/${yr}` : '';

    // Item A): ICAO afectado. Autorouter pone el aerodromo o la FIR aqui.
    const icaoLocation = String(n.itema || n.fir || '').trim().toUpperCase();

    // Reconstruccion del header Q-line si tenemos code23 + code45.
    // Formato: Q) FIR/QXXYY/Traffic/Purpose/Scope/Lower/Upper/<coord+rad>
    //
    // Autorouter entrega lat/lon como ENTERO ESCALADO x10^7 (signed)
    // — p.ej. 461311302 -> 46.1311302 grados; -105584612 -> -10.5585.
    // Detectamos el escalado por magnitud (|v| > 360 = escalado) y
    // dividimos antes de formatear ICAO compacto DDMMN/DDDMME.
    let qLine = '';
    if (n.code23 && n.code45) {
      const pad3 = v => (v == null ? '999' : String(v).padStart(3, '0'));
      const toNum = (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v === 'string') {
          const x = Number(v);
          return Number.isFinite(x) ? x : null;
        }
        return null;
      };
      // Si el numero es "muy grande" (mayor que 360 en valor absoluto)
      // asumimos que viene escalado x10^7 y deshacemos el escalado.
      const unscaleAngle = (v) => {
        if (v == null) return null;
        return Math.abs(v) > 360 ? v / 1e7 : v;
      };
      const lat = unscaleAngle(toNum(n.lat));
      const lon = unscaleAngle(toNum(n.lon));
      const rad = toNum(n.radius);
      const fmtLat = (v) => {
        if (v == null) return '';
        const hem = v >= 0 ? 'N' : 'S';
        const a = Math.abs(v);
        const d = Math.floor(a);
        const m = Math.round((a - d) * 60);
        return `${String(d).padStart(2, '0')}${String(m).padStart(2, '0')}${hem}`;
      };
      const fmtLon = (v) => {
        if (v == null) return '';
        const hem = v >= 0 ? 'E' : 'W';
        const a = Math.abs(v);
        const d = Math.floor(a);
        const m = Math.round((a - d) * 60);
        return `${String(d).padStart(3, '0')}${String(m).padStart(2, '0')}${hem}`;
      };
      const coordOnly = fmtLat(lat) + fmtLon(lon);   // sin slice, llevamos letras
      const radStr = (rad != null) ? String(Math.round(rad)).padStart(3, '0') : '';
      qLine = `Q) ${n.fir || ''}/Q${n.code23}${n.code45}/${n.traffic || 'IV'}/${n.purpose || ''}/${n.scope || ''}/${pad3(n.lower)}/${pad3(n.upper)}/${coordOnly}${radStr}`;

      // Diagnostico: dump de las primeras areas (Q-subject = RA / RR /
      // RT / RD) para verificar que lat/lon/radius llegan como esperamos.
      if (!normalizeAutorouterNotam._debugCount) normalizeAutorouterNotam._debugCount = 0;
      if (normalizeAutorouterNotam._debugCount < 3 && /^R/.test(n.code23)) {
        normalizeAutorouterNotam._debugCount++;
        console.info(`[notam-debug] ${series}${num}/${yr}  lat=${JSON.stringify(n.lat)} lon=${JSON.stringify(n.lon)} rad=${JSON.stringify(n.radius)}  -> fmt=${JSON.stringify(coordOnly)}  qLine="${qLine}"`);
      }
    }

    const parts = [];
    if (qLine) parts.push(qLine);
    if (n.itema) parts.push(`A) ${n.itema}`);
    // Validez B)/C): usamos startvalidity/endvalidity epoch.
    const epochToStr = (sec) => {
      if (sec == null || !Number.isFinite(sec)) return '';
      const d = new Date(sec * 1000);
      if (isNaN(d.getTime())) return '';
      const pad = x => String(x).padStart(2, '0');
      return `${String(d.getUTCFullYear()).slice(-2)}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    };
    if (n.startvalidity != null) parts.push(`B) ${epochToStr(n.startvalidity)}`);
    if (n.endvalidity != null)   parts.push(`C) ${epochToStr(n.endvalidity)}`);
    if (n.itemd) parts.push(`D) ${n.itemd}`);
    if (n.iteme) parts.push(`E) ${n.iteme}`);
    if (n.itemf) parts.push(`F) ${n.itemf}`);
    if (n.itemg) parts.push(`G) ${n.itemg}`);

    const text = parts.join('\n');
    return Object.assign({}, n, {
      notamId,
      icaoLocation,
      fromDate: n.startvalidity != null ? new Date(n.startvalidity * 1000).toISOString() : null,
      toDate:   n.endvalidity   != null ? new Date(n.endvalidity   * 1000).toISOString() : null,
      text,
      raw: text,
    });
  }

  // SIGMETs internacionales (AWC iSIGMET).
  // Usamos format=json (NO geojson) porque el geojson de AWC simplifica
  // los poligonos: nos devuelve el campo `coords` como string "lat lng,
  // lat lng, ..." que parseamos manualmente para tener la geometria
  // exacta. Tambien soportamos geom=CIRCLE leyendo del raw el centro y
  // el radio en NM.
  // Doc: https://aviationweather.gov/data/api/
  async function fetchSigmets() {
    const url = AWC_BASE + '/isigmet?format=json';
    const res = await _arFetch(url, {});
    if (!res.ok) throw new Error('SIGMET HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data;
  }

  // ── Decodificador SIGMET ───────────────────────────────────────────
  // Convierte un SIGMET crudo en campos legibles en espanyol.

  function decodePhenomenon(hazard, qualifier) {
    const HAZ = {
      TS: 'Tormenta',
      TURB: 'Turbulencia',
      ICE: 'Engelamiento',
      MTW: 'Ondas de montaña',
      VA: 'Ceniza volcánica',
      DS: 'Tormenta de polvo',
      SS: 'Tormenta de arena',
      TC: 'Ciclón tropical',
      RDOACT: 'Nube radiactiva',
    };
    const QUAL = {
      OBSC: 'oscurecida',
      EMBD: 'embebida',
      FRQ:  'frecuente',
      SQL:  'línea de turbonada',
      ISOL: 'aislada',
      OCNL: 'ocasional',
      SEV:  'severo/a',
      MOD:  'moderado/a',
      HVY:  'fuerte',
    };
    const base = HAZ[String(hazard || '').toUpperCase()] || (hazard || '—');
    const q = QUAL[String(qualifier || '').toUpperCase()];
    return q ? `${base} ${q}` : base;
  }

  function decodeLevels(base, top, raw) {
    if (base != null && top != null) return `FL${pad3(base)} – FL${pad3(top)}`;
    if (top  != null) return `Hasta FL${pad3(top)}`;
    if (base != null) return `Desde FL${pad3(base)}`;
    // Fallback al raw: TOP FL400, BLW FL100, FL200/350
    if (!raw) return '—';
    let m = raw.match(/\bFL(\d{2,3})\s*\/\s*FL?(\d{2,3})\b/);
    if (m) return `FL${pad3(m[1])} – FL${pad3(m[2])}`;
    m = raw.match(/\bTOP\s+FL(\d{2,3})\b/);
    if (m) return `Hasta FL${pad3(m[1])}`;
    m = raw.match(/\bBLW\s+FL(\d{2,3})\b/);
    if (m) return `Por debajo de FL${pad3(m[1])}`;
    m = raw.match(/\bABV\s+FL(\d{2,3})\b/);
    if (m) return `Por encima de FL${pad3(m[1])}`;
    return '—';
  }
  function pad3(n) { return String(n).padStart(3, '0'); }

  function decodeMotion(dir, spd, chng) {
    const DIR = {
      N: 'norte', NE: 'noreste', E: 'este', SE: 'sureste',
      S: 'sur',   SW: 'suroeste', W: 'oeste', NW: 'noroeste',
    };
    const CHNG = { NC: 'sin cambio', INTSF: 'intensificándose', WKN: 'debilitándose' };
    const parts = [];
    if (!dir && !spd) parts.push('Estacionario');
    else if (dir && spd) parts.push(`Moviéndose hacia ${DIR[String(dir).toUpperCase()] || dir} a ${spd} kt`);
    else if (spd) parts.push(`Movimiento ${spd} kt`);
    else parts.push(`Movimiento hacia ${DIR[String(dir).toUpperCase()] || dir}`);
    if (chng && CHNG[String(chng).toUpperCase()]) {
      parts.push(CHNG[String(chng).toUpperCase()]);
    }
    return parts.join(' · ');
  }

  // Convierte el campo validTimeFrom/To de AWC a Date. AWC los devuelve
  // como EPOCH EN SEGUNDOS (no milisegundos), asi que pasarlos directos
  // a new Date() daba fechas de enero del 70. Detectamos por tamanyo:
  // valores < 1e12 son segundos, >= 1e12 son ms.
  function toDateSafe(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      const ms = v < 1e12 ? v * 1000 : v;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'string') {
      if (/^\d+$/.test(v)) {
        const n = parseInt(v, 10);
        const ms = n < 1e12 ? n * 1000 : n;
        return new Date(ms);
      }
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  // Fallback: parsea "VALID DDhhmm/DDhhmm" del texto crudo. Usa la fecha
  // de emision o "hoy" como referencia para inferir mes/anyo (los SIGMETs
  // solo dan dia+hora). Si el dia final es menor que el inicial, asume
  // cambio de mes.
  function parseSigmetValidityFromRaw(raw, refDate) {
    if (!raw) return null;
    const m = String(raw).match(/\bVALID\s+(\d{2})(\d{2})(\d{2})\s*\/\s*(\d{2})(\d{2})(\d{2})\b/);
    if (!m) return null;
    const ref = refDate || new Date();
    let year  = ref.getUTCFullYear();
    let month = ref.getUTCMonth();
    const d1 = parseInt(m[1], 10), h1 = parseInt(m[2], 10), mn1 = parseInt(m[3], 10);
    const d2 = parseInt(m[4], 10), h2 = parseInt(m[5], 10), mn2 = parseInt(m[6], 10);
    // Si el dia inicial es muy posterior al actual, probablemente mes anterior.
    if (d1 - ref.getUTCDate() > 20) {
      month--;
      if (month < 0) { month = 11; year--; }
    }
    const from = new Date(Date.UTC(year, month, d1, h1, mn1));
    // Si d2 < d1, cruza fin de mes.
    let yearTo = year, monthTo = month;
    if (d2 < d1) {
      monthTo++;
      if (monthTo > 11) { monthTo = 0; yearTo++; }
    }
    const to = new Date(Date.UTC(yearTo, monthTo, d2, h2, mn2));
    return { from, to };
  }

  function fmtUtcDayHour(d) {
    if (!d || isNaN(d.getTime())) return '?';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  }

  function decodeValidity(sig) {
    // 1) Intentar campos estructurados de AWC (epoch segundos).
    let from = toDateSafe(sig.validTimeFrom);
    let to   = toDateSafe(sig.validTimeTo);
    // 2) Si alguno falta o esta corrupto, parsear del raw.
    if (!from || !to) {
      const issued = toDateSafe(sig.issueTime) || new Date();
      const parsed = parseSigmetValidityFromRaw(sig.rawSigmet, issued);
      if (parsed) {
        from = from || parsed.from;
        to   = to   || parsed.to;
      }
    }
    if (!from && !to) return '—';
    return `${fmtUtcDayHour(from)} → ${fmtUtcDayHour(to)}`;
  }

  function decodeSigmet(sig) {
    return {
      phenomenon: decodePhenomenon(sig.hazard, sig.qualifier),
      levels:     decodeLevels(sig.base, sig.top, sig.rawSigmet),
      validity:   decodeValidity(sig),
      motion:     decodeMotion(sig.dir, sig.spd, sig.chng),
      firId:      sig.firId   || '',
      firName:    sig.firName || '',
      issuer:     sig.icaoId  || '',
      seriesId:   sig.seriesId|| '',
    };
  }

  // ── Geometria del SIGMET ───────────────────────────────────────────
  // AWC entrega el poligono en `coords` como "lat lng,lat lng,..." (sin
  // cierre del anillo). Para CIRCLE, leemos centro + radio del raw.

  function parseSigmetGeometry(sig) {
    // Caso poligono: cadena "lat lon, lat lon, ..."
    if (sig.coords && typeof sig.coords === 'string') {
      const pts = parseCoordPairs(sig.coords);
      if (pts.length >= 3) {
        // Cerramos el anillo si no esta cerrado.
        const closed = (pts[0][0] === pts[pts.length - 1][0] &&
                        pts[0][1] === pts[pts.length - 1][1]) ? pts : pts.concat([pts[0]]);
        return { kind: 'poly', latlngs: closed };
      }
    }
    // Caso poligono via array de objetos.
    if (Array.isArray(sig.coords) && sig.coords.length >= 3) {
      const pts = sig.coords
        .map(c => c && (Array.isArray(c) ? c : [c.lat, c.lon || c.lng]))
        .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length >= 3) {
        const closed = (pts[0][0] === pts[pts.length - 1][0] &&
                        pts[0][1] === pts[pts.length - 1][1]) ? pts : pts.concat([pts[0]]);
        return { kind: 'poly', latlngs: closed };
      }
    }
    // Caso CIRCLE: parsear del raw "WI CIRCLE 100NM CENTRE N4040 E00310"
    const raw = String(sig.rawSigmet || '');
    const mCircle = raw.match(/\bCIRCLE\s+(\d+)\s*NM\s+(?:CENTR?E\s+)?([NS])(\d{2,4})\s*([EW])(\d{3,5})\b/i);
    if (mCircle) {
      const radiusNM = Number(mCircle[1]);
      const lat = ddm(mCircle[2], mCircle[3]);
      const lng = ddm(mCircle[4], mCircle[5]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusNM)) {
        return { kind: 'circle', center: [lat, lng], radiusM: radiusNM * 1852 };
      }
    }
    // Caso poligono en raw "WI N4040 E00310 - N4205 E00420 - ..."
    const mPoly = raw.match(/\bWI(?:THIN)?\s+((?:[NS]\d{2,4}\s*[EW]\d{3,5}\s*-?\s*)+)/i);
    if (mPoly) {
      const pts = [...mPoly[1].matchAll(/([NS])(\d{2,4})\s*([EW])(\d{3,5})/g)].map(m => {
        const lat = ddm(m[1], m[2]);
        const lng = ddm(m[3], m[4]);
        return [lat, lng];
      }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length >= 3) {
        const closed = (pts[0][0] === pts[pts.length - 1][0] &&
                        pts[0][1] === pts[pts.length - 1][1]) ? pts : pts.concat([pts[0]]);
        return { kind: 'poly', latlngs: closed };
      }
    }
    return null;
  }

  // Parsea "lat lng,lat lng,..." (formato AWC). Soporta lat lng separados
  // por espacio o coma, separados entre pares por coma.
  function parseCoordPairs(s) {
    if (!s) return [];
    return s.split(/[,;]+/).map(pair => {
      const m = pair.trim().match(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2])];
    }).filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }

  // Convierte un identificador ICAO de coordenada (N4040 = 40°40') a
  // grados decimales. Acepta NDDMM, NDDMMMM (4-5 digitos lat) y EDDDMM,
  // EDDDMMMM (5-6 digitos lng).
  function ddm(hemi, digits) {
    const d = String(digits);
    let deg, min;
    if (d.length === 4 || d.length === 5) {
      const cut = d.length - 2;
      deg = Number(d.slice(0, cut));
      min = Number(d.slice(cut));
    } else if (d.length === 6 || d.length === 7) {
      // segundos incluidos (raro en SIGMET, pero por si acaso)
      const cut = d.length - 4;
      deg = Number(d.slice(0, cut));
      min = Number(d.slice(cut, cut + 2)) + Number(d.slice(cut + 2)) / 100;
    } else {
      return NaN;
    }
    let v = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') v = -v;
    return v;
  }

  // Extrae poligono o circulo del cuerpo de un NOTAM en formato ICAO.
  // Estrategias en orden de fiabilidad:
  //   1) CIRCLE explicito en el cuerpo:
  //      "RADIUS N NM CENTR(ED|E) (ON) DDDD[NS]DDDDD[EW]"
  //   2) Poligono explicito en el cuerpo:
  //      secuencia >=3 puntos "DDDD[NS]DDDDD[EW]" o "[NS]DDDD [EW]DDDDD"
  //   3) FALLBACK: Q-line con centro+radio en formato ICAO compacto:
  //      "Q) FIR/QCODE/.../<DDDD[NS]DDDDD[EW]<radius3>"
  //      Esto es CLAVE para NOTAMs militares LPPC y similares que no
  //      meten coords en el body (solo nombran el area por su id, p.ej.
  //      "LPR1 ACTIVATED"). El Q-line SI lleva centroide y radio NM.
  // Devuelve { kind:'poly', latlngs } | { kind:'circle', center, radiusM }
  // | null si no se puede parsear.
  function parseNotamGeometry(rawText) {
    if (!rawText) return null;
    const text = String(rawText);

    // Caso 1: CIRCLE explicito en cuerpo (mas especifico).
    const mC = text.match(
      /RADIUS\s+(\d+(?:\.\d+)?)\s*(NM|KM)\s+(?:CENTR(?:E|ED)\s+)?(?:ON\s+)?(\S+\s*\S*)/i
    );
    if (mC) {
      const radius = Number(mC[1]);
      const unit = mC[2].toUpperCase();
      const radiusM = unit === 'KM' ? radius * 1000 : radius * 1852;
      const pt = parseSingleICAOCoord(mC[3]);
      if (pt && Number.isFinite(radiusM)) {
        return { kind: 'circle', center: pt, radiusM, source: 'body-circle' };
      }
    }

    // Caso 2: POLY en cuerpo. Buscamos puntos ICAO PERO ignorando el
    // Q-line del header (esa coord es el centroide del area, no un
    // vertice). El Q-line tiene la forma "Q) FIR/Q.../..." asi que
    // troceamos en el primer "A) " que marca el inicio del cuerpo.
    const bodyStart = text.indexOf('A)');
    const body = bodyStart >= 0 ? text.slice(bodyStart) : text;
    // Variante A: DDDD[NS]DDDDD[EW]   (digitos primero)
    const rxA = /\b(\d{4,6})\s*([NS])\s*(\d{5,7})\s*([EW])\b/g;
    // Variante B: [NS]DDDD [EW]DDDDD  (hemisferio primero)
    const rxB = /\b([NS])\s*(\d{4,6})\s*([EW])\s*(\d{5,7})\b/g;
    const pts = [];
    let m;
    while ((m = rxA.exec(body)) !== null) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push([lat, lng]);
    }
    if (pts.length < 3) {
      pts.length = 0;
      while ((m = rxB.exec(body)) !== null) {
        const lat = ddm(m[1], m[2]);
        const lng = ddm(m[3], m[4]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push([lat, lng]);
      }
    }
    if (pts.length >= 3) {
      const closed = (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1])
        ? pts : pts.concat([pts[0]]);
      return { kind: 'poly', latlngs: closed, source: 'body-poly' };
    }

    // Caso 3 FALLBACK: extraer centroide y radio del Q-line.
    const q = parseNotamQLineGeometry(text);
    if (q) return q;

    return null;
  }

  // Parsea el centroide y radio del Q-line ICAO. Formato:
  //   Q) FIR/QCODE/T/P/S/L/U/<coordenada+radio>
  // donde la coordenada+radio es DDDD[NS]DDDDD[EW]<NNN> (NN NM).
  // Algunos NOTAMs no traen el radio (acaba en .../000/999/) y otros
  // omiten el campo entero, asi que probamos con y sin radio.
  function parseNotamQLineGeometry(rawText) {
    if (!rawText) return null;
    // Intenta primero con radio explicito (3 digitos al final).
    let m = String(rawText).match(
      /Q\)\s*[A-Z]{4}\/Q[A-Z]{4}\/[^\/]+\/[^\/]+\/[^\/]+\/\d{3}\/\d{3,4}\/(\d{2,4})([NS])(\d{3,5})([EW])(\d{3})\b/
    );
    if (m) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      const radiusNM = parseInt(m[5], 10);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusNM) && radiusNM > 0) {
        return { kind: 'circle', center: [lat, lng], radiusM: radiusNM * 1852, source: 'q-line' };
      }
    }
    // Sin radio: el Q-line acaba en la coordenada. Como fallback dibujamos
    // un circulo de 10 NM al rededor del centroide para que el piloto vea
    // donde esta el area aunque sea aproximado.
    m = String(rawText).match(
      /Q\)\s*[A-Z]{4}\/Q[A-Z]{4}\/[^\/]+\/[^\/]+\/[^\/]+\/\d{3}\/\d{3,4}\/(\d{2,4})([NS])(\d{3,5})([EW])\b/
    );
    if (m) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { kind: 'circle', center: [lat, lng], radiusM: 10 * 1852, source: 'q-line-noradius' };
      }
    }
    return null;
  }

  function parseSingleICAOCoord(s) {
    if (!s) return null;
    let m = String(s).match(/\b(\d{4,6})\s*([NS])\s*(\d{5,7})\s*([EW])\b/);
    if (m) {
      const lat = ddm(m[2], m[1]);
      const lng = ddm(m[4], m[3]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
    }
    m = String(s).match(/\b([NS])\s*(\d{4,6})\s*([EW])\s*(\d{5,7})\b/);
    if (m) {
      const lat = ddm(m[1], m[2]);
      const lng = ddm(m[3], m[4]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
    }
    return null;
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
  const MAX_GRAMET_WAYPOINTS = 30;
  const MAX_GRAMET_TOTALEET  = 6 * 3600;

  function getGrametUrl(plan, format, strategy) {
    if (!plan || !plan.coords || plan.coords.length < 2) return null;
    format = format || 'png';
    strategy = strategy || 'full';
    const waypoints = buildWaypointsString(plan, strategy);
    if (!waypoints) return null;
    const departuretime = Math.floor(plan.departureUTC.getTime() / 1000);
    // Duracion TOTAL del vuelo en segundos. plan.timeMinutes es la
    // estimacion ingenua (distance / TAS) calculada en flightPlan.plan()
    // y NO incluye holds ni la correccion por viento. El log de vuelo
    // (plan.fuel.rows[last].cumTimeMin) si los incluye, asi que lo
    // preferimos cuando esta disponible -- de lo contrario el chart usa
    // una duracion irreal y los waypoints intermedios caen en horas
    // equivocadas del pronostico meteo.
    let totalMin = Number(plan.timeMinutes) || 0;
    if (plan.fuel && Array.isArray(plan.fuel.rows) && plan.fuel.rows.length) {
      const lastCum = plan.fuel.rows[plan.fuel.rows.length - 1].cumTimeMin;
      if (Number.isFinite(lastCum) && lastCum > 0) totalMin = lastCum;
    }
    const totalSec = Math.round(totalMin * 60);
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
  // uniforme del interior, hasta un maximo de "max" entradas. Usado para
  // listas de NAMES (sin info de distancia/along).
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

  // Selecciona como mucho `count` candidatos de una lista ordenada por
  // along-track. Divide la ruta en bins y en cada uno se queda con los
  // DOS hits mas cercanos a la centerline (el #1 y el #2). Asi en zonas
  // densas (Estrecho, costa, vecindad de aeropuertos) se cogen pares
  // de waypoints adyacentes en lugar de uno solo, dando mas densidad
  // sin perder cobertura geografica. El numero de bins se ajusta para
  // que (bins * 2) ~= count.
  function selectByProximityBins(hits, count) {
    if (hits.length <= count) return hits;
    // Bins pequenos (1 pick por bin) para maxima resolucion espacial.
    // Si quieres mas densidad subes count, no PICKS_PER_BIN.
    const nBins = count;
    const minA = hits[0].along;
    const maxA = hits[hits.length - 1].along;
    const span = Math.max(1, maxA - minA);
    const binW = span / nBins;
    const bins = new Map();
    for (const h of hits) {
      const idx = Math.min(nBins - 1, Math.floor((h.along - minA) / binW));
      let arr = bins.get(idx);
      if (!arr) { arr = []; bins.set(idx, arr); }
      arr.push(h);
    }
    const out = [];
    for (let i = 0; i < nBins; i++) {
      const arr = bins.get(i);
      if (!arr) continue;
      arr.sort((a, b) => a.dist - b.dist);
      // Por bin: el waypoint mas cercano. Si el id ya aparecio en un bin
      // adyacente (puede pasar con multiples proyecciones), saltamos al
      // segundo mas cercano para no repetir.
      const lastId = out.length ? out[out.length - 1].id : null;
      let picked = null;
      for (const h of arr) {
        if (h.id === lastId) continue;
        picked = h;
        break;
      }
      if (picked) out.push(picked);
      else if (arr.length) out.push(arr[0]);
    }
    out.sort((a, b) => a.along - b.along);
    return out.slice(0, count);
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
    // Filtramos waypoints co-localizados con origen/destino (p.ej. VBZ
    // en LEBZ) -- aniaden ruido al chart sin info adicional sobre el
    // tiempo y le quitan slots a fixes intermedios mas alejados.
    const NEAR_ENDPOINT_NM = 3;
    const oPt = aw.waypoints[plan.origin] || null;
    const dPt = aw.waypoints[plan.destination] || null;
    const sameSpot = (a, b) => {
      const dla = (a[0] - b[0]) * 60;
      const ml  = ((a[0] + b[0]) / 2) * Math.PI / 180;
      const dlo = (a[1] - b[1]) * 60 * Math.cos(ml);
      return Math.sqrt(dla * dla + dlo * dlo) < NEAR_ENDPOINT_NM;
    };
    const known = [];
    for (const [id, pt] of Object.entries(aw.waypoints)) {
      const type = aw.waypointTypes[id];
      if (type !== 'AIRPORT' && type !== 'NAVAID' && type !== 'RNAV') continue;
      if (id === plan.origin || id === plan.destination) continue;
      if (oPt && sameSpot(pt, oPt)) continue;
      if (dPt && dPt !== oPt && sameSpot(pt, dPt)) continue;
      known.push({ id, lat: pt[0], lon: pt[1], type });
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
      // Conserva TODAS las entradas (cada (id, segmento) es un candidato
      // distinto en una posicion along-track distinta). El dedup por id
      // se hace dentro de selectByProximityBins para no perder la mejor
      // proyeccion de un waypoint cuando otra suya peor le precede en
      // orden por along.
      const filtered = allHits.filter(h => h.dist <= thresholdNM);
      filtered.sort((a, b) => a.along - b.along);
      const uniqueIds = new Set(filtered.map(c => c.id));
      return { ordered: filtered, uniqueCount: uniqueIds.size };
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
      console.info('[gramet] Pocos aerodromos a <=30 NM; ampliado a', usedNM, 'NM (', chosen.uniqueCount, 'unicos)');
    }

    // Seleccion final: bins pequenos por along-track, en cada bin el
    // waypoint mas cercano a la centerline. Como origen, destino y los
    // waypoints co-localizados con ellos ya estan filtrados arriba, todo
    // chosen.ordered es candidato.
    const slots = Math.max(2, MAX_GRAMET_WAYPOINTS - 2); // margen para origen/destino
    const selected = selectByProximityBins(chosen.ordered, slots);

    let names = selected.map(c => c.id);
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
    getEumetLightningWMS, getEumetConvectionWMS,
    fetchCloudsForPoints, fetchWindsAloft, lookupWindAt,
    getGrametUrl, fetchGramet,
    fetchNotamsForAerodromes,
    fetchSigmets, decodeSigmet, parseSigmetGeometry,
    parseNotamGeometry,
    hasArCreds, setStoredArCreds, clearStoredArAuth, checkServerAuth,
    // alias retro-compatible para código que aún usa el nombre antiguo
    getGibsCloudWMS: getEumetCthWMS,
  };
})();
