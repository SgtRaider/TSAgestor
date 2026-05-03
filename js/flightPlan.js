// Generador de planes de vuelo sobre el grafo de aerovías (demo).
//
// Construye un grafo no dirigido con los waypoints publicados en airways.js
// y aplica Dijkstra entre origen y destino. Si no hay ruta o resulta
// claramente peor que la directa, devuelve la directa (DCT).
//
// Detecta conflictos contra las TSAs visibles: solapamiento lateral del
// segmento con el polígono, intersección de altitudes y solapamiento
// temporal entre la ventana de la TSA y la hora estimada de paso.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.flightPlan = (function () {
  'use strict';

  const geom = window.TSAgestor.geom;
  const NM_KM = 1.852;

  function awMod() { return window.TSAgestor.airways; }

  function coordKey(pt) {
    return pt[0].toFixed(4) + ',' + pt[1].toFixed(4);
  }

  // Cache de grafo por filtro: la clave es 'U', 'L', 'UL' o '' (sin filtros).
  // Los conectores DCT virtuales aeropuerto-fix SIEMPRE se incluyen — sin
  // ellos, los aeropuertos no entran en la red y todas las rutas degeneran
  // a DCT directo, anulando el efecto de seleccionar aerovias.
  const _graphCache = new Map();

  function graph(filter) {
    filter = filter || { upper: true, lower: true };
    const key = (filter.upper ? 'U' : '') + (filter.lower ? 'L' : '');
    if (_graphCache.has(key)) return _graphCache.get(key);

    const aw = awMod();
    const nodes = new Map();
    const wpByKey = new Map();
    for (const [name, pt] of Object.entries(aw.waypoints)) {
      wpByKey.set(coordKey(pt), name);
    }
    function ensure(pt) {
      const k = coordKey(pt);
      if (!nodes.has(k)) {
        nodes.set(k, {
          key: k, lat: pt[0], lon: pt[1],
          name: wpByKey.get(k) || null,
          neighbors: [],
        });
      }
      return nodes.get(k);
    }
    function addAirway(rt, type) {
      for (let i = 0; i < rt.points.length - 1; i++) {
        const a = ensure(rt.points[i]);
        const b = ensure(rt.points[i + 1]);
        const d = geom.greatCircleDistance([a.lat, a.lon], [b.lat, b.lon]);
        a.neighbors.push({ to: b.key, dist: d, airway: rt.name, type });
        b.neighbors.push({ to: a.key, dist: d, airway: rt.name, type });
      }
    }

    // Upper: solo si el overlay esta activado.
    if (filter.upper) {
      for (const r of (aw.upper || [])) {
        if (r.name === 'DCT') continue;          // los DCT viven en lower
        addAirway(r, 'upper');
      }
    }
    // Lower y conectores DCT siempre van: sin DCTs, los aeropuertos no
    // entran en el grafo. Los segmentos lower no-DCT solo si esta activado.
    for (const r of (aw.lower || [])) {
      if (r.name === 'DCT') {
        addAirway(r, 'lower');                   // siempre
      } else if (filter.lower) {
        addAirway(r, 'lower');
      }
    }

    const g = { nodes, wpByKey };
    _graphCache.set(key, g);
    return g;
  }

  function listWaypoints() {
    return Object.keys(awMod().waypoints).sort();
  }

  function findWP(name) {
    if (!name) return null;
    const key = String(name).trim().toUpperCase();
    const pt = awMod().waypoints[key];
    if (!pt) return null;
    return { name: key, lat: pt[0], lon: pt[1] };
  }

  // Resuelve un token de la cadena "Vía": código de waypoint, "lat,lon",
  // o un objeto ya resuelto {name, lat, lon}.
  function parseViaToken(token) {
    if (!token) return null;
    if (typeof token === 'object' && Number.isFinite(token.lat) && Number.isFinite(token.lon)) {
      return {
        name: token.name || (token.lat.toFixed(3) + ',' + token.lon.toFixed(3)),
        lat: token.lat,
        lon: token.lon,
      };
    }
    const t = String(token).trim();
    if (!t) return null;
    const wp = findWP(t);
    if (wp) return wp;
    const parts = t.split(',').map(p => p.trim());
    if (parts.length === 2) {
      const lat = Number(parts[0]);
      const lon = Number(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon) &&
          lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        return { name: lat.toFixed(3) + ',' + lon.toFixed(3), lat, lon };
      }
    }
    return { error: t };
  }

  // Devuelve la primera TSA cuyo polígono contiene el punto (lateral),
  // o null si ninguna lo contiene.
  function findTSAContaining(latlon, tsas) {
    if (!tsas) return null;
    for (const tsa of tsas) {
      if (pointInPoly(latlon, tsa.polygon)) return tsa;
    }
    return null;
  }

  // El vuelo cruza la TSA, manteniéndose DENTRO de su banda vertical con
  // un buffer de 500 ft respecto al techo y al suelo. Si el FL inicial ya
  // cae en la banda permitida lo conserva; si no, lo recorta al extremo
  // más cercano. FLs en pasos de 500 ft (FL005).
  function adjustFLForTSA(initialFL, tsa) {
    if (!tsa || !tsa.vertical) return initialFL;
    const lowerFt = tsa.vertical.lowerFt;
    const upperFt = tsa.vertical.upperFt;
    let flMin = Math.ceil((lowerFt + 500) / 500) * 5;
    let flMax = Math.floor((upperFt - 500) / 500) * 5;
    if (flMax < flMin) {
      // TSA demasiado fina (≤1000 ft): aplicamos sólo la banda sin buffer.
      flMin = Math.ceil(lowerFt / 500) * 5;
      flMax = Math.floor(upperFt / 500) * 5;
      if (flMax < flMin) return Math.round((lowerFt + upperFt) / 1000) * 5;
    }
    if (initialFL < flMin) return flMin;
    if (initialFL > flMax) return flMax;
    return initialFL;
  }

  // Enriquece un waypoint con TSA contenedora y FL ajustado.
  // Si el waypoint era un genérico "lat,lon", adopta el nombre de la TSA.
  function enrichWaypoint(pt, tsas, initialFL) {
    const tsa = findTSAContaining([pt.lat, pt.lon], tsas);
    const isGenericName = !pt.name || /^-?\d+\.\d+,-?\d+\.\d+$/.test(pt.name);
    if (tsa) {
      return {
        name: isGenericName ? tsa.name : pt.name,
        lat: pt.lat,
        lon: pt.lon,
        tsa,
        fl: adjustFLForTSA(initialFL, tsa),
      };
    }
    return {
      name: pt.name || (pt.lat.toFixed(3) + ',' + pt.lon.toFixed(3)),
      lat: pt.lat,
      lon: pt.lon,
      tsa: null,
      fl: initialFL,
    };
  }

  // Recorre los segmentos de la ruta y aplica enrichWaypoint a cada extremo.
  function annotateRouteWithFL(route, tsas, initialFL) {
    if (!route || !route.segments || !route.segments.length) return route;
    const seq = [route.segments[0].from].concat(route.segments.map(s => s.to));
    const enriched = seq.map(p => enrichWaypoint(p, tsas, initialFL));
    for (let i = 0; i < route.segments.length; i++) {
      route.segments[i].from = enriched[i];
      route.segments[i].to   = enriched[i + 1];
      route.segments[i].fl   = enriched[i].fl;
    }
    return route;
  }

  // Ruta manual: enlaza origen → vías → destino con tramos DCT.
  function buildManualRoute(origin, viaList, destination) {
    const points = [origin].concat(viaList).concat([destination]);
    const segments = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const d = geom.greatCircleDistance([a.lat, a.lon], [b.lat, b.lon]);
      total += d;
      segments.push({
        from: { name: a.name, lat: a.lat, lon: a.lon },
        to:   { name: b.name, lat: b.lat, lon: b.lon },
        airway: 'DCT',
        type: null,
        dist: d,
      });
    }
    return { segments, totalDistKm: total, direct: false, manual: true };
  }

  // Concatena rutas Dijkstra entre cada par consecutivo de puntos
  // (origen, via1, via2, ..., destino). Cada leg trae sus propios fixes
  // intermedios via aerovias.
  function buildAirwayRouteVia(origin, viaList, destination, fl, filter) {
    const points = [origin].concat(viaList).concat([destination]);
    const allSegments = [];
    let totalDistKm = 0;
    let anyManual = false;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      // Si los dos extremos son el mismo punto, lo saltamos.
      if (a.lat === b.lat && a.lon === b.lon) continue;
      const leg = findRoute(a, b, fl, filter);
      if (leg && leg.segments && leg.segments.length) {
        for (const seg of leg.segments) allSegments.push(seg);
        totalDistKm += leg.totalDistKm || 0;
        if (leg.direct) anyManual = true;
      } else {
        // Fallback DCT directo si findRoute no devuelve nada utilizable.
        const d = geom.greatCircleDistance([a.lat, a.lon], [b.lat, b.lon]);
        allSegments.push({
          from: { name: a.name, lat: a.lat, lon: a.lon },
          to:   { name: b.name, lat: b.lat, lon: b.lon },
          airway: 'DCT', type: null, dist: d,
        });
        totalDistKm += d;
        anyManual = true;
      }
    }
    return { segments: allSegments, totalDistKm, direct: anyManual, manual: false };
  }

  function directRouteOf(origin, destination) {
    const d = geom.greatCircleDistance(
      [origin.lat, origin.lon], [destination.lat, destination.lon]
    );
    return {
      direct: true,
      totalDistKm: d,
      segments: [{
        from: { name: origin.name, lat: origin.lat, lon: origin.lon },
        to:   { name: destination.name, lat: destination.lat, lon: destination.lon },
        airway: 'DCT',
        type: null,
        dist: d,
      }],
    };
  }

  // Dijkstra. Penaliza usar la cota equivocada para el FL elegido.
  // filter: { upper: bool, lower: bool } controla que aerovias entran en el grafo.
  function findRoute(origin, destination, flightLevel, filter) {
    const g = graph(filter);
    const oKey = coordKey([origin.lat, origin.lon]);
    const dKey = coordKey([destination.lat, destination.lon]);
    const direct = directRouteOf(origin, destination);
    if (!g.nodes.has(oKey) || !g.nodes.has(dKey)) return direct;

    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    for (const k of g.nodes.keys()) dist.set(k, Infinity);
    dist.set(oKey, 0);

    while (true) {
      let curKey = null, curDist = Infinity;
      for (const [k, d] of dist) {
        if (!visited.has(k) && d < curDist) { curDist = d; curKey = k; }
      }
      if (curKey === null || curDist === Infinity) break;
      if (curKey === dKey) break;
      visited.add(curKey);
      const node = g.nodes.get(curKey);
      for (const edge of node.neighbors) {
        if (visited.has(edge.to)) continue;
        let cost = edge.dist;
        if (flightLevel >= 245 && edge.type === 'lower') cost *= 1.5;
        else if (flightLevel < 195 && edge.type === 'upper') cost *= 1.5;
        const nd = curDist + cost;
        if (nd < dist.get(edge.to)) {
          dist.set(edge.to, nd);
          prev.set(edge.to, { from: curKey, edge });
        }
      }
    }

    if (!prev.has(dKey)) return direct;

    const segments = [];
    let cur = dKey;
    while (prev.has(cur)) {
      const { from, edge } = prev.get(cur);
      const a = g.nodes.get(from), b = g.nodes.get(cur);
      segments.unshift({
        from: { name: a.name, lat: a.lat, lon: a.lon },
        to:   { name: b.name, lat: b.lat, lon: b.lon },
        airway: edge.airway,
        type: edge.type,
        dist: edge.dist,
      });
      cur = from;
    }
    const totalDistKm = segments.reduce((s, x) => s + x.dist, 0);
    if (totalDistKm > direct.totalDistKm * 1.6) return direct;
    return { segments, totalDistKm, direct: false };
  }

  function buildCoords(route, departureUTC, speedKt) {
    if (!route.segments.length) return [];
    const out = [];
    let cumKm = 0;
    const first = route.segments[0].from;
    out.push({
      name: first.name || '—',
      lat: first.lat,
      lon: first.lon,
      cumDistKm: 0,
      cumDistNM: 0,
      legDistKm: 0,
      airway: '—',
      fl: first.fl != null ? first.fl : null,
      tsa: first.tsa || null,
      etaUTC: new Date(departureUTC.getTime()),
    });
    for (const seg of route.segments) {
      cumKm += seg.dist;
      const cumNM = cumKm / NM_KM;
      const tMin = (cumNM / speedKt) * 60;
      out.push({
        name: seg.to.name || formatLatLon(seg.to.lat, seg.to.lon),
        lat: seg.to.lat,
        lon: seg.to.lon,
        cumDistKm: cumKm,
        cumDistNM: cumNM,
        legDistKm: seg.dist,
        airway: seg.airway,
        fl: seg.to.fl != null ? seg.to.fl : null,
        tsa: seg.to.tsa || null,
        etaUTC: new Date(departureUTC.getTime() + tMin * 60 * 1000),
      });
    }
    return out;
  }

  function formatLatLon(lat, lon) {
    return formatDeg(lat, 'N', 'S', false) + formatDeg(lon, 'E', 'W', true);
  }
  function formatDeg(v, pos, neg, isLon) {
    const sign = v >= 0 ? pos : neg;
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.round((a - d) * 60);
    return String(d).padStart(isLon ? 3 : 2, '0') + String(m).padStart(2, '0') + sign;
  }

  // Coordenadas en formato OACI corto para FPL (campo 15):
  //   lat 40.49, lon -3.57 → 4029N00334W
  //   (DDMM[N|S] + DDDMM[E|W], grados y minutos enteros)
  function formatICAOCoord(lat, lon) {
    const fmt = (v, deg, pos, neg) => {
      const sign = v >= 0 ? pos : neg;
      const a = Math.abs(v);
      const d = Math.floor(a);
      const m = Math.round((a - d) * 60);
      // Si los minutos redondean a 60, normalizamos (raro pero posible).
      const dd = m === 60 ? d + 1 : d;
      const mm = m === 60 ? 0 : m;
      return String(dd).padStart(deg, '0') + String(mm).padStart(2, '0') + sign;
    };
    return fmt(lat, 2, 'N', 'S') + fmt(lon, 3, 'E', 'W');
  }

  function buildNarrative(route, fl) {
    if (!route.segments.length) return '';
    const segs = route.segments;
    // Formato de etiqueta: "NOMBRE (4029N00334W)" — si el nombre ya es
    // una pareja "lat,lon" decimal generada por dibujo en el mapa,
    // lo sustituimos directamente por la versión OACI.
    const fmtWp = wp => {
      const isDecimalCoords = /^-?\d+\.\d+,-?\d+\.\d+$/.test(wp.name || '');
      const icao = formatICAOCoord(wp.lat, wp.lon);
      if (!wp.name || isDecimalCoords) return icao;
      return `${wp.name} (${icao})`;
    };
    let out = fmtWp(segs[0].from);
    let lastFL = segs[0].from.fl != null ? segs[0].from.fl : fl;
    out += ' F' + lastFL;
    let lastAirway = null;
    for (const seg of segs) {
      const aw = seg.airway || 'DCT';
      if (aw !== lastAirway) { out += ' ' + aw; lastAirway = aw; }
      out += ' ' + fmtWp(seg.to);
      const segFL = seg.to.fl != null ? seg.to.fl : fl;
      if (segFL !== lastFL) {
        out += ' F' + segFL;
        lastFL = segFL;
      }
    }
    return out;
  }

  // ICAO Doc 4444 — Field 15 (Route).
  //   <SPEED><LEVEL> [DCT|AIRWAY] WPT [DCT|AIRWAY] WPT …
  // Origen va en el Field 13 y destino en el Field 16, así que strictamente
  // ambos quedarían fuera de Field 15. En la práctica casi todos los
  // sistemas operativos aceptan que se incluya el destino al final, por lo
  // que lo incluimos para que la cadena se pueda pegar tal cual y revisar.
  // Coordenadas no nominales se emiten en formato OACI 7 caracteres
  // (DDMM[N|S]DDDMM[E|W]).
  function buildICAOFPL15(plan) {
    if (!plan || !plan.route || !plan.route.segments) return '';
    const segs = plan.route.segments;
    const speed = 'N' + String(Math.max(1, Math.round(plan.speedKt || 0))).padStart(4, '0');
    const level = 'F' + String(Math.max(1, Math.round(plan.flightLevel || 0))).padStart(3, '0');
    const head = speed + level;

    if (!segs.length) return head + ' DCT';

    const wpToken = (wp) => {
      const isDecimal = /^-?\d+\.\d+,-?\d+\.\d+$/.test(wp.name || '');
      if (wp.name && !isDecimal) return wp.name;
      return formatICAOCoord(wp.lat, wp.lon);
    };

    let out = head;
    let lastAirway = null;
    let lastFL = (segs[0].from.fl != null) ? segs[0].from.fl : plan.flightLevel;
    for (const seg of segs) {
      const aw = seg.airway || 'DCT';
      if (aw !== lastAirway) { out += ' ' + aw; lastAirway = aw; }
      const segFL = (seg.to.fl != null) ? seg.to.fl : plan.flightLevel;
      // Cambio de FL en el waypoint de llegada del tramo: se anota como
      // "/N0420F340" pegado al token del waypoint (estándar ICAO).
      let token = wpToken(seg.to);
      if (segFL !== lastFL) {
        token += '/' + speed + 'F' + String(Math.max(1, Math.round(segFL))).padStart(3, '0');
        lastFL = segFL;
      }
      out += ' ' + token;
    }
    return out;
  }

  // Parser inverso de Field 15. Acepta también las formas relajadas que se
  // ven en briefings: "FL250" en vez de "F250", origen y destino al inicio
  // y final ("LEMD UN733 GCLP"), velocidad omitida, etc. Devuelve un objeto
  // { origin, destination, flightLevel, speedKt, via } compatible con plan().
  function parseICAOFPL15(text) {
    if (!text || typeof text !== 'string') return { error: 'Cadena vacía.' };
    const tokens = text.trim().toUpperCase().split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) return { error: 'Cadena vacía.' };

    let speedKt = null;
    let flightLevel = null;

    const isAirport = (t) => /^[A-Z]{4}$/.test(t) && !!awMod().waypoints[t];
    const isOACICoord = (t) => /^\d{4}[NS]\d{5}[EW]$/.test(t);
    const isDecimalCoord = (t) =>
      /^-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?$/.test(t) ||
      /^-?\d+(?:\.\d+)?$/.test(t);
    const isAirwayCode = (t) => /^[A-Z]{1,2}\d{1,4}[A-Z]?$/.test(t) && !isAirport(t);

    function parseSpeedLevel(tok) {
      // N0420F340, K0834F340, M082F340, F340, FL340, A050, S1500, M0840
      const m = tok.match(/^([NKM])(\d{3,4})([FAS])(\d{3,4})$/);
      if (m) {
        const sUnit = m[1], sVal = parseInt(m[2], 10);
        const lUnit = m[3], lVal = parseInt(m[4], 10);
        let kt;
        if (sUnit === 'N') kt = sVal;
        else if (sUnit === 'K') kt = sVal / 1.852;
        else /* M */ kt = (sVal / 100) * 573;  // Mach → kt aproximado a FL alto
        let fl;
        if (lUnit === 'F') fl = lVal;
        else if (lUnit === 'A') fl = Math.round(lVal / 100);
        else /* S */ fl = Math.round(lVal / 5);
        return { speedKt: Math.round(kt), flightLevel: fl };
      }
      const fOnly = tok.match(/^F(?:L)?(\d{2,3})$/);
      if (fOnly) return { flightLevel: parseInt(fOnly[1], 10) };
      return null;
    }

    function parseOACICoord(tok) {
      const m = tok.match(/^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/);
      if (!m) return null;
      const lat = (parseInt(m[1], 10) + parseInt(m[2], 10) / 60) * (m[3] === 'N' ? 1 : -1);
      const lon = (parseInt(m[4], 10) + parseInt(m[5], 10) / 60) * (m[6] === 'E' ? 1 : -1);
      return { name: tok, lat, lon };
    }

    // Primera pasada: aislar SPEED/LEVEL y velocidades/niveles intermedios.
    const remaining = [];
    for (const tok of tokens) {
      const sl = parseSpeedLevel(tok);
      if (sl) {
        if (sl.speedKt && !speedKt) speedKt = sl.speedKt;
        if (sl.flightLevel && !flightLevel) flightLevel = sl.flightLevel;
        continue;
      }
      // Cambios de nivel intermedios pegados al waypoint: "BCN/N0420F360"
      // → mantenemos el waypoint, descartamos el cambio (no lo aplicamos
      // porque en la app actual el plan tiene un único FL nominal).
      const slash = tok.indexOf('/');
      if (slash > 0 && parseSpeedLevel(tok.slice(slash + 1))) {
        remaining.push(tok.slice(0, slash));
        continue;
      }
      remaining.push(tok);
    }

    if (!remaining.length) return { error: 'No se ha encontrado ningún waypoint en la cadena.' };

    // Detectar origen / destino: token de 4 letras al inicio/final.
    // Una cadena estricta de Field 15 NO incluye origen ni destino (van
    // en los campos 13 y 16), así que admitimos también las dos variantes:
    //   - "LEMD UN733 LEZL GCLP" → origen y destino explícitos.
    //   - "N0420F340 UN733 LEZL" → solo Field 15 puro; en este caso el
    //     llamador debe rellenar origen/destino aparte (devolvemos null).
    let origin = null, destination = null, middleStart = 0, middleEnd = remaining.length;
    if (/^[A-Z]{4}$/.test(remaining[0])) {
      origin = remaining[0];
      middleStart = 1;
    }
    if (remaining.length > middleStart && /^[A-Z]{4}$/.test(remaining[remaining.length - 1])) {
      destination = remaining[remaining.length - 1];
      middleEnd = remaining.length - 1;
    }

    const middle = remaining.slice(middleStart, middleEnd);
    const via = [];
    const unknown = [];
    for (const tok of middle) {
      if (isAirwayCode(tok)) continue;       // aerovías ignoradas (ruta DCT entre waypoints)
      const wp = findWP(tok);
      if (wp) { via.push(tok); continue; }
      const oaci = parseOACICoord(tok);
      if (oaci) { via.push(oaci); continue; }
      unknown.push(tok);
    }

    if (unknown.length) {
      return { error: `Token(s) no reconocido(s) en la ruta: ${unknown.join(', ')}.` };
    }

    return {
      origin, destination,
      flightLevel: flightLevel || null,
      speedKt:     speedKt     || null,
      via,
    };
  }

  function findConflicts(route, tsas, fl, departureUTC, speedKt) {
    if (!route || !tsas || !tsas.length) return [];
    const out = [];
    let cumKm = 0;
    for (const seg of route.segments) {
      const segStartKm = cumKm;
      cumKm += seg.dist;
      const segEndKm = cumKm;
      const tStart = departureUTC.getTime() + (segStartKm / NM_KM / speedKt) * 3600 * 1000;
      const tEnd   = departureUTC.getTime() + (segEndKm   / NM_KM / speedKt) * 3600 * 1000;
      // Banda vertical del tramo: si los extremos tienen FLs distintos, el
      // tramo se considera atravesando todas las altitudes intermedias.
      const flA = seg.from.fl != null ? seg.from.fl : fl;
      const flB = seg.to.fl   != null ? seg.to.fl   : fl;
      const segLowFt  = Math.min(flA, flB) * 100;
      const segHighFt = Math.max(flA, flB) * 100;
      for (const tsa of tsas) {
        // El tramo arranca o termina explícitamente en esta TSA → cruce
        // intencional, no se reporta como conflicto.
        if (seg.from.tsa && seg.from.tsa.id === tsa.id) continue;
        if (seg.to.tsa   && seg.to.tsa.id   === tsa.id) continue;
        if (segHighFt < tsa.vertical.lowerFt) continue;
        if (segLowFt  > tsa.vertical.upperFt) continue;
        if (!segCrossesPolygon(
          [seg.from.lat, seg.from.lon],
          [seg.to.lat, seg.to.lon],
          tsa.polygon)) continue;
        const sched = (tsa.schedules || []).find(s =>
          s.startUTC.getTime() < tEnd && s.endUTC.getTime() > tStart
        );
        if (!sched) continue;
        out.push({
          tsa, segment: seg, schedule: sched,
          tStart: new Date(tStart), tEnd: new Date(tEnd),
        });
      }
    }
    const seen = new Set();
    return out.filter(c => {
      if (seen.has(c.tsa.id)) return false;
      seen.add(c.tsa.id); return true;
    });
  }

  function segCrossesPolygon(a, b, poly) {
    if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      if (segIntersect(a, b, poly[i], poly[(i + 1) % n])) return true;
    }
    return false;
  }
  function pointInPoly(pt, poly) {
    let inside = false;
    const x = pt[1], y = pt[0];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][1], yi = poly[i][0];
      const xj = poly[j][1], yj = poly[j][0];
      const cond = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (cond) inside = !inside;
    }
    return inside;
  }
  function segIntersect(p1, p2, p3, p4) {
    const ccw = (A, B, C) =>
      (C[0] - A[0]) * (B[1] - A[1]) > (B[0] - A[0]) * (C[1] - A[1]);
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
           ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  }

  function plan(opts) {
    opts = opts || {};
    const origin = findWP(opts.origin);
    const destination = findWP(opts.destination);
    if (!origin) return { error: `Origen desconocido: "${opts.origin}". Usa un código de waypoint del listado (p. ej. LEMD, LEBL).` };
    if (!destination) return { error: `Destino desconocido: "${opts.destination}". Usa un código de waypoint del listado.` };

    const fl = Number(opts.flightLevel) || 350;
    const speedKt = Number(opts.speedKt) || 450;
    const depUTC = opts.departureUTC instanceof Date ? opts.departureUTC : new Date();

    // El filtro de aerovias depende de los ticks "alta cota" / "baja cota"
    // en el control de capas del mapa. Si ambos estan apagados, no hay
    // waypoints AIP en el grafo y la ruta cae a DCT directo entre los
    // puntos del usuario. El llamador puede forzar un filtro especifico
    // pasando opts.airwayFilter.
    let filter = opts.airwayFilter;
    if (!filter) {
      const mv = window.TSAgestor && window.TSAgestor.mapView;
      filter = (mv && mv.getAirwayLayerState)
        ? mv.getAirwayLayerState()
        : { upper: true, lower: true };
    }
    const useAirways = !!(filter.upper || filter.lower);

    let route;
    const rawVia = Array.isArray(opts.via) ? opts.via : [];
    const viaList = [];
    if (rawVia.length) {
      const errors = [];
      for (const tok of rawVia) {
        const parsed = parseViaToken(tok);
        if (!parsed) continue;
        if (parsed.error) errors.push(parsed.error);
        else viaList.push(parsed);
      }
      if (errors.length) {
        return { error: `Waypoint(s) desconocido(s) en la vía: ${errors.join(', ')}. Usa códigos del listado o "lat,lon".` };
      }
    }

    if (!viaList.length && origin.name === destination.name) {
      return { error: 'Origen y destino son el mismo punto. Añade waypoints en "Vía" o dibuja la ruta para definir un circuito.' };
    }

    if (!useAirways) {
      // Sin overlays activos: DCT puro origen -> vias -> destino.
      route = buildManualRoute(origin, viaList, destination);
    } else if (!viaList.length) {
      // Con overlays activos y sin via: Dijkstra origen -> destino.
      route = findRoute(origin, destination, fl, filter);
    } else {
      // Con overlays activos y via forzada: Dijkstra entre cada par
      // consecutivo. Permite forzar puntos de paso obligatorios mientras
      // el resto de la ruta sigue aerovias.
      route = buildAirwayRouteVia(origin, viaList, destination, fl, filter);
    }

    // Cada waypoint adopta el nombre de la TSA que lo contiene (si la hay) y
    // un FL ajustado para librarla. Si no está en ninguna TSA conserva el FL
    // inicial.
    annotateRouteWithFL(route, opts.tsas || [], fl);
    const distNM = route.totalDistKm / NM_KM;
    const timeMinutes = (distNM / speedKt) * 60;
    const eta = new Date(depUTC.getTime() + timeMinutes * 60 * 1000);
    const conflicts = findConflicts(route, opts.tsas || [], fl, depUTC, speedKt);

    const result = {
      origin: origin.name,
      destination: destination.name,
      flightLevel: fl,
      speedKt,
      departureUTC: depUTC,
      eta,
      route,
      narrative: buildNarrative(route, fl),
      coords: buildCoords(route, depUTC, speedKt),
      distanceKM: route.totalDistKm,
      distanceNM: distNM,
      timeMinutes,
      conflicts,
    };
    result.fpl15 = buildICAOFPL15(result);
    return result;
  }

  // Log de vuelo con cálculo de combustible por tramo. Recibe los coords de
  // un plan ya calculado y, opcionalmente, un array `legOverrides` indexado
  // por número de fila con `{speedKt?, fuelFlow?}` para aplicar valores
  // distintos en cada tramo (ascensos/descensos). Si un campo del override
  // es null/undefined, se usa el valor global.
  function buildFuelLog(coords, opts) {
    opts = opts || {};
    const initialFuel = Number(opts.initialFuel) || 0;
    const fuelFlow = Number(opts.fuelFlow) || 0;
    const speedKt = Number(opts.speedKt) || 450;
    const joker = opts.jokerFuel != null && opts.jokerFuel !== '' ? Number(opts.jokerFuel) : null;
    const bingo = opts.bingoFuel != null && opts.bingoFuel !== '' ? Number(opts.bingoFuel) : null;
    const unit = opts.unit || '';
    const overrides = Array.isArray(opts.legOverrides) ? opts.legOverrides : [];
    // Pronósticos horarios completos por waypoint. Cada item:
    //   { times: [iso strings], windSpeedKt: [...], windDir: [...] }
    const windsHourly = Array.isArray(opts.windsHourly) && opts.windsHourly.length === coords.length
      ? opts.windsHourly : null;
    const windLevel = opts.windLevel || null;
    const windSource = opts.windSource || null;

    // Hora de salida (Date o ISO string). Si falta, usamos "ahora".
    const departureMs = opts.departureUTC instanceof Date
      ? opts.departureUTC.getTime()
      : (opts.departureUTC ? new Date(opts.departureUTC).getTime() : Date.now());

    // TAS efectiva por leg (incluyendo overrides manuales).
    const tasPerLeg = coords.map((_, i) => {
      const ov = overrides[i] || {};
      return Number.isFinite(ov.speedKt) && ov.speedKt > 0 ? ov.speedKt : speedKt;
    });

    // Calcula el array de ETAs (epoch ms) usando, opcionalmente, los vientos
    // mirados al ETA estimado anterior de cada waypoint.
    function computeEtas(prevEtas) {
      const etas = [departureMs];
      for (let i = 1; i < coords.length; i++) {
        const legNM = (coords[i].legDistKm || 0) / NM_KM;
        let gs = tasPerLeg[i];
        if (windsHourly && prevEtas) {
          const wA = lookupAt(windsHourly[i - 1], prevEtas[i - 1]);
          const wB = lookupAt(windsHourly[i],     prevEtas[i]);
          const avgW = avgWindVec(wA, wB);
          if (avgW) {
            const track = geom.bearing(
              [coords[i - 1].lat, coords[i - 1].lon],
              [coords[i].lat,     coords[i].lon]);
            const hw = -avgW.windSpeedKt * Math.cos((avgW.windDir - track) * Math.PI / 180);
            gs = Math.max(30, tasPerLeg[i] + hw);
          }
        }
        const legMs = (legNM / gs) * 3600 * 1000;
        etas.push(etas[i - 1] + legMs);
      }
      return etas;
    }

    // Iteración punto-fijo: 1ª pasada con TAS, después 3 refinamientos
    // sustituyendo TAS por GS ya con vientos a las ETAs estimadas.
    let etas = computeEtas(null);
    if (windsHourly) {
      for (let it = 0; it < 3; it++) etas = computeEtas(etas);
    }

    // Construcción final de filas con las ETAs convergidas.
    const rows = [];
    let cumFuelUsed = 0;
    let firstJokerIdx = null;
    let firstBingoIdx = null;

    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      const ov = overrides[i] || {};
      const segFlow = Number.isFinite(ov.fuelFlow) && ov.fuelFlow >= 0 ? ov.fuelFlow : fuelFlow;
      const legNM = i === 0 ? 0 : c.legDistKm / NM_KM;

      let track = null, windInfo = null, gs = tasPerLeg[i];
      if (i > 0 && windsHourly) {
        const prev = coords[i - 1];
        track = geom.bearing([prev.lat, prev.lon], [c.lat, c.lon]);
        const wA = lookupAt(windsHourly[i - 1], etas[i - 1]);
        const wB = lookupAt(windsHourly[i],     etas[i]);
        const avgW = avgWindVec(wA, wB);
        if (avgW) {
          const hw = -avgW.windSpeedKt * Math.cos((avgW.windDir - track) * Math.PI / 180);
          gs = Math.max(30, tasPerLeg[i] + hw);
          windInfo = {
            speedKt: avgW.windSpeedKt,
            dir: avgW.windDir,
            headwind: hw,
            track,
            atTime: wB && wB.atTime,           // hora de paso usada para este leg
          };
        }
      }

      const legHours = i === 0 ? 0 : legNM / gs;
      const legTimeMin = legHours * 60;
      const legFuel = legHours * segFlow;
      cumFuelUsed += legFuel;
      const remaining = initialFuel - cumFuelUsed;

      let status = 'ok';
      if (bingo !== null && remaining <= bingo) {
        status = 'bingo';
        if (firstBingoIdx === null) firstBingoIdx = i;
      } else if (joker !== null && remaining <= joker) {
        status = 'joker';
        if (firstJokerIdx === null) firstJokerIdx = i;
      }

      rows.push({
        index: i,
        name: c.name,
        airway: c.airway,
        fl: c.fl,
        legDistNM: legNM,
        legSpeedKt: tasPerLeg[i],                  // TAS
        legGS: i === 0 ? null : gs,
        legFuelFlow: segFlow,
        wind: windInfo,
        speedOverridden: Number.isFinite(ov.speedKt) && ov.speedKt !== speedKt,
        flowOverridden:  Number.isFinite(ov.fuelFlow) && ov.fuelFlow !== fuelFlow,
        legTimeMin,
        cumTimeMin: (etas[i] - departureMs) / 60000,
        legFuel,
        cumFuelUsed,
        remaining,
        status,
        etaUTC: new Date(etas[i]),
      });
    }

    const totalTimeMin = rows.length ? rows[rows.length - 1].cumTimeMin : 0;
    const reachesDestination = rows.length > 0 && rows[rows.length - 1].remaining > 0;
    return {
      rows,
      unit,
      initialFuel,
      fuelFlow,
      defaultSpeedKt: speedKt,
      jokerFuel: joker,
      bingoFuel: bingo,
      totalFuelUsed: cumFuelUsed,
      finalRemaining: initialFuel - cumFuelUsed,
      totalTimeMin,
      firstJokerIdx,
      firstBingoIdx,
      reachesDestination,
      hasWinds: !!windsHourly,
      windLevel,
      windSource,
      departureMs,
      arrivalMs: rows.length ? rows[rows.length - 1].etaUTC.getTime() : null,
    };
  }

  // Look-up del viento a una hora (ms) en el array horario de un punto.
  function lookupAt(ph, atMs) {
    if (!ph || !ph.times || !ph.times.length) return null;
    let bestIdx = 0, bestDiff = Infinity;
    for (let i = 0; i < ph.times.length; i++) {
      const t = new Date(ph.times[i] + 'Z').getTime();
      const diff = Math.abs(t - atMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return {
      windSpeedKt: ph.windSpeedKt[bestIdx],
      windDir:     ph.windDir[bestIdx],
      atTime:      ph.times[bestIdx] + 'Z',
    };
  }

  // Promedia dos vectores de viento (cada uno {windSpeedKt, windDir}).
  // Convierte a u,v primero para no fallar al cruzar 360°/0°.
  function avgWindVec(a, b) {
    const valid = w => w && Number.isFinite(w.windSpeedKt) && Number.isFinite(w.windDir);
    if (!valid(a) && !valid(b)) return null;
    if (!valid(a)) return b;
    if (!valid(b)) return a;
    const toRad = d => d * Math.PI / 180;
    const ua = -a.windSpeedKt * Math.sin(toRad(a.windDir));
    const va = -a.windSpeedKt * Math.cos(toRad(a.windDir));
    const ub = -b.windSpeedKt * Math.sin(toRad(b.windDir));
    const vb = -b.windSpeedKt * Math.cos(toRad(b.windDir));
    const u = (ua + ub) / 2;
    const v = (va + vb) / 2;
    const speed = Math.sqrt(u * u + v * v);
    let dir = Math.atan2(-u, -v) * 180 / Math.PI;
    if (dir < 0) dir += 360;
    return { windSpeedKt: speed, windDir: dir };
  }

  return { plan, listWaypoints, buildFuelLog, buildICAOFPL15, parseICAOFPL15 };
})();
