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

  // /tsas/active — TSAs activas. Modos:
  //   - Punto en el tiempo: pasar solo `at` (default API = ahora).
  //   - Rango: pasar `at` + `atTo`. Devuelve TSAs con al menos una
  //     ventana solapando el periodo [at, atTo].
  // bbox = "min_lat,max_lat,min_lon,max_lon"; vmin/vmax = filtro
  // altitud (ft).
  function fetchActiveTSAs(params) {
    params = params || {};
    const qs = {};
    if (params.at)   qs.at    = params.at   instanceof Date ? params.at.toISOString()   : params.at;
    if (params.atTo) qs.at_to = params.atTo instanceof Date ? params.atTo.toISOString() : params.atTo;
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

  // Normaliza un NotamOut del API al shape que consume notamView/UI:
  //   notamId, icaoLocation, fromDate, toDate, text/raw, fir/aerodrome
  // El API entrega: notam_id, section, fir, aerodrome, area, valid_from,
  // valid_to, is_estimate, is_permanent, body. Mapeamos:
  //   icaoLocation <- aerodrome || fir || area
  //   text/raw     <- body (puede ser null en NOTAMs sin cuerpo)
  function normalizeNotam(n) {
    if (!n) return null;
    const icao = n.aerodrome || n.fir || n.area || '';
    return {
      notamId:      n.notam_id || '',
      icaoLocation: String(icao).toUpperCase(),
      fromDate:     n.valid_from || null,
      toDate:       n.valid_to   || null,
      text:         n.body || '',
      raw:          n.body || '',
      _source:      'notamhub',
      _section:     n.section || '',
      _isEstimate:  !!n.is_estimate,
      _isPermanent: !!n.is_permanent,
    };
  }

  // Pide a NotamHub todos los NOTAMs relevantes para una lista de
  // ICAOs. La API es punto-a-punto: /notams/aerodrome/{icao} y
  // /notams/fir/{icao}, asi que disparamos N requests en paralelo y
  // unimos los resultados.
  // Distingue aerodromos (LE??, GC??) de FIRs (LECM, LECB, GCCC,
  // LPPC, ...). Si una request falla (404, timeout) la trata como
  // vacia y sigue con el resto, asi nunca rompe el resto.
  async function fetchAllNotamsFor(icaos, opts) {
    if (!Array.isArray(icaos) || !icaos.length) return [];
    opts = opts || {};
    const at = opts.at instanceof Date ? opts.at.toISOString() : opts.at;
    const FIR_RE = /^(LECM|LECB|LPPC|GCCC|GMMM|LFFF|LFMM|EGTT|DAAA)$/;
    const calls = icaos.map(icao => {
      const code = String(icao || '').trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return Promise.resolve([]);
      const isFir = FIR_RE.test(code);
      const p = isFir
        ? fetchNotamsByFIR(code, { at })
        : fetchNotamsByAerodrome(code, { at });
      return p.catch(e => {
        console.warn('[notamHub] fetchNotams', code, 'fallo:', e && e.message || e);
        return [];
      });
    });
    const results = await Promise.all(calls);
    const out = [];
    for (const arr of results) {
      if (!Array.isArray(arr)) continue;
      for (const n of arr) {
        const norm = normalizeNotam(n);
        if (norm) out.push(norm);
      }
    }
    console.info(`[notamHub] fetchAllNotamsFor: ${icaos.length} ICAOs -> ${out.length} NOTAMs`);
    return out;
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
    const out = [];
    const skipped = { noName: 0, badPolygon: 0, noSchedules: 0 };
    let synthCount = 0;

    // Diagnostico is_work_area: cuenta true/false/undefined/otros y
    // decide si el campo es fiable.
    //   - Si hay >=1 false -> el campo discrimina, lo usamos como API dice.
    //   - Si TODAS son true (y count > 0) -> el API tiene un default fijo
    //     y el campo no discrimina. Activamos heuristica por nombre
    //     (PASILLO/CORREDOR -> transito, resto -> trabajo).
    //   - Si todas undefined -> mismo fallback heuristico.
    let useNameHeuristic = false;
    if (apiList.length > 0) {
      const wHist = { true: 0, false: 0, undefined: 0 };
      for (const t of apiList) {
        if (typeof t.is_work_area === 'boolean') wHist[String(t.is_work_area)]++;
        else wHist.undefined++;
      }
      const fieldDiscriminates = wHist.true > 0 && wHist.false > 0;
      useNameHeuristic = !fieldDiscriminates;
      console.info('[notamHub] is_work_area distribucion: ' + JSON.stringify(wHist) +
        (useNameHeuristic
          ? ' · campo no discrimina, usando heuristica nombre (CORREDOR/PASILLO -> transito)'
          : ' · campo OK del API'));
    }
    for (let i = 0; i < apiList.length; i++) {
      const t = apiList[i];
      if (!t || !t.name) { skipped.noName++; continue; }

      // Altitudes: la API entrega numericos (vertical_lower_ft /
      // vertical_upper_ft) ademas de los labels. Preferimos numericos;
      // fallback a parsing del label por si vienen vacios.
      let lowerFt, upperFt, lowerLabel, upperLabel;
      if (Number.isFinite(t.vertical_lower_ft)) {
        lowerFt = t.vertical_lower_ft;
        lowerLabel = t.vertical_lower_label || (lowerFt === 0 ? 'GND' : `${lowerFt}FT`);
      } else {
        const p = parseAlt ? parseAlt(t.vertical_lower_label || 'GND') : { ft: 0, label: 'GND' };
        lowerFt = p.ft; lowerLabel = p.label;
      }
      if (Number.isFinite(t.vertical_upper_ft)) {
        upperFt = t.vertical_upper_ft;
        upperLabel = t.vertical_upper_label || (upperFt >= 60000 ? 'UNL' : `${upperFt}FT`);
      } else {
        const p = parseAlt ? parseAlt(t.vertical_upper_label || 'UNL') : { ft: 99999, label: 'UNL' };
        upperFt = p.ft; upperLabel = p.label;
      }

      // Poligono: preferimos polygon_geojson; si la TSA es circular y
      // viene con circle_center_*/circle_radius_nm, generamos el anillo.
      let polygon = geojsonToLatLngArray(t.polygon_geojson);
      if ((!polygon || polygon.length < 3) && t.is_circle &&
          Number.isFinite(t.circle_center_lat) &&
          Number.isFinite(t.circle_center_lon) &&
          Number.isFinite(t.circle_radius_nm)) {
        polygon = circleToPolygon(t.circle_center_lat, t.circle_center_lon, t.circle_radius_nm);
      }
      if (!polygon || polygon.length < 3) {
        skipped.badPolygon++;
        if (skipped.badPolygon <= 3) {
          console.warn('[notamHub] TSA con poligono no parseable:', t.name,
            'polygon_geojson:', t.polygon_geojson, 'is_circle:', t.is_circle);
        }
        continue;
      }

      // Schedules: la API entrega ahora un array de TsaWindow con
      // start/end (ISO UTC) + raw. Convertimos a Date. Si por lo que
      // sea viene vacio, sintetizamos una ventana de 24h alrededor de
      // `atDate` como fallback para que la tabla y filtros no rompan.
      // Dedup INTRA-array por start+end por si la API repite ventanas
      // (visto en ICARO XXI: a veces la misma ventana aparece varias
      // veces si vino en >1 NOTAM padre).
      let schedules = [];
      if (Array.isArray(t.schedules) && t.schedules.length > 0) {
        const seenInner = new Set();
        schedules = t.schedules
          .map(w => ({
            startUTC: new Date(w.start),
            endUTC:   new Date(w.end),
            raw:      w.raw || `${w.start} / ${w.end}`,
          }))
          .filter(w => !isNaN(w.startUTC.getTime()) && !isNaN(w.endUTC.getTime()))
          .filter(w => {
            const sig = w.startUTC.getTime() + '-' + w.endUTC.getTime();
            if (seenInner.has(sig)) return false;
            seenInner.add(sig);
            return true;
          });
      }
      if (!schedules.length) {
        synthCount++;
        const ref = atDate ? new Date(atDate) : new Date();
        const startUTC = new Date(Math.floor(ref.getTime() / 3600000) * 3600000);
        const endUTC   = new Date(startUTC.getTime() + 24 * 3600 * 1000);
        schedules = [{ startUTC, endUTC, raw: 'sintético 24h (API sin schedules)' }];
      }

      out.push({
        id: 'NH_' + (t.parent_notam_id || i) + '_' + i,
        name: t.name,
        format: 'NOTAMHUB',
        vertical: { lowerFt, upperFt, lowerLabel, upperLabel },
        polygon,
        // El parser PDF rellena centroid via geom.centroid(polygon). El
        // corte transversal (chooseExtremes -> greatCircleDistance) lo
        // necesita; sin centroid crashea con "Cannot read properties of
        // undefined".
        centroid: polygonCentroid(polygon),
        schedules,
        rawBlock: `TSA ${t.name}\nNOTAM ${t.parent_notam_id || '?'}\n` +
                  `${lowerLabel} / ${upperLabel}\n` +
                  `${schedules.length} ventana(s) horaria(s).`,
        _source: 'notamhub',
        _parentNotam: t.parent_notam_id,
        _nSchedules: schedules.length,
        _isCircle: !!t.is_circle,
        // is_work_area:
        //   - Si el API lo discrimina (mix de true/false) -> lo usamos.
        //   - Si el API manda todo true o todo undefined ->
        //     heuristica por nombre: PASILLO/CORREDOR -> transito,
        //     resto -> trabajo. Coincide con la convencion del
        //     boletin ICARO XXI verificada con el PDF.
        _isWorkArea: useNameHeuristic
          ? !/\b(PASILLO|CORREDOR|CORRIDOR|TRANSITO|TRANSIT)\b/i.test(t.name || '')
          : (t.is_work_area === true),
      });
    }

    // Dedup por (name + vertical). La API a veces devuelve la misma TSA
    // varias veces (uno por cada NOTAM padre que la publica con ventana
    // distinta). Las fusionamos en una sola TSA con la UNION de
    // schedules. Asi quedan filas unicas en la tabla en vez de
    // "TSA CORREDOR SUR 1 LOW" repetida x2.
    const dedupMap = new Map();
    let mergedCount = 0;
    for (const t of out) {
      const key = t.name + '||' + t.vertical.lowerLabel + '||' + t.vertical.upperLabel;
      if (!dedupMap.has(key)) {
        dedupMap.set(key, Object.assign({}, t, { schedules: t.schedules.slice() }));
        continue;
      }
      const ex = dedupMap.get(key);
      // Set de schedules ya vistos (start+end ms) para no duplicar.
      const seen = new Set(ex.schedules.map(s =>
        (s.startUTC instanceof Date ? s.startUTC.getTime() : Date.parse(s.startUTC)) + '-' +
        (s.endUTC   instanceof Date ? s.endUTC.getTime()   : Date.parse(s.endUTC))
      ));
      for (const s of t.schedules) {
        const sa = s.startUTC instanceof Date ? s.startUTC.getTime() : Date.parse(s.startUTC);
        const sb = s.endUTC   instanceof Date ? s.endUTC.getTime()   : Date.parse(s.endUTC);
        const sig = sa + '-' + sb;
        if (!seen.has(sig)) { ex.schedules.push(s); seen.add(sig); }
      }
      // Lista de parent_notam_ids acumulados para diagnostico.
      if (t._parentNotam) {
        const cur = String(ex._parentNotam || '').split(',').filter(Boolean);
        if (!cur.includes(t._parentNotam)) cur.push(t._parentNotam);
        ex._parentNotam = cur.join(',');
      }
      // is_work_area: si CUALQUIERA de las entradas fusionadas es work,
      // la marcamos como work. Conservador: una TSA usada por militares
      // en algun NOTAM se considera area de trabajo siempre.
      if (t._isWorkArea) ex._isWorkArea = true;
      ex._nSchedules = ex.schedules.length;
      mergedCount++;
    }
    // Ordena las schedules de cada TSA por start asc.
    const dedupedOut = [];
    for (const t of dedupMap.values()) {
      t.schedules.sort((a, b) => {
        const sa = a.startUTC instanceof Date ? a.startUTC.getTime() : Date.parse(a.startUTC);
        const sb = b.startUTC instanceof Date ? b.startUTC.getTime() : Date.parse(b.startUTC);
        return sa - sb;
      });
      dedupedOut.push(t);
    }
    console.info(`[notamHub] convertTSAs: ${apiList.length} entrada(s) → ${dedupedOut.length} TSAs ` +
                 `(${mergedCount} fusionadas por name+vertical) · ${skipped.noName} sin nombre · ` +
                 `${skipped.badPolygon} sin poligono · ${synthCount} con schedules sintetizados`);
    return dedupedOut;
  }

  // Convierte un circulo (centro lat/lon, radio NM) en un anillo de N
  // puntos para visualizar el poligono. Aproximacion plana suficiente
  // para radios tipicos de TSA (<100 NM): 1 NM ≈ 1/60° latitud, y la
  // longitud se compensa con cos(lat).
  function circleToPolygon(lat, lon, radiusNM, points) {
    const n = Math.max(8, points || 32);
    const cosLat = Math.max(0.01, Math.cos(lat * Math.PI / 180));
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      const dLat = (radiusNM / 60) * Math.cos(a);
      const dLon = (radiusNM / 60) * Math.sin(a) / cosLat;
      out.push([lat + dLat, lon + dLon]);
    }
    out.push(out[0]);   // cierra el anillo
    return out;
  }

  // Intenta extraer un bbox util de los campos crudos de Autorouter:
  //   nelat, nelon, swlat, swlon (escalados x10^7 igual que lat/lon)
  // Devuelve { minLat, maxLat, minLng, maxLng } si los cuatro existen y
  // el extent es razonable (< 5 grados en cada eje, ~300 NM). Para los
  // TRIGGER NOTAMs el bbox suele ser gigante (todo el Atlantico) -> lo
  // descartamos para no pintar un poligono inutil.
  function tryBboxFromAutorouter(n) {
    if (!n) return null;
    const unscale = (v) => {
      const x = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(x)) return null;
      return Math.abs(x) > 360 ? x / 1e7 : x;
    };
    const nelat = unscale(n.nelat);
    const nelon = unscale(n.nelon);
    const swlat = unscale(n.swlat);
    const swlon = unscale(n.swlon);
    if (nelat == null || nelon == null || swlat == null || swlon == null) return null;
    const minLat = Math.min(nelat, swlat);
    const maxLat = Math.max(nelat, swlat);
    const minLng = Math.min(nelon, swlon);
    const maxLng = Math.max(nelon, swlon);
    const dLat = maxLat - minLat;
    const dLng = maxLng - minLng;
    // Bbox demasiado grande -> probable placeholder FIR-wide. Descarta.
    if (dLat <= 0 || dLng <= 0) return null;
    if (dLat > 5 || dLng > 5) return null;
    return { minLat, maxLat, minLng, maxLng };
  }

  // Extrae el contenido de un campo NOTAM (E, F, G) del raw text.
  function notamField(raw, letter) {
    if (!raw) return '';
    const re = new RegExp(`${letter}\\)\\s*([\\s\\S]*?)(?=\\s+[A-Z]\\)|$)`, 'i');
    const m = String(raw).match(re);
    return m ? m[1].trim() : '';
  }

  // Clasificacion del NOTAM para decidir si es "area" (algo que merezca
  // dibujarse en el mapa como zona segregada). Usa varias heuristicas:
  //   1) Q-code subject: R<x> = areas restringidas/peligrosas/temporales/
  //      prohibidas/airspace (QRRCA = restricted activated, QRTCA = TSA
  //      activated, QRDCA = danger area activated, etc.) Estos son
  //      MILITARES o de espacio aereo segregado en LPPC, LECM, etc.
  //   2) ID M-series (Spanish military): M0833/26, M0934/26, ...
  //   3) Keywords en texto: AREA, CORRIDOR, TRA, TSA, MIL OPS, EXERCISE,
  //      RESTRICTED/DANGER/PROHIBITED AREA, LPR/LPD/LPT prefix.
  // Devuelve 'area' | 'area-mil' | null.
  function classifyAsArea(notam) {
    const id = notam.notamId || notam.id || '';
    const raw = String(notam.text || notam.raw || '');
    const q = raw.match(/Q\)\s*[A-Z]{4}\/Q([A-Z]{2})([A-Z]{2})\//);
    if (q) {
      const subj = q[1];   // RR/RD/RT/RP/RA/RM/WL/...
      // Categorias de espacio aereo activado / cambiado / fuera de servicio
      if (/^R[RDTPAM]$/.test(subj)) return 'area-mil';
      // Warnings (W_) -> a veces traen poligonos
      if (/^W[BLMRPSV]$/.test(subj)) return 'area';
    }
    if (/^M\d/.test(id)) return 'area-mil';
    if (/\bLP[RDT]\d+\b/i.test(raw)) return 'area-mil';  // areas portuguesas
    if (/\b(MIL\s+OPS|MILITARY\s+EXERCISE|TRG\s+AREA|TRAINING\s+AREA|EXERCISE\s+AREA)\b/i.test(raw)) return 'area-mil';
    // Patrones LPPC operativos:
    //   "EXC CONTROLLED AIRSPACE" / "EXCLUDING CONTROLLED AIRSPACE":
    //     activacion que segrega un area dejando fuera el CTA -> TSA
    //     militar.
    //   "TITAN SKY": area de ejercicio aereo militar portugues -> TSA.
    if (/\bEXC(?:LUDING)?\s+CONTROLLED\s+AIRSPACE\b/i.test(raw)) {
      return 'area-mil';
    }
    if (/\bTITAN\s+SKY\b/i.test(raw)) {
      return 'area-mil';
    }
    if (/\b(AREA|CORRIDOR|CORREDOR|TRA|TSA|TEMPORARY\s+RESERVED|RESTRICTED\s+AREA|DANGER\s+AREA|PROHIBITED\s+AREA)\b/i.test(raw)) return 'area';
    return null;
  }

  // Convierte NOTAMs de Autorouter (formato ICAO) en objetos TSA-like
  // para anyadirlos a state.tsas. Procesa los que classifyAsArea
  // identifica como zona segregable. La geometria sale del cuerpo si
  // tiene coords, o del Q-line (centro+radio) como fallback robusto
  // para NOTAMs militares que solo referencian el area por su id.
  function convertAutorouterNotamsToTSAs(notams, opts) {
    const meteo = window.TSAgestor && window.TSAgestor.meteoApi;
    const parser = window.TSAgestor && window.TSAgestor.parser;
    if (!meteo || !meteo.parseNotamGeometry) {
      console.warn('[notamHub] meteoApi.parseNotamGeometry no disponible');
      return [];
    }
    const parseAlt = parser && parser.parseAltitudeToken;
    const labelPrefix = (opts && opts.namePrefix) || '';
    const onlyMilitary = !!(opts && opts.onlyMilitary);

    // ── DIAGNOSTICO PREVIO ──────────────────────────────────────────
    // Antes de filtrar, hacemos histograma de Q-codes y series. Asi
    // sabemos que tipos de NOTAM trae el origen y donde estan los
    // militares. CLAVE para LPPC: si no hay R* en el histograma es
    // que Autorouter no devuelve NOTAMs de espacio aereo, solo de
    // aerodromos.
    if (Array.isArray(notams) && notams.length) {
      const qHist = {};
      const idHist = {};
      const samples = {};
      for (const n of notams) {
        const raw = String(n.text || n.raw || '');
        const id  = String(n.notamId || n.id || '');
        const series = id.slice(0, 1);
        idHist[series] = (idHist[series] || 0) + 1;
        const m = raw.match(/Q\)\s*[A-Z]{4}\/Q([A-Z]{2})([A-Z]{2})\//);
        if (m) {
          const subj = m[1];
          qHist[subj] = (qHist[subj] || 0) + 1;
          if (!samples[subj]) samples[subj] = { id, body: raw.slice(0, 180) };
        } else {
          qHist['__noQ'] = (qHist['__noQ'] || 0) + 1;
        }
      }
      // JSON.stringify para que se vean los counts directamente en
      // consola en lugar del "Object" colapsado.
      console.info('[notamHub] LPPC histogram Q-subject: ' + JSON.stringify(qHist));
      console.info('[notamHub] LPPC histogram id-series: ' + JSON.stringify(idHist));
      // Muestra completa del primer NOTAM tal cual llega (claves
      // reales que devuelve Autorouter) — fundamental para diagnosticar
      // por que icaoLocation va a 0 en todos.
      console.warn('[notamHub] LPPC primer NOTAM (claves reales):', Object.keys(notams[0] || {}));
      console.warn('[notamHub] LPPC primer NOTAM completo:',
        JSON.parse(JSON.stringify(notams[0] || {})));
      console.debug('[notamHub] LPPC samples por Q-subject:', samples);
    }

    // Pre-scan: lista todos los NOTAMs cuyo cuerpo contiene
    // "EXC CONTROLLED AIRSPACE" para que el usuario pueda comprobar
    // cuantos hay independientemente de si otra regla los clasificara
    // antes. Solo log informativo, no afecta al pipeline.
    const excList = [];
    for (const n of (notams || [])) {
      const raw = String(n && (n.text || n.raw) || '');
      if (/\bEXC(?:LUDING)?\s+CONTROLLED\s+AIRSPACE\b/i.test(raw)) {
        excList.push({
          id: n.notamId || n.id || '?',
          snippet: raw.replace(/\s+/g, ' ').slice(0, 160),
        });
      }
    }
    console.info(`[notamHub] LPPC NOTAMs con "EXC CONTROLLED AIRSPACE": ${excList.length}`);
    if (excList.length) console.table(excList);

    const out = [];
    const stats = { total: 0, area: 0, mil: 0, polyOk: 0, polyFail: 0, notArea: 0, sourceQline: 0, sourceBody: 0 };
    const sampleSkipped = [];
    for (let i = 0; i < (notams || []).length; i++) {
      const n = notams[i];
      const raw = String(n.text || n.raw || '');
      const id  = n.notamId || n.id || '';
      stats.total++;
      const cls = classifyAsArea(n);
      if (!cls) {
        stats.notArea++;
        if (sampleSkipped.length < 3) sampleSkipped.push({ id, body: raw.slice(0, 120) });
        continue;
      }
      if (onlyMilitary && cls !== 'area-mil') {
        stats.notArea++;
        continue;
      }
      if (cls === 'area-mil') stats.mil++; else stats.area++;
      // Geometria: SOLO aceptamos AREAS reales (poligonos con vertices
      // explicitos). No dibujamos puntos ni circulos: los Q-line
      // circles tienden a ser FIR-wide o un fix de referencia, no el
      // area real, asi que mejor descartar que dibujar algo enganyoso.
      // Orden:
      //   1) bbox compacto de Autorouter (nelat/nelon/swlat/swlon)
      //      -> rectangulo de 4 vertices.
      //   2) poligono explicito en el cuerpo del NOTAM (WI N4040 ...)
      //   Si solo hay circulo (Q-line center+radius), descartamos.
      let polygon = null;
      let geomSource = '';
      const bbox = tryBboxFromAutorouter(n);
      if (bbox) {
        polygon = [
          [bbox.minLat, bbox.minLng],
          [bbox.minLat, bbox.maxLng],
          [bbox.maxLat, bbox.maxLng],
          [bbox.maxLat, bbox.minLng],
          [bbox.minLat, bbox.minLng],
        ];
        geomSource = 'bbox';
        stats.sourceBody++;
      }
      if (!polygon) {
        const geom = meteo.parseNotamGeometry(raw);
        if (geom && geom.kind === 'poly') {
          polygon = geom.latlngs;
          geomSource = geom.source || 'body-poly';
          stats.sourceBody++;
        }
        // geom.kind === 'circle' se IGNORA a proposito: no son areas.
      }
      if (!polygon || polygon.length < 3) {
        stats.polyFail++;
        if (stats.polyFail <= 3) {
          console.warn('[notamHub] NOTAM sin area (poligono) - descartado:', id, raw.slice(0, 200));
        }
        continue;
      }
      stats.polyOk++;
      const fF = notamField(raw, 'F');
      const fG = notamField(raw, 'G');
      const lower = (fF && parseAlt) ? parseAlt(fF) : { ft: 0, label: 'GND' };
      const upper = (fG && parseAlt) ? parseAlt(fG) : { ft: 99999, label: 'UNL' };
      const startUTC = new Date(n.fromDate || n.startValidity || Date.now());
      const endUTC   = new Date(n.toDate   || n.endValidity   || (Date.now() + 24 * 3600 * 1000));
      const body = notamField(raw, 'E');
      const summary = body.split('\n')[0].slice(0, 60);
      const name = (labelPrefix ? labelPrefix + ' ' : '') + id + (summary ? ' — ' + summary : '');
      out.push({
        id: 'AR_' + id + '_' + i,
        name,
        format: cls === 'area-mil' ? 'NOTAM-MIL' : 'NOTAM-AREA',
        vertical: {
          lowerFt: lower.ft, upperFt: upper.ft,
          lowerLabel: lower.label, upperLabel: upper.label,
        },
        polygon,
        centroid: polygonCentroid(polygon),
        schedules: [{
          startUTC, endUTC,
          raw: `${n.fromDate || '?'} → ${n.toDate || 'PERM'}`,
        }],
        rawBlock: raw,
        _source: 'autorouter',
        _parentNotam: id,
        _icaoLocation: n.icaoLocation || '',
        _areaKind: cls,
        _geomSource: geomSource,
      });
    }
    console.info(`[notamHub] Autorouter→TSAs: ${stats.total} entradas · ` +
                 `${out.length} convertidas (${stats.mil} mil + ${stats.area - stats.mil > 0 ? stats.area - stats.mil : 0} otras) · ` +
                 `${stats.polyFail} sin geometria · ${stats.notArea} no son area · ` +
                 `geom: ${stats.sourceBody} body / ${stats.sourceQline} Q-line`);
    if (sampleSkipped.length) {
      console.debug('[notamHub] NOTAMs no clasificados como area (muestra):', sampleSkipped);
    }
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
    convertAutorouterNotamsToTSAs,
    fetchAllNotamsFor, normalizeNotam,
    getStoredToken, setStoredToken, clearStoredToken,
  };
})();
