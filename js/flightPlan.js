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

  let _graph = null;
  function graph() {
    if (_graph) return _graph;
    const aw = awMod();
    const nodes = new Map();
    const wpByKey = new Map();
    for (const [name, pt] of Object.entries(aw.waypoints)) {
      wpByKey.set(coordKey(pt), name);
    }
    function ensure(pt) {
      const key = coordKey(pt);
      if (!nodes.has(key)) {
        nodes.set(key, {
          key, lat: pt[0], lon: pt[1],
          name: wpByKey.get(key) || null,
          neighbors: [],
        });
      }
      return nodes.get(key);
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
    for (const r of (aw.upper || [])) addAirway(r, 'upper');
    for (const r of (aw.lower || [])) addAirway(r, 'lower');
    _graph = { nodes, wpByKey };
    return _graph;
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
  function findRoute(origin, destination, flightLevel) {
    const g = graph();
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

    let route;
    const rawVia = Array.isArray(opts.via) ? opts.via : [];
    if (rawVia.length) {
      const viaList = [];
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
      // Circuito (LEMD → ... → LEMD) permitido si hay al menos un waypoint intermedio.
      route = buildManualRoute(origin, viaList, destination);
    } else {
      if (origin.name === destination.name) {
        return { error: 'Origen y destino son el mismo punto. Añade waypoints en "Vía" o dibuja la ruta para definir un circuito.' };
      }
      route = findRoute(origin, destination, fl);
    }

    // Cada waypoint adopta el nombre de la TSA que lo contiene (si la hay) y
    // un FL ajustado para librarla. Si no está en ninguna TSA conserva el FL
    // inicial.
    annotateRouteWithFL(route, opts.tsas || [], fl);
    const distNM = route.totalDistKm / NM_KM;
    const timeMinutes = (distNM / speedKt) * 60;
    const eta = new Date(depUTC.getTime() + timeMinutes * 60 * 1000);
    const conflicts = findConflicts(route, opts.tsas || [], fl, depUTC, speedKt);

    return {
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

    const rows = [];
    let cumTimeMin = 0;
    let cumFuelUsed = 0;
    let firstJokerIdx = null;
    let firstBingoIdx = null;

    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      const ov = overrides[i] || {};
      const segSpeed = Number.isFinite(ov.speedKt) && ov.speedKt > 0 ? ov.speedKt : speedKt;
      const segFlow  = Number.isFinite(ov.fuelFlow) && ov.fuelFlow >= 0 ? ov.fuelFlow : fuelFlow;
      const legNM = i === 0 ? 0 : c.legDistKm / NM_KM;
      const legHours = i === 0 ? 0 : legNM / segSpeed;
      const legTimeMin = legHours * 60;
      const legFuel = legHours * segFlow;
      cumTimeMin += legTimeMin;
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
        legSpeedKt: segSpeed,
        legFuelFlow: segFlow,
        speedOverridden: Number.isFinite(ov.speedKt) && ov.speedKt !== speedKt,
        flowOverridden:  Number.isFinite(ov.fuelFlow) && ov.fuelFlow !== fuelFlow,
        legTimeMin,
        cumTimeMin,
        legFuel,
        cumFuelUsed,
        remaining,
        status,
        etaUTC: c.etaUTC,
      });
    }

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
      totalTimeMin: cumTimeMin,
      firstJokerIdx,
      firstBingoIdx,
      reachesDestination,
    };
  }

  return { plan, listWaypoints, buildFuelLog };
})();
