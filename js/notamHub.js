// Cliente para la API ICARO NOTAM/TSA hospedada en notamhub.duckdns.org.
//
// Endpoints relevantes:
//   GET /health
//   GET /tsas/active                 ? at, bbox, vmin, vmax
//   GET /notams/aerodrome/{icao}     ? at, include_refs
//   GET /notams/fir/{icao}           ? at, include_refs
//   GET /bulletins
//
// Autenticacion: cabecera x-user-token. En produccion (Pages) la inyecta
// la Pages Function /api/notamhub/... desde env var NOTAMHUB_USER_TOKEN
// o default; en local (file://) el navegador no puede llegar a la API
// sin token, asi que tambien aceptamos un override client-side guardado
// en localStorage por si el usuario quiere usar otra cuenta.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.notamHub = (function () {
  'use strict';

  const ON_REMOTE = !/^(?:localhost|127\.0\.0\.1)$/i.test(location.hostname) &&
                    location.protocol !== 'file:';
  // En produccion vamos via Pages Function. En local apuntamos al upstream
  // directamente (precisa CORS habilitado al upstream, que duckdns suele
  // permitir).
  const BASE = ON_REMOTE
    ? '/api/notamhub'
    : 'https://notamhub.duckdns.org';

  const TOKEN_KEY = 'tsagestor_notamhub_user_token';

  function getStoredToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (_) { return null; }
  }
  function setStoredToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token || ''); } catch (_) {}
  }
  function clearStoredToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }

  function buildHeaders() {
    const h = { 'Accept': 'application/json' };
    const t = getStoredToken();
    if (t) h['x-user-token'] = t;
    return h;
  }

  function buildUrl(path, qs) {
    const url = new URL(BASE + path, ON_REMOTE ? location.origin : 'https://notamhub.duckdns.org');
    if (qs) {
      for (const [k, v] of Object.entries(qs)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  async function _fetchJSON(path, qs, opts) {
    const url = buildUrl(path, qs);
    console.debug('[notamHub] GET', url);
    let res;
    try {
      res = await fetch(url, Object.assign({ headers: buildHeaders() }, opts || {}));
    } catch (e) {
      console.error('[notamHub] network error:', e);
      throw new Error('Red caida o CORS: ' + e.message);
    }
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      console.error('[notamHub] HTTP', res.status, body.slice(0, 500));
      let detail = '';
      try { const j = JSON.parse(body); detail = j.detail || j.error || JSON.stringify(j).slice(0, 200); }
      catch (_) { detail = body.slice(0, 200); }
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      console.error('[notamHub] respuesta no es JSON:', text.slice(0, 500));
      throw new Error('Respuesta no JSON del API: ' + text.slice(0, 100));
    }
    console.debug('[notamHub] response:', Array.isArray(data) ? `array(${data.length})` : typeof data, data);
    return data;
  }

  // ── Endpoints ──────────────────────────────────────────────────────

  // /tsas/active — TSAs activas en `at` (default = ahora). bbox =
  // "min_lat,max_lat,min_lon,max_lon". vmin/vmax = filtro altitud (ft).
  function fetchActiveTSAs(params) {
    params = params || {};
    const qs = {};
    if (params.at)   qs.at   = params.at instanceof Date ? params.at.toISOString() : params.at;
    if (params.bbox) qs.bbox = Array.isArray(params.bbox) ? params.bbox.join(',') : params.bbox;
    if (params.vmin != null) qs.vmin = params.vmin;
    if (params.vmax != null) qs.vmax = params.vmax;
    return _fetchJSON('/tsas/active', qs);
  }

  function fetchNotamsByFIR(icao, params) {
    params = params || {};
    return _fetchJSON('/notams/fir/' + encodeURIComponent(icao), {
      at: params.at,
      include_refs: params.includeRefs ? 'true' : undefined,
    });
  }

  function fetchNotamsByAerodrome(icao, params) {
    params = params || {};
    return _fetchJSON('/notams/aerodrome/' + encodeURIComponent(icao), {
      at: params.at,
      include_refs: params.includeRefs ? 'true' : undefined,
    });
  }

  function fetchBulletins() {
    return _fetchJSON('/bulletins', null);
  }

  function ping() {
    return _fetchJSON('/health', null).catch(() => false);
  }

  // ── Conversion al shape interno (state.tsas) ───────────────────────
  // El parser PDF devuelve TSAs con:
  //   { id, name, vertical: {lowerFt, upperFt, lowerLabel, upperLabel},
  //     polygon: [[lat,lng], ...], schedules: [{startUTC, endUTC}], rawBlock }
  //
  // La API entrega:
  //   { name, parent_notam_id, is_circle, bbox, vertical_lower_label,
  //     vertical_upper_label, polygon_geojson, n_schedules }
  //
  // No incluye schedules individuales — solo el count. Como solo
  // consultamos /tsas/active con un `at` concreto, sintetizamos una
  // ventana de 24h alrededor de `at` para que el resto del flujo
  // (tabla, filtros, mapa) siga funcionando.
  function convertTSAsToInternal(apiList, atDate) {
    if (!Array.isArray(apiList)) {
      console.warn('[notamHub] convertTSAs recibido NO-array:', apiList);
      return [];
    }
    const parser = window.TSAgestor && window.TSAgestor.parser;
    const parseAlt = parser && parser.parseAltitudeToken;
    const ref = atDate ? new Date(atDate) : new Date();
    const startUTC = new Date(Math.floor(ref.getTime() / 3600000) * 3600000);
    const endUTC   = new Date(startUTC.getTime() + 24 * 3600 * 1000);
    const out = [];
    const skipped = { noName: 0, badPolygon: 0 };
    for (let i = 0; i < apiList.length; i++) {
      const t = apiList[i];
      if (!t || !t.name) { skipped.noName++; continue; }
      const lower = parseAlt ? parseAlt(t.vertical_lower_label || 'GND') : { ft: 0, label: t.vertical_lower_label || 'GND' };
      const upper = parseAlt ? parseAlt(t.vertical_upper_label || 'UNL') : { ft: 99999, label: t.vertical_upper_label || 'UNL' };
      const polygon = geojsonToLatLngArray(t.polygon_geojson);
      if (!polygon || polygon.length < 3) {
        skipped.badPolygon++;
        if (skipped.badPolygon <= 3) {
          console.warn('[notamHub] TSA con poligono no parseable:', t.name,
            'polygon_geojson:', t.polygon_geojson);
        }
        continue;
      }
      out.push({
        id: 'NH_' + (t.parent_notam_id || i) + '_' + i,
        name: t.name,
        vertical: {
          lowerFt: lower.ft,
          upperFt: upper.ft,
          lowerLabel: lower.label,
          upperLabel: upper.label,
        },
        polygon,
        // El parser PDF rellena centroid via geom.centroid(polygon). El
        // corte transversal (chooseExtremes -> greatCircleDistance) lo
        // necesita; sin centroid crashea con "Cannot read properties of
        // undefined". Lo computamos aqui inline (media de lat/lon).
        centroid: polygonCentroid(polygon),
        schedules: [{ startUTC, endUTC, raw: 'NotamHub /tsas/active (24h synth)' }],
        rawBlock: `TSA ${t.name}\nNOTAM ${t.parent_notam_id || '?'}\n` +
                  `${t.vertical_lower_label} / ${t.vertical_upper_label}\n` +
                  `${t.n_schedules || 0} ventana(s) horaria(s) en el NOTAM original.`,
        _source: 'notamhub',
        _parentNotam: t.parent_notam_id,
        _nSchedules: t.n_schedules || 0,
      });
    }
    console.info(`[notamHub] convertTSAs: ${apiList.length} entrada(s), ${out.length} convertidas, ` +
                 `${skipped.noName} sin nombre, ${skipped.badPolygon} con poligono no parseable`);
    return out;
  }

  // Centroide barato del poligono (media aritmetica de lat/lon). Suficiente
  // para anclar el corte transversal y la leyenda. Si el modulo geom esta
  // cargado, lo delegamos para coherencia con las TSAs del parser PDF.
  function polygonCentroid(polygon) {
    const geomMod = window.TSAgestor && window.TSAgestor.geom;
    if (geomMod && typeof geomMod.centroid === 'function') {
      return geomMod.centroid(polygon);
    }
    if (!polygon || !polygon.length) return [0, 0];
    let lat = 0, lon = 0;
    for (const [a, b] of polygon) { lat += a; lon += b; }
    return [lat / polygon.length, lon / polygon.length];
  }

  // Acepta varios shapes posibles:
  //   { type: "Polygon", coordinates: [[[lng,lat], ...]] }   (GeoJSON spec)
  //   { type: "MultiPolygon", coordinates: [ [[[lng,lat],...]] ] }
  //   array bruto de [lng,lat] o [lat,lng] (heuristico)
  function geojsonToLatLngArray(g) {
    if (!g) return null;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates[0]) {
      return g.coordinates[0].map(p => [Number(p[1]), Number(p[0])]);
    }
    if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates[0] && g.coordinates[0][0]) {
      // Concatenamos todos los anillos exteriores en una sola lista de puntos
      // (suficiente para visualizar TSAs multiparte como bbox combinado).
      const pts = [];
      for (const poly of g.coordinates) {
        if (poly && poly[0]) for (const p of poly[0]) pts.push([Number(p[1]), Number(p[0])]);
      }
      return pts;
    }
    if (Array.isArray(g) && g.length >= 3) {
      // Heuristica: si valores absolutos del primer "x" > 90 asume [lng,lat].
      const a = g[0];
      if (Array.isArray(a) && a.length >= 2) {
        const swap = Math.abs(Number(a[0])) > 90;
        return g.map(p => swap ? [Number(p[1]), Number(p[0])] : [Number(p[0]), Number(p[1])]);
      }
    }
    return null;
  }

  return {
    BASE,
    ping,
    fetchActiveTSAs,
    fetchNotamsByFIR,
    fetchNotamsByAerodrome,
    fetchBulletins,
    convertTSAsToInternal,
    getStoredToken, setStoredToken, clearStoredToken,
  };
})();
