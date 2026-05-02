// Aerovías sobre Iberia — DEMO ILUSTRATIVA, NO OPERATIVA.
//
// No existe un dataset abierto y libre de aerovías españolas con la
// geometría oficial. Lo que aquí se traza son segmentos rectos entre
// VORs/aeropuertos conocidos. Sustituir por un GeoJSON oficial cuando
// se disponga de él.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.airways = (function () {
  'use strict';

  // Waypoints aproximados (VORs / aeropuertos). Coordenadas confiables.
  const WP = {
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
    LEMI: [37.80,  -0.81], LECU: [40.49,  -3.45], LEAO: [43.55,  -6.04],
    LPPT: [38.77,  -9.13], LPPR: [41.24,  -8.68], LPFR: [37.01,  -7.97],
    LFBO: [43.63,   1.37], LFML: [43.44,   5.21], LFBZ: [43.47,  -1.53],
    LFBD: [44.83,  -0.71], LFLL: [45.73,   5.08],
    GMMN: [33.37,  -7.59], GMME: [33.99,  -6.75], GMTT: [35.73,  -5.92],
    GCLP: [27.93, -15.39], GCTS: [28.04, -16.57], GCLA: [28.95, -17.76],
    GCFV: [28.45, -13.86], GCRR: [28.95, -13.60],
    EGLL: [51.47,  -0.46],
    LIRF: [41.80,  12.25], LIME: [45.66,   9.70],
  };

  const upper = [
    { name: 'UN10',   points: [WP.LEBB, WP.LEBL, WP.LEPA, WP.LEIB, WP.LEMG] },
    { name: 'UN725',  points: [WP.LFBO, WP.LEBL, WP.LEVC, WP.LEMG] },
    { name: 'UN731',  points: [WP.LEBB, WP.LEZG, WP.LEBL] },
    { name: 'UN733',  points: [WP.LEMD, WP.LEZL, WP.GCLP] },
    { name: 'UN734',  points: [WP.LEBB, WP.LEMD, WP.LEMG, WP.GMMN] },
    { name: 'UN741',  points: [WP.LEAS, WP.LELN, WP.LEMD, WP.LEAB, WP.LEAL] },
    { name: 'UN857',  points: [WP.LEBB, WP.LEMD, WP.LEMG, WP.GMME] },
    { name: 'UN858',  points: [WP.LEMD, WP.LPPT] },
    { name: 'UN863',  points: [WP.LEBL, WP.LFML, WP.LIME] },
    { name: 'UN866',  points: [WP.LEMD, WP.LEAB, WP.LEVC] },
    { name: 'UN871',  points: [WP.LEBL, WP.LFML] },
    { name: 'UN873',  points: [WP.LEMD, WP.LEZG, WP.LEBL] },
    { name: 'UN976',  points: [WP.LEAS, WP.LELN, WP.LEMD, WP.LEZL] },
    { name: 'UA34',   points: [WP.LEBL, WP.LEPA, WP.LEIB, WP.LEMG] },
    { name: 'UB28',   points: [WP.LEMD, WP.LPPT] },
    { name: 'UB31',   points: [WP.LEBL, WP.LEVC, WP.LEAL, WP.LEAM] },
    { name: 'UL153',  points: [WP.EGLL, WP.LFBD, WP.LEMD, WP.GCLP] },
    { name: 'UL607',  points: [WP.LEBL, WP.LEMD, WP.LEZL, WP.GMMN] },
    { name: 'UL620',  points: [WP.LFML, WP.LEPA, WP.LEAM, WP.GMTT] },
    { name: 'UM601',  points: [WP.LEMG, WP.LEAM, WP.LERI, WP.LEPA] },
    { name: 'UM610',  points: [WP.LEPA, WP.LEMH, WP.LIRF] },
    { name: 'UM984',  points: [WP.LEMD, WP.LEHC, WP.LPPT] },
    { name: 'UM985',  points: [WP.LEMD, WP.LEZL, WP.GMMN] },
    { name: 'UR10',   points: [WP.LEST, WP.LEMD, WP.LEVC, WP.LEPA] },
  ];

  const lower = [
    { name: 'A34',    points: [WP.LEMD, WP.LEBL] },
    { name: 'A22',    points: [WP.LEZL, WP.LPPT] },
    { name: 'A1',     points: [WP.GCLP, WP.GCTS] },
    { name: 'A8',     points: [WP.LEMD, WP.LEMG] },
    { name: 'B26',    points: [WP.LEMD, WP.LEZG, WP.LEBL] },
    { name: 'B28',    points: [WP.LEMD, WP.LEHC, WP.LEZL] },
    { name: 'B31',    points: [WP.LEBL, WP.LERS, WP.LEVC] },
    { name: 'G7',     points: [WP.LEST, WP.LECO, WP.LELN, WP.LEBB] },
    { name: 'G20',    points: [WP.LEMD, WP.LEAB, WP.LEVC] },
    { name: 'G23',    points: [WP.LEBB, WP.LEPP, WP.LEZG] },
    { name: 'G34',    points: [WP.LEAL, WP.LERI, WP.LEMG] },
    { name: 'R10',    points: [WP.LEMD, WP.LESA, WP.LPPT] },
    { name: 'R32',    points: [WP.LEMD, WP.LEAB, WP.LEAM] },
    { name: 'R40',    points: [WP.LEZG, WP.LELO, WP.LEVT] },
    { name: 'R74',    points: [WP.LEMD, WP.LEVD, WP.LELN] },
    { name: 'V25',    points: [WP.LEMD, WP.LEBG, WP.LEBB] },
    { name: 'V34',    points: [WP.LEZL, WP.LEMG] },
    { name: 'W6',     points: [WP.LEBL, WP.LEVC, WP.LEAL, WP.LEMG] },
    { name: 'N623',   points: [WP.LEMD, WP.LECU, WP.LEAB] },
    { name: 'N869',   points: [WP.LEZL, WP.LEHC, WP.LEMG] },
  ];

  return { upper, lower, waypoints: WP };
})();
