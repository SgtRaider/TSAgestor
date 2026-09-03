// Espacios aéreos sobre Iberia — DEMO ILUSTRATIVA, NO OPERATIVA.
//
// TMAs (Terminal Maneuvering Areas) y CTRs (Control Zones) aproximadas
// como polígonos sencillos centrados en cada aeropuerto principal. Los
// contornos reales de las TMAs son sectores irregulares que incluyen
// múltiples segmentos, arcos y exclusiones — aquí se reducen a círculos
// generados con geom.circleToPolygon.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.airspace = (function () {
  'use strict';

  const geom = window.TSAgestor.geom;
  const NM_KM = 1.852;

  // Cada entrada: { id, name, lat, lon, radiusNM, lower, upper }
  // lower/upper en pies para mostrar como banda de altitudes.
  const TMAS = [
    { id: 'LECMD', name: 'TMA Madrid',      lat: 40.49, lon:  -3.57, radiusNM: 80, lower: 1500,  upper: 24500 },
    { id: 'LECBL', name: 'TMA Barcelona',   lat: 41.30, lon:   2.08, radiusNM: 60, lower: 1500,  upper: 24500 },
    { id: 'LECVL', name: 'TMA Valencia',    lat: 39.49, lon:  -0.48, radiusNM: 45, lower: 1500,  upper: 12500 },
    { id: 'LECSV', name: 'TMA Sevilla',     lat: 37.42, lon:  -5.90, radiusNM: 45, lower: 1500,  upper: 12500 },
    { id: 'LECMG', name: 'TMA Málaga',      lat: 36.67, lon:  -4.50, radiusNM: 50, lower: 1500,  upper: 12500 },
    { id: 'LECBI', name: 'TMA Bilbao',      lat: 43.30, lon:  -2.91, radiusNM: 45, lower: 1500,  upper: 12500 },
    { id: 'LECPM', name: 'TMA Palma',       lat: 39.55, lon:   2.74, radiusNM: 55, lower: 1500,  upper: 24500 },
    { id: 'LECZG', name: 'TMA Zaragoza',    lat: 41.66, lon:  -1.04, radiusNM: 35, lower: 1500,  upper:  9500 },
    { id: 'LECVI', name: 'TMA Vigo',        lat: 42.24, lon:  -8.62, radiusNM: 35, lower: 1500,  upper:  9500 },
    { id: 'LECST', name: 'TMA Santiago',    lat: 42.90, lon:  -8.41, radiusNM: 40, lower: 1500,  upper: 12500 },
    { id: 'LECAS', name: 'TMA Asturias',    lat: 43.56, lon:  -6.04, radiusNM: 35, lower: 1500,  upper:  9500 },
    { id: 'LECAL', name: 'TMA Alicante',    lat: 38.28, lon:  -0.56, radiusNM: 40, lower: 1500,  upper: 12500 },
    { id: 'LECMU', name: 'TMA Murcia',      lat: 37.80, lon:  -1.13, radiusNM: 30, lower: 1500,  upper:  9500 },
    { id: 'LECGR', name: 'TMA Granada',     lat: 37.19, lon:  -3.78, radiusNM: 30, lower: 1500,  upper:  9500 },
    { id: 'LECJX', name: 'TMA Jerez',       lat: 36.74, lon:  -6.06, radiusNM: 35, lower: 1500,  upper:  9500 },
    { id: 'GCCC',  name: 'TMA Las Palmas',  lat: 27.93, lon: -15.39, radiusNM: 50, lower: 1500,  upper: 12500 },
    { id: 'GCXO',  name: 'TMA Tenerife',    lat: 28.04, lon: -16.57, radiusNM: 50, lower: 1500,  upper: 12500 },
    { id: 'LPMA',  name: 'TMA Lisboa',      lat: 38.77, lon:  -9.13, radiusNM: 60, lower: 1500,  upper: 19500 },
    { id: 'LPPR',  name: 'TMA Porto',       lat: 41.24, lon:  -8.68, radiusNM: 45, lower: 1500,  upper: 12500 },
  ];

  // CTRs típicos: cilindros de 5-8 NM alrededor del aeropuerto, hasta ~3000ft.
  const CTRS = [
    { id: 'CTR-LEMD', name: 'CTR Madrid',     lat: 40.49, lon:  -3.57, radiusNM: 8, lower: 0, upper: 3000 },
    { id: 'CTR-LEBL', name: 'CTR Barcelona',  lat: 41.30, lon:   2.08, radiusNM: 7, lower: 0, upper: 3000 },
    { id: 'CTR-LEVC', name: 'CTR Valencia',   lat: 39.49, lon:  -0.48, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEZL', name: 'CTR Sevilla',    lat: 37.42, lon:  -5.90, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEMG', name: 'CTR Málaga',     lat: 36.67, lon:  -4.50, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEBB', name: 'CTR Bilbao',     lat: 43.30, lon:  -2.91, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEPA', name: 'CTR Palma',      lat: 39.55, lon:   2.74, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEAL', name: 'CTR Alicante',   lat: 38.28, lon:  -0.56, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEZG', name: 'CTR Zaragoza',   lat: 41.66, lon:  -1.04, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEST', name: 'CTR Santiago',   lat: 42.90, lon:  -8.41, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-LEAS', name: 'CTR Asturias',   lat: 43.56, lon:  -6.04, radiusNM: 5, lower: 0, upper: 2000 },
    { id: 'CTR-LEXJ', name: 'CTR Santander',  lat: 43.43, lon:  -3.82, radiusNM: 5, lower: 0, upper: 2000 },
    { id: 'CTR-LECO', name: 'CTR A Coruña',   lat: 43.30, lon:  -8.38, radiusNM: 5, lower: 0, upper: 2000 },
    { id: 'CTR-LEAM', name: 'CTR Almería',    lat: 36.84, lon:  -2.37, radiusNM: 5, lower: 0, upper: 2000 },
    { id: 'CTR-LEGR', name: 'CTR Granada',    lat: 37.19, lon:  -3.78, radiusNM: 5, lower: 0, upper: 2000 },
    { id: 'CTR-LEMH', name: 'CTR Menorca',    lat: 39.86, lon:   4.22, radiusNM: 5, lower: 0, upper: 2000 },
    { id: 'CTR-LEIB', name: 'CTR Ibiza',      lat: 38.87, lon:   1.37, radiusNM: 5, lower: 0, upper: 2000 },
    { id: 'CTR-GCLP', name: 'CTR Las Palmas', lat: 27.93, lon: -15.39, radiusNM: 6, lower: 0, upper: 2500 },
    { id: 'CTR-GCTS', name: 'CTR Tenerife',   lat: 28.04, lon: -16.57, radiusNM: 6, lower: 0, upper: 2500 },
  ];

  // Polígonos resultantes (cerrados, [lat,lon]).
  function toPolygon(item, segments) {
    return geom.circleToPolygon([item.lat, item.lon], item.radiusNM * NM_KM, segments || 32);
  }

  const tmaPolygons = TMAS.map(t => Object.assign({}, t, { coords: toPolygon(t, 36) }));
  const ctrPolygons = CTRS.map(t => Object.assign({}, t, { coords: toPolygon(t, 24) }));

  return { tmas: tmaPolygons, ctrs: ctrPolygons };
})();
