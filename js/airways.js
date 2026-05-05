// Aerovias de Espana, dataset real extraido del AIP ENR 3.2 + ENR 4.1.
//
// Fuente: parser TSAgestor (data-sources/aip-enr/parse_aip.py + embed_aip.py)
// sobre los PDFs oficiales de AENA / ENAIRE. Carga aipData (window.TSAgestor.aipData)
// y la fusiona con la tabla local de aeropuertos para construir el grafo
// que consume flightPlan.js.
//
// El espacio aereo superior espanol opera como Free Route (HISPAFRA, ENR 2.2)
// desde 2022, por eso el AIP solo publica aerovias inferiores y tramos
// mixtos low/high. Las clasicas UN/UM/UR/UL (legacy) ya no existen.
//
// Para que las rutas tipo "LEMD a LEBL via aerovias" funcionen, los
// aeropuertos se conectan virtualmente con sus N waypoints/navaids reales
// mas cercanos mediante segmentos DCT, asi Dijkstra puede entrar en la red.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.airways = (function () {
  'use strict';

  // --- Aeropuertos (AIP no los considera waypoints de aerovia) ------------
  const AIRPORTS = {
    // Espana - principales
    LEMD: [40.49,  -3.57], LEBL: [41.30,   2.08], LEZL: [37.42,  -5.90],
    LEMG: [36.67,  -4.50], LEVC: [39.49,  -0.48], LEBB: [43.30,  -2.91],
    LEPA: [39.55,   2.74], LEST: [42.90,  -8.41], LEIB: [38.87,   1.37],
    LEAL: [38.28,  -0.56], LEAM: [36.84,  -2.37], LEZG: [41.66,  -1.04],
    LEXJ: [43.43,  -3.82], LEAS: [43.56,  -6.04], LEAB: [38.95,  -1.86],
    LERS: [41.15,   1.17], LEGE: [41.90,   2.76], LEMH: [39.86,   4.22],
    LECO: [43.30,  -8.38], LELN: [42.59,  -5.66], LEVT: [42.88,  -2.72],
    LELO: [42.46,  -2.32], LEPP: [42.77,  -1.65], LESA: [40.95,  -5.50],
    LEVD: [41.71,  -4.85], LEBG: [42.36,  -3.62], LEHC: [37.55,  -6.77],
    LEJR: [36.74,  -6.06], LEGR: [37.19,  -3.78], LECH: [40.22,   0.07],
    LERI: [37.78,  -1.23], LEMO: [37.18,  -5.61], LERT: [36.45,  -5.86],
    LEMI: [37.80,  -0.81], LECU: [40.37,  -3.79], LEAO: [43.55,  -6.04],
    // Espana - secundarios y militares de uso mixto
    LEBZ: [38.89,  -6.82], LEBA: [37.84,  -4.85], LESO: [43.36,  -1.79],
    LELL: [41.52,   2.11], LETO: [40.50,  -3.45], LEGT: [40.29,  -3.72],
    LEHU: [42.08,  -0.32], LEDA: [41.73,   0.54], LETL: [40.40,  -1.22],
    LEMR: [38.83,  -0.78], LERJ: [42.46,  -2.32], LEPM: [37.78,  -3.77],
    LECC: [42.46,  -3.71],
    // Canarias
    GCLP: [27.93, -15.39], GCTS: [28.04, -16.57], GCXO: [28.48, -16.34],
    GCLA: [28.63, -17.76], GCFV: [28.45, -13.86], GCRR: [28.95, -13.60],
    GCGM: [28.03, -17.21], GCHI: [27.81, -17.89],
    // Portugal
    LPPT: [38.77,  -9.13], LPPR: [41.24,  -8.68], LPFR: [37.01,  -7.97],
    LPCS: [38.72,  -9.36], LPMA: [32.69, -16.78], LPPS: [37.74, -25.70],
    // Francia
    LFBO: [43.63,   1.37], LFML: [43.44,   5.21], LFBZ: [43.47,  -1.53],
    LFBD: [44.83,  -0.71], LFLL: [45.73,   5.08],
    // Marruecos
    GMMN: [33.37,  -7.59], GMME: [33.99,  -6.75], GMTT: [35.73,  -5.92],
    // Otros referenciados en planes
    EGLL: [51.47,  -0.46],
    LIRF: [41.80,  12.25], LIME: [45.66,   9.70],
  };

  const AIRPORT_NAMES = {
    LEMD: 'Madrid-Barajas', LEBL: 'Barcelona-El Prat', LEZL: 'Sevilla',
    LEMG: 'Malaga-Costa del Sol', LEVC: 'Valencia', LEBB: 'Bilbao',
    LEPA: 'Palma de Mallorca', LEST: 'Santiago de Compostela',
    LEIB: 'Ibiza', LEAL: 'Alicante-Elche', LEAM: 'Almeria',
    LEZG: 'Zaragoza', LEXJ: 'Santander', LEAS: 'Asturias',
    LEAB: 'Albacete', LERS: 'Reus', LEGE: 'Girona-Costa Brava',
    LEMH: 'Menorca', LECO: 'A Coruna', LELN: 'Leon', LEVT: 'Vitoria',
    LELO: 'Logrono-Agoncillo', LEPP: 'Pamplona', LESA: 'Salamanca',
    LEVD: 'Valladolid', LEBG: 'Burgos', LEHC: 'Huelva (VOR)',
    LEJR: 'Jerez de la Frontera', LEGR: 'Granada', LECH: 'Castellon',
    LERI: 'Murcia-San Javier', LEMO: 'Moron (mil.)',
    LERT: 'Rota (mil.)', LEMI: 'Murcia-Corvera', LECU: 'Madrid-Cuatro Vientos',
    LEAO: 'Asturias (alt.)',
    LEBZ: 'Badajoz', LEBA: 'Cordoba', LESO: 'San Sebastian',
    LELL: 'Sabadell', LETO: 'Madrid-Torrejon (mil.)',
    LEGT: 'Madrid-Getafe (mil.)', LEHU: 'Huesca-Pirineos',
    LEDA: 'Lleida-Alguaire', LETL: 'Teruel', LEMR: 'Madrid-Cuatro Vientos (alt.)',
    LERJ: 'Logrono (Recajo)', LEPM: 'Jaen', LECC: 'Burgos (alt.)',
    GCLP: 'Gran Canaria', GCTS: 'Tenerife Sur', GCXO: 'Tenerife Norte',
    GCLA: 'La Palma', GCFV: 'Fuerteventura', GCRR: 'Lanzarote',
    GCGM: 'La Gomera', GCHI: 'El Hierro',
    LPPT: 'Lisboa', LPPR: 'Porto', LPFR: 'Faro', LPCS: 'Cascais',
    LPMA: 'Madeira', LPPS: 'Ponta Delgada (Azores)',
    LFBO: 'Toulouse', LFML: 'Marsella', LFBZ: 'Biarritz',
    LFBD: 'Burdeos', LFLL: 'Lyon',
    GMMN: 'Casablanca', GMME: 'Rabat', GMTT: 'Tanger',
    EGLL: 'Londres-Heathrow', LIRF: 'Roma-Fiumicino', LIME: 'Bergamo',
  };

  // --- Carga del dataset AIP ----------------------------------------------
  const aip = window.TSAgestor.aipData || { waypoints: {}, airways: [] };

  // Tabla unificada de waypoints (aeropuertos + AIP).
  const WP = {};
  const WP_NAMES = {};
  const WP_TYPES = {};   // AIRPORT | NAVAID | RNAV

  for (const [k, pt] of Object.entries(AIRPORTS)) {
    WP[k] = pt;
    WP_NAMES[k] = AIRPORT_NAMES[k] || k;
    WP_TYPES[k] = 'AIRPORT';
  }
  for (const [k, w] of Object.entries(aip.waypoints || {})) {
    if (WP[k]) continue;                 // los aeropuertos ganan
    WP[k] = [w[0], w[1]];                // [lat, lon]
    WP_NAMES[k] = w[3] || k;
    WP_TYPES[k] = w[2] || 'RNAV';
  }

  // --- Construccion de listas upper/lower ---------------------------------
  function airwayPoints(aw) {
    const out = [];
    for (const id of aw.waypoints) {
      const pt = WP[id];
      if (pt) out.push(pt);
    }
    return out;
  }

  // Cargamos toda la red AIP en ambas capas (alta y baja cota): la mayoria
  // de aerovias espanolas son mixtas FL95-FL660 y la division por FL solo
  // ocultaba arbitrariamente segmentos en una capa u otra. El planificador
  // sigue leyendo lowerFL/upperFL de cada item para penalizar mismatches en
  // su scoring; lo que cambia aqui es solo la visibilidad en el mapa.
  const upper = [];
  const lower = [];
  for (const aw of (aip.airways || [])) {
    const points = airwayPoints(aw);
    if (points.length < 2) continue;
    const item = {
      name:    aw.name,
      points,
      lowerFL: (aw.lowerFL != null) ? aw.lowerFL : null,
      upperFL: (aw.upperFL != null) ? aw.upperFL : null,
    };
    upper.push(item);
    lower.push(item);
  }

  // --- Conexion airport <-> red de waypoints (DCT virtuales) --------------
  // Para cada aeropuerto, lo conectamos con los N waypoints AIP mas cercanos
  // dentro de un radio razonable. Esto permite a Dijkstra entrar en la red
  // desde un aeropuerto y salir hacia otro a traves de aerovias reales.
  const NEAR_RADIUS_NM   = 80;
  const NEAR_LIMIT       = 3;
  const NM_PER_DEG_LAT   = 60;

  function approxNM(latA, lonA, latB, lonB) {
    const dLat = (latB - latA) * NM_PER_DEG_LAT;
    const meanLat = ((latA + latB) / 2) * Math.PI / 180;
    const dLon = (lonB - lonA) * NM_PER_DEG_LAT * Math.cos(meanLat);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  // Aeropuerto -> [{id, lat, lon, distNM}, ...] ordenados.
  function nearestFixesTo(lat, lon) {
    const result = [];
    for (const [id, pt] of Object.entries(WP)) {
      if (WP_TYPES[id] === 'AIRPORT') continue;
      const d = approxNM(lat, lon, pt[0], pt[1]);
      if (d > NEAR_RADIUS_NM) continue;
      result.push({ id, lat: pt[0], lon: pt[1], distNM: d });
    }
    result.sort((a, b) => a.distNM - b.distNM);
    return result.slice(0, NEAR_LIMIT);
  }

  // Generamos pseudo-aerovias "DCT" con dos puntos cada una.
  // Solo para aeropuertos con suficientes fixes cercanos (evita conectar
  // aeropuertos remotos que arrastran rutas largas inutiles).
  for (const [apt, pt] of Object.entries(AIRPORTS)) {
    const fixes = nearestFixesTo(pt[0], pt[1]);
    for (const f of fixes) {
      lower.push({
        name:   'DCT',
        points: [pt, [f.lat, f.lon]],
      });
    }
  }

  return {
    upper, lower,
    waypoints:     WP,
    waypointNames: WP_NAMES,
    waypointTypes: WP_TYPES,
    airac:         aip.airac || null,
    source:        aip.source || 'unknown',
  };
})();
