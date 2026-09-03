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

  // Invalida la cache del grafo. Hay que llamarlo cuando cambia el
  // dataset AIP (recarga de aipData, AIRAC nuevo, etc.) — sin esto,
  // el router seguiria usando waypoints/aerovias obsoletas hasta el
  // proximo full reload de la app.
  function invalidateGraphCache() {
    _graphCache.clear();
    console.info('[flightPlan] _graphCache invalidada');
  }

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

  // Devuelve la TSA cuyo poligono contiene el punto. Si se pasa
  // preferredFL, prefiere la TSA cuya banda vertical CONTIENE ese FL
  // (asi no hay que recortar). Util para climb/descent interpolados
  // donde varias TSAs apiladas (GUAGUA LOW/MEDIUM/HIGH) cubren la
  // misma area lateral con bandas distintas: queremos asignar al
  // sub-waypoint la TSA que ya encaja con su altitud, en vez de
  // siempre la primera del array.
  function findTSAContaining(latlon, tsas, preferredFL) {
    if (!tsas) return null;
    const targetFt = (preferredFL != null && Number.isFinite(preferredFL))
      ? preferredFL * 100 : null;
    let fallback = null;
    for (const tsa of tsas) {
      if (!pointInPoly(latlon, tsa.polygon)) continue;
      if (targetFt !== null && tsa.vertical &&
          Number.isFinite(tsa.vertical.lowerFt) && Number.isFinite(tsa.vertical.upperFt) &&
          tsa.vertical.lowerFt <= targetFt && targetFt <= tsa.vertical.upperFt) {
        return tsa;
      }
      if (!fallback) fallback = tsa;
    }
    return fallback;
  }

  // El vuelo cruza la TSA, manteniéndose DENTRO de su banda vertical con
  // un buffer de 500 ft respecto al techo y al suelo. Si el FL inicial ya
  // cae en la banda permitida lo conserva; si no, lo recorta al extremo
  // más cercano. FLs en pasos de 500 ft (FL005).
  // Politica de prioridad:
  //   1) Si el waypoint esta GEOGRAFICAMENTE dentro del poligono de
  //      la TSA, la ruta debe estar TAMBIEN dentro de la banda
  //      vertical de la TSA. Es decir, "dentro de TSA" = lateral +
  //      vertical. Si el FL crucero entra en [lowerFt, upperFt] lo
  //      mantenemos (priorida 2: cruise). Si no, snap al limite mas
  //      cercano de la banda con buffer de 500 ft.
  //   2) El FL crucero se preserva SOLO cuando es compatible con la
  //      TSA atravesada — porque el avion no puede estar "fuera" de
  //      la TSA verticalmente cuando esta "dentro" lateralmente
  //      (seria un sobrevuelo, que el cliente no quiere para esta
  //      planificacion: necesita coordinacion / interaccion con la
  //      TSA y por tanto encajar en su banda).
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
      if (flMax < flMin) {
        // Banda muy fina: devolvemos el FL medio del rango y nos
        // aseguramos de que cae dentro de [lowerFt/100, upperFt/100]
        // — sin esto, el redondeo a multiples de 5 podia dar un FL
        // ligeramente fuera (p.ej. lower=8000 upper=8100 -> FL80 OK,
        // pero lower=8050 upper=8150 -> Math.round((16200)/1000)*5=80
        // que es < 80.5 -> fuera del piso).
        const flMid = Math.round((lowerFt + upperFt) / 1000) * 5;
        const lo = Math.ceil(lowerFt / 100);
        const hi = Math.floor(upperFt / 100);
        return Math.max(lo, Math.min(hi, flMid));
      }
    }
    // FL crucero dentro de la banda -> se mantiene (prio 2).
    // Fuera -> snap a la banda (prio 1: dentro de TSA).
    // Clamp defensivo final: garantiza monotonia incluso si flMin>flMax
    // por culpa de aritmetica entera al ceil/floor en bandas extremas.
    if (flMax < flMin) return Math.round((lowerFt + upperFt) / 200);  // FL = (lo+hi)/2 en pies/100
    if (initialFL < flMin) return flMin;
    if (initialFL > flMax) return flMax;
    return initialFL;
  }

  // Enriquece un waypoint con TSA contenedora y FL ajustado.
  // Si el waypoint era un genérico "lat,lon", adopta el nombre de la TSA.
  function enrichWaypoint(pt, tsas, initialFL, isEndpoint) {
    // Pasamos el FL crucero como preferencia: si el waypoint esta dentro
    // de varias TSAs apiladas, picks la que ya contiene el FL crucero.
    // Asi un waypoint dentro de GUAGUA LOW + GUAGUA HIGH con cruise
    // FL250 elige GUAGUA HIGH (FL125-255) y mantiene FL250 sin recortar.
    const tsa = findTSAContaining([pt.lat, pt.lon], tsas, initialFL);
    // Origen y destino: aeropuertos al nivel del suelo. Mantenemos `tsa`
    // (si cae dentro de una) para que findConflicts pueda excluirla del
    // listado: por geografia es un cruce inevitable al despegar/aterrizar.
    if (isEndpoint) {
      return {
        name: pt.name || (pt.lat.toFixed(3) + ',' + pt.lon.toFixed(3)),
        lat: pt.lat,
        lon: pt.lon,
        tsa: tsa || null,
        fl: 0,
      };
    }
    // Waypoint intermedio dentro de una TSA: la ruta adapta el FL al
    // rango permitido por la TSA (como hacia el codigo original). Asi una
    // ruta planeada a FL250 que entra en TSA TALAVERA MEDIUM (4000-FL80)
    // se aplana a FL75 mientras esta dentro, y la lista de conflictos no
    // marca esa TSA porque seg.to.tsa la identifica como cruce planeado.
    if (tsa) {
      return {
        name: pt.name || tsa.name,
        lat: pt.lat,
        lon: pt.lon,
        tsa,
        fl: adjustFLForTSA(initialFL, tsa),
      };
    }
    // Waypoint intermedio fuera de cualquier TSA: vuela al FL del plan.
    return {
      name: pt.name || (pt.lat.toFixed(3) + ',' + pt.lon.toFixed(3)),
      lat: pt.lat,
      lon: pt.lon,
      tsa: null,
      fl: initialFL,
    };
  }

  // Recorre los segmentos de la ruta y aplica enrichWaypoint a cada extremo.
  // El primer y ultimo waypoint del recorrido reciben isEndpoint=true (GND).
  function annotateRouteWithFL(route, tsas, initialFL) {
    if (!route || !route.segments || !route.segments.length) return route;
    const seq = [route.segments[0].from].concat(route.segments.map(s => s.to));
    const last = seq.length - 1;
    const enriched = seq.map((p, i) => enrichWaypoint(p, tsas, initialFL, i === 0 || i === last));
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
  function buildAirwayRouteVia(origin, viaList, destination, fl, filter, tsasAtFL) {
    const points = [origin].concat(viaList).concat([destination]);
    const allSegments = [];
    let totalDistKm = 0;
    let anyManual = false;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      // Si los dos extremos son el mismo punto, lo saltamos.
      if (a.lat === b.lat && a.lon === b.lon) continue;
      const leg = findRoute(a, b, fl, filter, tsasAtFL);
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

  // Dijkstra. Penaliza usar la cota equivocada para el FL elegido y, si
  // se proporciona tsasAtFL (TSAs visibles cuya banda vertical contiene
  // el FL crucero), aplica un descuento del 30% a los segmentos cuyo
  // punto medio cae dentro de alguna de ellas. Asi la ruta tiende a
  // mantenerse dentro de las TSAs activas a la altitud crucero — util
  // para entrenamiento militar donde el piloto QUIERE volar por las
  // areas de trabajo / transito coordinadas.
  // filter: { upper: bool, lower: bool } controla que aerovias entran en el grafo.
  function findRoute(origin, destination, flightLevel, filter, tsasAtFL) {
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

    const useTsaBoost = Array.isArray(tsasAtFL) && tsasAtFL.length > 0;

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
        // Bonus por TSA: descuento si el segmento pasa por una TSA a la
        // altitud crucero. Calculamos el midpoint del segmento (basta
        // para edges cortos de aerovia) y aplicamos factor 0.7.
        if (useTsaBoost) {
          const toNode = g.nodes.get(edge.to);
          if (toNode) {
            const mid = [(node.lat + toNode.lat) / 2, (node.lon + toNode.lon) / 2];
            for (const tsa of tsasAtFL) {
              if (pointInPoly(mid, tsa.polygon)) { cost *= 0.7; break; }
            }
          }
        }
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

  // Cadena de ruta: ORIGIN DCT WPT DCT WPT ... DCT DESTINATION.
  // Sin nivel de vuelo, sin codigo de aerovia, sin nombre de TSA.
  // Cada waypoint:
  //   - Aeropuerto / waypoint con nombre real (LEBZ, POPUL, VNV, ...) ->
  //     se imprime el nombre tal cual, INCLUSO si cae dentro de una TSA
  //     (LEBZ esta dentro de TSA TALAVERA LOW AUTOMATICO; aun asi
  //     queremos "LEBZ" en origen/destino, no las coords).
  //   - Punto dibujado sin nombre, nombre "lat,lon" decimal, o waypoint
  //     cuyo nombre es el de su TSA (caso clasico: el usuario clica
  //     dentro de una TSA al dibujar y enrichWaypoint pone name=tsa.name)
  //     -> formato OACI compacto DDMM[N|S]DDDMM[E|W] (ej. 3853N00649W).
  function buildNarrative(route /*, fl */) {
    if (!route.segments.length) return '';
    const segs = route.segments;
    const fmtWp = wp => {
      const isDecimalCoords = /^-?\d+\.\d+,-?\d+\.\d+$/.test(wp.name || '');
      if (!wp.name || isDecimalCoords) return formatICAOCoord(wp.lat, wp.lon);
      // El name coincide con el de una TSA -> es un cruce/punto generico
      // dentro de la TSA, no un waypoint con identidad propia.
      if (wp.tsa && wp.name === wp.tsa.name) return formatICAOCoord(wp.lat, wp.lon);
      return wp.name;
    };
    let out = fmtWp(segs[0].from);
    for (const seg of segs) out += ' DCT ' + fmtWp(seg.to);
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
      // FL operativo del tramo: el mas alto de los dos extremos. Asi en el
      // ascenso (origen GND -> via FL250) o el descenso (via FL250 -> destino
      // GND) usamos FL250 para la deteccion: la aeronave alcanza ese nivel
      // de cruise y solo se reportan conflictos con TSAs cuya banda lo
      // incluye. Las TSAs bajas (p.ej. TLVR LOW 2500-5000ft) no se marcan
      // como conflicto cuando el plan es FL250 porque la ruta esta por
      // encima de ellas en cruise; durante climb/descent se asume separacion
      // ATC.
      const flA = seg.from.fl != null ? seg.from.fl : fl;
      const flB = seg.to.fl   != null ? seg.to.fl   : fl;
      const flCruise  = Math.max(flA, flB);
      const segLowFt  = flCruise * 100;
      const segHighFt = flCruise * 100;
      for (const tsa of tsas) {
        // El tramo arranca o termina dentro de esta TSA (sea por clic
        // explicito en modo dibujo o porque un aeropuerto/waypoint cae
        // geograficamente dentro): cruce esperado, no se reporta como
        // conflicto.
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

  // TSAs sobrevoladas lateralmente por la ruta, sin filtrar por FL ni
  // horario (a diferencia de findConflicts). Incluye tambien los TSAs en
  // los que el usuario clico explicitamente al dibujar (point.tsa). Una
  // sola entrada por TSA aunque la ruta la cruce varias veces (ida y vuelta).
  function findOverflownTSAs(route, tsas) {
    if (!route || !tsas || !tsas.length) return [];
    const seen = new Set();
    const out = [];
    function add(tsa) {
      if (!tsa || seen.has(tsa.id)) return;
      seen.add(tsa.id); out.push(tsa);
    }
    for (const seg of route.segments) {
      if (seg.from && seg.from.tsa) add(seg.from.tsa);
      if (seg.to   && seg.to.tsa)   add(seg.to.tsa);
      const a = [seg.from.lat, seg.from.lon];
      const b = [seg.to.lat,   seg.to.lon];
      for (const tsa of tsas) {
        if (seen.has(tsa.id)) continue;
        if (segCrossesPolygon(a, b, tsa.polygon)) add(tsa);
      }
    }
    return out;
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

    // El filtro de aerovias depende de las capas zonales activas en el mapa
    // (4 zonas x 2 cotas). Si NINGUNA esta activa asumimos que el usuario
    // solo querria un filtro visual y el planificador debe usar la red
    // completa; asi rutas como LEMD->LEBL siguen funcionando aunque el
    // mapa este vacio. El llamador puede forzar un filtro pasando
    // opts.airwayFilter.
    let filter = opts.airwayFilter;
    if (!filter) {
      const mv = window.TSAgestor && window.TSAgestor.mapView;
      filter = (mv && mv.getAirwayLayerState)
        ? mv.getAirwayLayerState()
        : { upper: false, lower: false };
      if (!filter.upper && !filter.lower) filter = { upper: true, lower: true };
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

    // Pre-filtra las TSAs visibles cuya banda vertical CONTIENE el FL
    // crucero. Solo estas tiran del router como atractor; las que estan
    // a otro FL no aplican porque el ATC no autorizaria pasar por ellas
    // sin coordinar el cambio. Asi "ruta dentro de TSA" e "ajustada a
    // altitud crucero" son la misma cosa.
    const flFt = fl * 100;
    const tsasAtFL = Array.isArray(opts.tsas) ? opts.tsas.filter(t =>
      t && Array.isArray(t.polygon) && t.polygon.length >= 3 &&
      t.vertical &&
      Number.isFinite(t.vertical.lowerFt) && Number.isFinite(t.vertical.upperFt) &&
      t.vertical.lowerFt <= flFt && flFt <= t.vertical.upperFt
    ) : [];

    if (!useAirways) {
      // Sin overlays activos: DCT puro origen -> vias -> destino.
      route = buildManualRoute(origin, viaList, destination);
    } else if (!viaList.length) {
      // Con overlays activos y sin via: Dijkstra origen -> destino.
      route = findRoute(origin, destination, fl, filter, tsasAtFL);
    } else {
      // Con overlays activos y via forzada: Dijkstra entre cada par
      // consecutivo. Permite forzar puntos de paso obligatorios mientras
      // el resto de la ruta sigue aerovias.
      route = buildAirwayRouteVia(origin, viaList, destination, fl, filter, tsasAtFL);
    }

    // Guard defensivo: si el builder devolvio una ruta sin segmentos
    // (caso raro: todos los puntos coinciden, p.ej. origen=via1=destino),
    // el resto del flujo crashearia en route.segments[0] y similares.
    if (!route || !Array.isArray(route.segments) || !route.segments.length) {
      return { error: 'No se pudo construir la ruta. Revisa que origen, vías y destino no coincidan.' };
    }

    // Cada waypoint adopta el nombre de la TSA que lo contiene (si la hay) y
    // un FL ajustado para librarla. Si no está en ninguna TSA conserva el FL
    // inicial.
    annotateRouteWithFL(route, opts.tsas || [], fl);
    const distNM = route.totalDistKm / NM_KM;
    const timeMinutes = (distNM / speedKt) * 60;
    const eta = new Date(depUTC.getTime() + timeMinutes * 60 * 1000);
    const conflicts = findConflicts(route, opts.tsas || [], fl, depUTC, speedKt);
    const overflownTSAs = findOverflownTSAs(route, opts.tsas || []);

    const result = {
      origin: origin.name,
      destination: destination.name,
      flightLevel: fl,
      speedKt,
      departureUTC: depUTC,
      eta,
      route,
      narrative: buildNarrative(route, fl),
      coords: expandClimbDescentLegs(buildCoords(route, depUTC, speedKt), opts.tsas || []),
      distanceKM: route.totalDistKm,
      distanceNM: distNM,
      timeMinutes,
      conflicts,
      overflownTSAs,
    };
    return result;
  }

  // Inserta waypoints sinteticos en legs con cambio de FL >= 5000 ft
  // (ascensos, descensos, transiciones a TSA con FL adaptado). El nuevo
  // waypoint se posiciona linealmente en el leg, lleva la altitud redon-
  // deada al FL multiple de 50 (5000 ft) mas proximo, y nombre tipo
  // "^FL100" / "vFL250" segun direccion.
  //
  // Restriccion TSA: si el sub-leg cae geograficamente dentro de una TSA,
  // su FL se acota al rango vertical de la TSA [lowerFt, upperFt] (en
  // pasos de FL5 igual que adjustFLForTSA). Asi tanto el waypoint como
  // la linea que lo une a sus vecinos quedan dentro de la banda permitida
  // por la TSA atravesada. El nombre cambia a "=FLxxx" para indicar que
  // ha sido recortado por una TSA.
  //
  // Despues recalculamos cumDistKm/legDistKm para que todo el flujo aguas
  // abajo (log de combustible, mapView, exportador) los trate como
  // waypoints normales.
  function expandClimbDescentLegs(coords, tsas) {
    if (!coords || coords.length < 2) return coords;
    // STEP_FL define el grano del staircase: cada cuanto FL insertamos
    // un sub-waypoint. STEP_FL=25 (= FL025 = 2500 ft) da una linea
    // mucho mas pegada a las TSAs apiladas (p.ej. GUAGUA LOW FL75-135
    // + GUAGUA HIGH FL125-255). Antes era STEP_FL=50 y la linea
    // saltaba zonas sin TSA.
    const STEP_FL = 25;
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1], cur = coords[i];
      const flA = Number.isFinite(prev.fl) ? prev.fl : null;
      const flB = Number.isFinite(cur.fl)  ? cur.fl  : null;
      if (flA != null && flB != null && Math.abs(flB - flA) >= STEP_FL) {
        const nSubs = Math.ceil(Math.abs(flB - flA) / STEP_FL);
        const arrow = flB > flA ? '↑' : '↓';
        // ETA de los extremos para interpolar ETA del sub-leg proporcio-
        // nalmente. Si por algun motivo el ETA del extremo no es Date,
        // caemos a now para no fallar.
        const etaA = prev.etaUTC instanceof Date ? prev.etaUTC.getTime() : Date.now();
        const etaB = cur.etaUTC  instanceof Date ? cur.etaUTC.getTime()  : etaA;
        for (let s = 1; s < nSubs; s++) {
          const t = s / nSubs;
          const lat = prev.lat + (cur.lat - prev.lat) * t;
          const lon = prev.lon + (cur.lon - prev.lon) * t;
          // FL redondeado al multiple de STEP_FL mas cercano.
          const flRaw = flA + (flB - flA) * t;
          let fl = Math.round(flRaw / STEP_FL) * STEP_FL;
          // Si el sub-leg cae dentro de una TSA, acotar el FL a su banda
          // vertical -- el avion no puede atravesar la TSA fuera de
          // [lowerFt, upperFt]. adjustFLForTSA aplica un buffer de 500 ft
          // y aproxima a FL5; lo reusamos para mantener consistencia con
          // los waypoints originales. Pasamos fl como preferredFL para
          // que findTSAContaining priorice la TSA cuya banda ya encaja
          // (ej.: en climb FL100, prefiere GUAGUA MEDIUM FL75-135 antes
          // que GUAGA LOW GND-FL85 que requeriria recorte).
          const tsa = findTSAContaining([lat, lon], tsas, fl);
          let clamped = false, prefix = arrow;
          if (tsa && tsa.vertical) {
            const adj = adjustFLForTSA(fl, tsa);
            if (adj !== fl) { fl = adj; clamped = true; prefix = '='; }
          }
          out.push({
            name: prefix + 'FL' + String(fl).padStart(3, '0'),
            lat, lon, fl,
            airway: cur.airway || '-',
            tsa: tsa || null,
            isClimbDescentSub: true,
            tsaClamped: clamped,
            etaUTC: new Date(etaA + (etaB - etaA) * t),
          });
        }
      }
      out.push(cur);
    }
    // Recalcula cumDistKm / cumDistNM / legDistKm sobre la lista expandida
    // — el render del plan en la tabla y el log dependen de estos campos.
    out[0].cumDistKm = 0;
    out[0].cumDistNM = 0;
    out[0].legDistKm = 0;
    for (let i = 1; i < out.length; i++) {
      const d = geom.greatCircleDistance([out[i - 1].lat, out[i - 1].lon], [out[i].lat, out[i].lon]);
      out[i].legDistKm = d;
      out[i].cumDistKm = out[i - 1].cumDistKm + d;
      out[i].cumDistNM = out[i].cumDistKm / NM_KM;
    }
    return out;
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

    // FL efectivo por waypoint (cae al FL del plan si el waypoint no trae
    // ninguno asignado). Origen/destino suelen ir a GND (fl=0), TSAs a su
    // limite vertical, cruise al FL del formulario.
    const cruiseFL = Number(opts.flightLevel) || (coords[0] && coords[0].fl) || 350;
    const flPerWp = coords.map(c => Number.isFinite(c.fl) ? c.fl : cruiseFL);

    // IAS introducida por el piloto (con override manual por leg). Antes
    // se trataba esto como TAS, pero la velocidad indicada SI depende de
    // la altitud (cae con la densidad), asi que aqui guardamos IAS y
    // derivamos TAS via tabla bilineal kiasToTAS().
    const iasPerLeg = coords.map((_, i) => {
      const ov = overrides[i] || {};
      return Number.isFinite(ov.speedKt) && ov.speedKt > 0 ? ov.speedKt : speedKt;
    });
    // TAS efectiva por leg: KIAS leida en la tabla con la altitud
    // densidad = FL del segmento (uso FL destino como representante;
    // para subdivisiones por cambio de FL >=5000ft el integrateLeg hace
    // el calculo fino por sub-leg).
    const kiasToTAS = (geom && geom.kiasToTAS)
      ? geom.kiasToTAS
      : ((k) => k);   // fallback identidad si la utilidad no esta.
    const tasPerLeg = iasPerLeg.map((kias, i) => {
      const flFt = (flPerWp[i] != null ? flPerWp[i] : cruiseFL) * 100;
      return kiasToTAS(kias, flFt);
    });

    // Detecta filas de "espera": coords sinteticas con isHold=true que
    // representan un hold sobre la posicion del waypoint anterior, sin
    // distancia ni vuelo (legNM=0). El holdMin se lee del legOverride
    // del propio indice. Asi en el log la espera vive en su FILA propia
    // y no se mezcla con el tiempo del tramo de vuelo.
    function isHoldCoord(i) {
      return !!(coords[i] && coords[i].isHold);
    }

    // Para tramos donde el FL cambia >= 5000 ft (ascensos / descensos /
    // cruces de TSA con FL adaptado), subdividimos el leg en sub-legs de
    // <= 5000 ft cada uno y aplicamos el viento al FL medio del sub-leg.
    // El resultado se integra (sum de horas) y se devuelve un viento medio
    // representativo para mostrar en la celda del log.
    //   integrateLeg({legNM, track, tas, flA, flB, phA, phB, etaA, etaBest})
    //     -> { hours, avgGs, avgWind:{speedKt,dir,headwind}|null,
    //          nSubs, flMid_min, flMid_max }
    function integrateLeg(o) {
      const dFL = Math.abs((o.flB || 0) - (o.flA || 0));
      const nSubs = Math.max(1, Math.ceil(dFL / 50)); // 50 FL = 5000 ft
      const subNM = o.legNM / nSubs;
      const dur = (o.etaBest - o.etaA);
      let totalHrs = 0, totalGs = 0;
      let sumU = 0, sumV = 0, sumHw = 0, cnt = 0;
      let flMin = Infinity, flMax = -Infinity;
      for (let s = 0; s < nSubs; s++) {
        const tMid = (s + 0.5) / nSubs;
        const flMid = o.flA + (o.flB - o.flA) * tMid;
        flMin = Math.min(flMin, flMid); flMax = Math.max(flMax, flMid);
        const etaMid = o.etaA + dur * tMid;
        // Viento en el extremo previo y posterior, ambos al FL del sub-leg;
        // luego mezcla ponderada por la posicion del sub-leg.
        const wA = o.phA ? lookupAt(o.phA, etaMid, flMid) : null;
        const wB = o.phB ? lookupAt(o.phB, etaMid, flMid) : null;
        const wSub = blendByPosition(wA, wB, tMid);
        // TAS al FL del sub-leg: si nos pasaron `ias`, recalculamos
        // (la densidad cae con la altura, asi que TAS sube). Si no,
        // usamos el TAS fijo `o.tas` (compat hacia atras).
        const tasSub = o.ias != null
          ? (geom.kiasToTAS ? geom.kiasToTAS(o.ias, flMid * 100) : o.ias)
          : o.tas;
        let gs = tasSub;
        let hw = 0;
        if (wSub) {
          hw = -wSub.windSpeedKt * Math.cos((wSub.windDir - o.track) * Math.PI / 180);
          gs = Math.max(30, tasSub + hw);
          const r = wSub.windDir * Math.PI / 180;
          sumU += -wSub.windSpeedKt * Math.sin(r);
          sumV += -wSub.windSpeedKt * Math.cos(r);
          sumHw += hw;
          cnt++;
        }
        totalHrs += subNM / gs;
        totalGs += gs;
      }
      let avgWind = null;
      if (cnt > 0) {
        const u = sumU / cnt, v = sumV / cnt;
        const speed = Math.sqrt(u * u + v * v);
        let dir = Math.atan2(-u, -v) * 180 / Math.PI;
        if (dir < 0) dir += 360;
        avgWind = { speedKt: speed, dir, headwind: sumHw / cnt };
      }
      return {
        hours: totalHrs,
        avgGs: totalGs / nSubs,
        avgWind,
        nSubs,
        flMin: flMin === Infinity ? null : flMin,
        flMax: flMax === -Infinity ? null : flMax,
      };
    }

    // Mezcla dos vientos (wA, wB) ponderando por tMid (0 = todo A, 1 = todo B).
    // Usa coordenadas u,v para evitar la discontinuidad en 359°/0°.
    function blendByPosition(wA, wB, tMid) {
      const validA = wA && Number.isFinite(wA.windSpeedKt) && Number.isFinite(wA.windDir);
      const validB = wB && Number.isFinite(wB.windSpeedKt) && Number.isFinite(wB.windDir);
      if (!validA && !validB) return null;
      if (!validA) return { windSpeedKt: wB.windSpeedKt, windDir: wB.windDir };
      if (!validB) return { windSpeedKt: wA.windSpeedKt, windDir: wA.windDir };
      const wAweight = 1 - tMid;
      const wBweight = tMid;
      const toRad = d => d * Math.PI / 180;
      const u = (-wA.windSpeedKt * Math.sin(toRad(wA.windDir))) * wAweight +
                (-wB.windSpeedKt * Math.sin(toRad(wB.windDir))) * wBweight;
      const v = (-wA.windSpeedKt * Math.cos(toRad(wA.windDir))) * wAweight +
                (-wB.windSpeedKt * Math.cos(toRad(wB.windDir))) * wBweight;
      const speed = Math.sqrt(u * u + v * v);
      let dir = Math.atan2(-u, -v) * 180 / Math.PI;
      if (dir < 0) dir += 360;
      return { windSpeedKt: speed, windDir: dir };
    }

    // Espera (hold) leida de overrides[i].holdMin. Solo aplica si la
    // coord en la posicion i es un hold sintetico (isHold=true).
    function holdMsAt(i) {
      if (!isHoldCoord(i)) return 0;
      const ov = overrides[i] || {};
      const m = Number(ov.holdMin);
      return Number.isFinite(m) && m > 0 ? m * 60 * 1000 : 0;
    }

    // Calcula el array de ETAs (epoch ms) integrando viento por sub-leg
    // cuando hay cambio de FL. Para holds: cero vuelo, solo se suma el
    // tiempo de espera.
    function computeEtas(prevEtas) {
      const etas = [departureMs];
      for (let i = 1; i < coords.length; i++) {
        if (isHoldCoord(i)) {
          etas.push(etas[i - 1] + holdMsAt(i));
          continue;
        }
        const legNM = (coords[i].legDistKm || 0) / NM_KM;
        let legMs;
        if (!windsHourly || !prevEtas) {
          legMs = (legNM / tasPerLeg[i]) * 3600 * 1000;
        } else {
          const track = geom.bearing(
            [coords[i - 1].lat, coords[i - 1].lon],
            [coords[i].lat,     coords[i].lon]);
          const res = integrateLeg({
            legNM, track, tas: tasPerLeg[i], ias: iasPerLeg[i],
            flA: flPerWp[i - 1], flB: flPerWp[i],
            phA: windsHourly[i - 1], phB: windsHourly[i],
            etaA: prevEtas[i - 1], etaBest: prevEtas[i],
          });
          legMs = res.hours * 3600 * 1000;
        }
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

      // ── Fila de espera (hold) ────────────────────────────────────────
      // Una coord sintetica con isHold=true representa un hold sobre la
      // posicion del waypoint anterior. No hay vuelo: la fila solo
      // consume "holdMin" minutos al ritmo del fuel flow del tramo.
      if (c.isHold) {
        const holdMin = Math.max(0, Number(ov.holdMin) || 0);
        const holdHours = holdMin / 60;
        const holdFuel = holdHours * segFlow;
        cumFuelUsed += holdFuel;
        const remaining = initialFuel - cumFuelUsed;
        let statusH = 'ok';
        if (bingo !== null && remaining <= bingo) {
          statusH = 'bingo';
          if (firstBingoIdx === null) firstBingoIdx = i;
        } else if (joker !== null && remaining <= joker) {
          statusH = 'joker';
          if (firstJokerIdx === null) firstJokerIdx = i;
        }
        rows.push({
          index: i,
          name: c.name,
          airway: c.airway || 'HOLD',
          fl: c.fl,
          isHold: true,
          legDistNM: 0,
          legIAS: null,
          legSpeedKt: null,
          legGS: null,
          legFuelFlow: segFlow,
          wind: null,
          legTimeMin: holdMin,
          flyTimeMin: 0,
          holdMin,
          holdFuel,
          cumTimeMin: (etas[i] - departureMs) / 60000,
          legFuel: holdFuel,
          cumFuelUsed,
          remaining,
          status: statusH,
          etaUTC: new Date(etas[i]),
        });
        continue;
      }

      let track = null, windInfo = null, gs = tasPerLeg[i];
      let legHoursOverride = null;
      // Calculamos siempre el track del leg (heading magnetic-true sin
      // declinacion -- bearing geodesico). Lo necesita la columna
      // "Tramo (HDG/NM)" del log incluso si no hay vientos cargados.
      if (i > 0) {
        const prev = coords[i - 1];
        track = geom.bearing([prev.lat, prev.lon], [c.lat, c.lon]);
      }
      if (i > 0 && windsHourly) {
        const prev = coords[i - 1];
        const res = integrateLeg({
          legNM, track, tas: tasPerLeg[i], ias: iasPerLeg[i],
          flA: flPerWp[i - 1], flB: flPerWp[i],
          phA: windsHourly[i - 1], phB: windsHourly[i],
          etaA: etas[i - 1], etaBest: etas[i],
        });
        if (res.avgWind) {
          gs = res.avgGs;
          legHoursOverride = res.hours;
          // Para el tooltip y la interpolacion mostrada usamos el viento del
          // extremo posterior (la referencia "mas reciente" del leg).
          const wB = lookupAt(windsHourly[i], etas[i], flPerWp[i]);
          windInfo = {
            speedKt: res.avgWind.speedKt,
            dir: res.avgWind.dir,
            headwind: res.avgWind.headwind,
            track,
            atTime: wB && wB.atTime,
            flFrom: flPerWp[i - 1],
            flTo:   flPerWp[i],
            interpLo: wB && wB.levelLo ? wB.levelLo.hPa : null,
            interpHi: wB && wB.levelHi ? wB.levelHi.hPa : null,
            nSubs:   res.nSubs,                 // numero de sub-legs integrados
          };
        }
      }

      const legHours = i === 0 ? 0 : (legHoursOverride != null ? legHoursOverride : legNM / gs);
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
        legTrack: track,                            // heading geodesico del leg (deg, 0-360) o null para el primer waypoint
        legIAS: iasPerLeg[i],                      // velocidad indicada (input)
        legSpeedKt: tasPerLeg[i],                  // TAS (KIAS corregida por densidad)
        legGS: i === 0 ? null : gs,                // GS = TAS + componente viento
        legFuelFlow: segFlow,
        wind: windInfo,
        speedOverridden: Number.isFinite(ov.speedKt) && ov.speedKt !== speedKt,
        flowOverridden:  Number.isFinite(ov.fuelFlow) && ov.fuelFlow !== fuelFlow,
        legTimeMin,                                // solo vuelo (los hold viven en filas propias)
        flyTimeMin: legTimeMin,
        holdMin: 0,
        holdFuel: 0,
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

  // Look-up del viento a una hora (ms) y un FL especifico en el array
  // horario de un punto. Si ph trae byLevel (formato nuevo) interpola
  // entre los dos niveles ISA que encierran el FL pedido; si trae
  // windSpeedKt directos (formato legacy) lo devuelve tal cual.
  // Delega en meteoApi.lookupWindAt si esta cargado para no duplicar
  // logica de interpolacion vectorial.
  function lookupAt(ph, atMs, fl) {
    if (!ph || !ph.times || !ph.times.length) return null;
    const mApi = window.TSAgestor && window.TSAgestor.meteoApi;
    if (mApi && typeof mApi.lookupWindAt === 'function') {
      return mApi.lookupWindAt(ph, atMs, fl);
    }
    // Fallback minimo si meteoApi aun no esta cargado.
    let bestIdx = 0, bestDiff = Infinity;
    for (let i = 0; i < ph.times.length; i++) {
      const t = new Date(ph.times[i] + 'Z').getTime();
      const diff = Math.abs(t - atMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return {
      windSpeedKt: ph.windSpeedKt ? ph.windSpeedKt[bestIdx] : null,
      windDir:     ph.windDir ? ph.windDir[bestIdx] : null,
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

  return { plan, listWaypoints, buildFuelLog, invalidateGraphCache };
})();
