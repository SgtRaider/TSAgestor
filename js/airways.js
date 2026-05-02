// Aerovías ILUSTRATIVAS sobre Iberia — DEMO, NO OPERATIVAS.
//
// Las aerovías reales (UN857, UA34, etc.) tienen waypoints específicos
// que rara vez coinciden con aeropuertos. Aquí, por simplicidad y
// porque no hay un dataset abierto y libre con la geometría oficial,
// se trazan como segmentos rectos entre VORs / aeropuertos conocidos.
//
// Sustituir por un GeoJSON real cuando esté disponible.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.airways = (function () {
  'use strict';

  // Waypoints aproximados (VORs / aeropuertos principales) — coords confiables
  const WP = {
    LEMD: [40.49,  -3.57], // Madrid-Barajas
    LEBL: [41.30,   2.08], // Barcelona-El Prat
    LEZL: [37.42,  -5.90], // Sevilla
    LEMG: [36.67,  -4.50], // Málaga
    LEVC: [39.49,  -0.48], // Valencia
    LEBB: [43.30,  -2.91], // Bilbao
    LEPA: [39.55,   2.74], // Palma de Mallorca
    LEST: [42.90,  -8.41], // Santiago
    LEIB: [38.87,   1.37], // Ibiza
    LEAL: [38.28,  -0.56], // Alicante
    LEAM: [36.84,  -2.37], // Almería
    LEZG: [41.66,  -1.04], // Zaragoza
    LEXJ: [43.43,  -3.82], // Santander
    LPPT: [38.77,  -9.13], // Lisboa
    LPPR: [41.24,  -8.68], // Porto
    LFBO: [43.63,   1.37], // Toulouse
    LFML: [43.44,   5.21], // Marseille
    GMMN: [33.37,  -7.59], // Casablanca
    GMME: [33.99,  -6.75], // Rabat
    GCLP: [27.93, -15.39], // Las Palmas
    GCTS: [28.04, -16.57], // Tenerife Sur
  };

  // Aerovías de alta cota (Upper, normalmente FL245 - FL460) — DEMO
  const upper = [
    { name: 'UN857', points: [WP.LEBB, WP.LEMD, WP.LEMG, WP.GMME] },
    { name: 'UN725', points: [WP.LFBO, WP.LEBL, WP.LEVC, WP.LEMG] },
    { name: 'UN10',  points: [WP.LEBB, WP.LEBL, WP.LEPA, WP.LEIB] },
    { name: 'UN871', points: [WP.LEBL, WP.LFML] },
    { name: 'UM985', points: [WP.LEMD, WP.LEZL, WP.GMMN] },
    { name: 'UA34',  points: [WP.LEBL, WP.LEPA, WP.LEIB, WP.LEMG] },
    { name: 'UB28',  points: [WP.LEMD, WP.LPPT] },
    { name: 'UR10',  points: [WP.LEST, WP.LEMD, WP.LEVC, WP.LEPA] },
    { name: 'UN733', points: [WP.LEMD, WP.GCLP] },
  ];

  // Aerovías de baja cota (Conventional, normalmente hasta FL245) — DEMO
  const lower = [
    { name: 'A34',  points: [WP.LEMD, WP.LEBL] },
    { name: 'B26',  points: [WP.LEMD, WP.LEZG, WP.LEBL] },
    { name: 'G20',  points: [WP.LEMD, WP.LEVC] },
    { name: 'R10',  points: [WP.LEMD, WP.LPPT] },
    { name: 'V25',  points: [WP.LEMD, WP.LEBB] },
    { name: 'W6',   points: [WP.LEBL, WP.LEVC, WP.LEAL, WP.LEMG] },
    { name: 'A22',  points: [WP.LEZL, WP.LPPT] },
    { name: 'G7',   points: [WP.LEST, WP.LEBB] },
    { name: 'R32',  points: [WP.LEMD, WP.LEAM] },
    { name: 'A1',   points: [WP.GCLP, WP.GCTS] },
  ];

  return { upper, lower, waypoints: WP };
})();
