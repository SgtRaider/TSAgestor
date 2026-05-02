// Datos geográficos offline (simplificados a mano).
// Coordenadas en formato Leaflet [lat, lon].
// Cobertura: Península Ibérica + islas (Baleares, Canarias) + costas de
// Francia, Italia, UK, Irlanda y N. de África. ~60 ciudades.
// Las coordenadas de ciudades son precisas; las costas/contornos son una
// simplificación (resolución indicativa, NO usar para navegación real).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.offlineGeo = (function () {
  'use strict';

  // Polígono cerrado de la Península Ibérica (Spain + Portugal + frontera Pirineos).
  const iberia = [
    [43.36, -1.78],  // San Sebastián / Hendaya
    [42.95, -1.30], [42.65, 0.15], [42.50, 1.52], [42.43, 2.13], [42.32, 3.32],
    [41.85, 3.20], [41.38, 2.18], [41.12, 1.25], [40.70, 0.55], [39.99, 0.04],
    [39.47, -0.38], [38.73, 0.22], [38.34, -0.49], [37.60, -0.99], [37.40, -1.50],
    [36.84, -2.46], [36.72, -4.42], [36.50, -5.20], [36.00, -5.61],
    [36.53, -6.30], [37.10, -6.85], [37.21, -7.41],
    [37.02, -7.94], [37.02, -8.99],
    [37.95, -8.87], [38.71, -9.14], [38.78, -9.50], [39.36, -9.38],
    [40.14, -8.86], [40.64, -8.65], [41.15, -8.61], [41.69, -8.83],
    [42.23, -8.72], [42.88, -9.27], [43.05, -9.30], [43.77, -7.87],
    [43.66, -5.85], [43.50, -4.80], [43.46, -3.81], [43.26, -2.94],
    [43.36, -1.78],
  ];

  const islands = [
    { name: 'Mallorca', coords: [
      [39.96, 3.10], [39.86, 3.25], [39.59, 3.35], [39.32, 3.04],
      [39.27, 2.78], [39.36, 2.50], [39.55, 2.41], [39.78, 2.44],
      [39.96, 2.78], [39.96, 3.10],
    ]},
    { name: 'Menorca', coords: [
      [40.07, 4.32], [40.05, 4.10], [39.83, 3.85], [39.81, 4.20],
      [39.95, 4.30], [40.07, 4.32],
    ]},
    { name: 'Ibiza', coords: [
      [39.10, 1.32], [39.06, 1.61], [38.90, 1.59], [38.85, 1.34],
      [38.93, 1.21], [39.10, 1.32],
    ]},
    { name: 'Formentera', coords: [
      [38.78, 1.41], [38.72, 1.52], [38.66, 1.46], [38.69, 1.39], [38.78, 1.41],
    ]},
    { name: 'Corsica', coords: [
      [43.00, 9.55], [42.36, 9.55], [41.40, 9.30], [41.40, 8.80],
      [41.85, 8.55], [42.65, 8.65], [43.00, 9.20], [43.00, 9.55],
    ]},
    { name: 'Sardinia', coords: [
      [41.20, 9.20], [41.20, 9.65], [40.50, 9.80], [39.20, 9.65],
      [38.85, 9.05], [39.10, 8.50], [40.00, 8.20], [40.85, 8.20], [41.20, 9.20],
    ]},
    { name: 'Sicily', coords: [
      [38.30, 13.10], [38.20, 14.50], [38.30, 15.65], [37.45, 15.30],
      [36.65, 14.95], [36.65, 12.45], [37.50, 12.40], [38.30, 13.10],
    ]},
    { name: 'Tenerife', coords: [
      [28.59, -16.18], [28.36, -16.10], [28.05, -16.45], [28.10, -16.78],
      [28.36, -16.92], [28.59, -16.55], [28.59, -16.18],
    ]},
    { name: 'Gran Canaria', coords: [
      [28.18, -15.42], [27.99, -15.34], [27.74, -15.42], [27.73, -15.65],
      [27.85, -15.78], [28.10, -15.74], [28.18, -15.42],
    ]},
    { name: 'Lanzarote', coords: [
      [29.45, -13.50], [29.20, -13.42], [28.85, -13.78], [28.95, -13.92],
      [29.30, -13.65], [29.45, -13.50],
    ]},
    { name: 'Fuerteventura', coords: [
      [28.75, -13.85], [28.45, -13.82], [28.06, -14.18], [28.05, -14.45],
      [28.50, -14.10], [28.75, -13.85],
    ]},
    { name: 'La Palma', coords: [
      [28.85, -17.75], [28.50, -17.70], [28.45, -17.95], [28.75, -17.95], [28.85, -17.75],
    ]},
  ];

  // Polilíneas abiertas (costas no cerradas en polígono).
  const coastlines = [
    { name: 'France-Med', coords: [
      [42.42, 3.16], [43.10, 3.20], [43.30, 3.45], [43.40, 5.00],
      [43.20, 5.35], [43.13, 5.93], [43.27, 6.65], [43.55, 7.00],
      [43.71, 7.26], [43.78, 7.50], [44.10, 8.20], [44.41, 8.93],
    ]},
    { name: 'France-Atl', coords: [
      [43.36, -1.78], [43.50, -1.50], [44.65, -1.20], [45.50, -1.10],
      [46.20, -1.20], [47.20, -2.40], [47.50, -3.00], [48.20, -4.30],
      [48.65, -4.55], [48.45, -4.05], [48.65, -2.00], [49.40, -1.20],
      [49.65, 0.10], [50.10, 1.40], [50.95, 1.85],
    ]},
    { name: 'Italy-W', coords: [
      [44.41, 8.93], [44.10, 9.85], [43.85, 10.30], [42.65, 11.10],
      [41.90, 12.50], [41.20, 13.20], [40.85, 14.27], [40.55, 14.95],
      [40.00, 15.65], [39.30, 16.10], [38.95, 16.65], [38.30, 15.95],
    ]},
    { name: 'NorthAfrica', coords: [
      [35.79, -5.93], [35.89, -5.32], [35.30, -2.94], [35.10, -2.00],
      [35.70, -0.63], [36.20, 0.00], [36.50, 2.20], [36.75, 3.06],
      [36.61, 6.85], [37.00, 8.50], [37.05, 9.00],
    ]},
    { name: 'GreatBritain-S', coords: [
      [50.10, -5.50], [50.20, -3.50], [50.65, -1.10], [50.80, 0.30],
      [51.10, 1.40], [51.30, 1.50], [51.85, 1.30], [52.95, 1.70],
    ]},
    { name: 'Ireland', coords: [
      [55.30, -7.30], [55.30, -6.10], [54.20, -5.50], [52.60, -6.10],
      [51.50, -7.50], [51.55, -9.40], [52.20, -10.30], [54.20, -9.40], [55.30, -7.30],
    ]},
  ];

  const cities = [
    // España (capital y ciudades grandes / referencias VFR)
    { name: 'Madrid',     lat: 40.4168, lon: -3.7038, type: 'capital' },
    { name: 'Barcelona',  lat: 41.3851, lon:  2.1734 },
    { name: 'Valencia',   lat: 39.4699, lon: -0.3763 },
    { name: 'Sevilla',    lat: 37.3891, lon: -5.9845 },
    { name: 'Zaragoza',   lat: 41.6488, lon: -0.8891 },
    { name: 'Málaga',     lat: 36.7213, lon: -4.4214 },
    { name: 'Murcia',     lat: 37.9922, lon: -1.1307 },
    { name: 'Palma',      lat: 39.5696, lon:  2.6502 },
    { name: 'Las Palmas', lat: 28.1235, lon: -15.4363 },
    { name: 'Bilbao',     lat: 43.2630, lon: -2.9350 },
    { name: 'Alicante',   lat: 38.3452, lon: -0.4810 },
    { name: 'Córdoba',    lat: 37.8882, lon: -4.7794 },
    { name: 'Valladolid', lat: 41.6523, lon: -4.7245 },
    { name: 'Vigo',       lat: 42.2406, lon: -8.7207 },
    { name: 'Gijón',      lat: 43.5322, lon: -5.6611 },
    { name: 'A Coruña',   lat: 43.3623, lon: -8.4115 },
    { name: 'Granada',    lat: 37.1773, lon: -3.5986 },
    { name: 'Vitoria',    lat: 42.8467, lon: -2.6716 },
    { name: 'Santander',  lat: 43.4623, lon: -3.8099 },
    { name: 'Pamplona',   lat: 42.8125, lon: -1.6458 },
    { name: 'Salamanca',  lat: 40.9701, lon: -5.6635 },
    { name: 'Burgos',     lat: 42.3439, lon: -3.6968 },
    { name: 'Cádiz',      lat: 36.5298, lon: -6.2924 },
    { name: 'Toledo',     lat: 39.8628, lon: -4.0273 },
    { name: 'Albacete',   lat: 38.9942, lon: -1.8585 },
    { name: 'Almería',    lat: 36.8381, lon: -2.4597 },
    { name: 'Castellón',  lat: 39.9864, lon: -0.0513 },
    { name: 'Tarragona',  lat: 41.1189, lon:  1.2445 },
    { name: 'Logroño',    lat: 42.4627, lon: -2.4449 },
    { name: 'Huelva',     lat: 37.2614, lon: -6.9447 },
    { name: 'Lleida',     lat: 41.6176, lon:  0.6200 },
    { name: 'Girona',     lat: 41.9794, lon:  2.8214 },
    { name: 'S.C. Tenerife', lat: 28.4636, lon: -16.2518 },
    { name: 'Talavera',   lat: 39.9617, lon: -4.8338 },
    { name: 'Cáceres',    lat: 39.4753, lon: -6.3724 },
    { name: 'Badajoz',    lat: 38.8794, lon: -6.9707 },
    { name: 'Ourense',    lat: 42.3409, lon: -7.8639 },
    { name: 'León',       lat: 42.5987, lon: -5.5671 },
    { name: 'Oviedo',     lat: 43.3614, lon: -5.8593 },

    // Portugal
    { name: 'Lisboa',     lat: 38.7223, lon: -9.1393, type: 'capital' },
    { name: 'Porto',      lat: 41.1579, lon: -8.6291 },
    { name: 'Coimbra',    lat: 40.2033, lon: -8.4103 },
    { name: 'Faro',       lat: 37.0194, lon: -7.9304 },
    { name: 'Évora',      lat: 38.5711, lon: -7.9135 },

    // Francia
    { name: 'Paris',      lat: 48.8566, lon:  2.3522, type: 'capital' },
    { name: 'Marseille',  lat: 43.2965, lon:  5.3698 },
    { name: 'Lyon',       lat: 45.7640, lon:  4.8357 },
    { name: 'Toulouse',   lat: 43.6047, lon:  1.4442 },
    { name: 'Bordeaux',   lat: 44.8378, lon: -0.5792 },
    { name: 'Nice',       lat: 43.7102, lon:  7.2620 },
    { name: 'Perpignan',  lat: 42.6886, lon:  2.8946 },
    { name: 'Nantes',     lat: 47.2184, lon: -1.5536 },

    // Otras capitales europeas
    { name: 'London',     lat: 51.5074, lon: -0.1278, type: 'capital' },
    { name: 'Dublin',     lat: 53.3498, lon: -6.2603, type: 'capital' },
    { name: 'Roma',       lat: 41.9028, lon: 12.4964, type: 'capital' },
    { name: 'Milano',     lat: 45.4642, lon:  9.1900 },
    { name: 'Napoli',     lat: 40.8518, lon: 14.2681 },
    { name: 'Palermo',    lat: 38.1157, lon: 13.3613 },
    { name: 'Bruxelles',  lat: 50.8503, lon:  4.3517, type: 'capital' },
    { name: 'Amsterdam',  lat: 52.3676, lon:  4.9041, type: 'capital' },
    { name: 'Berlin',     lat: 52.5200, lon: 13.4050, type: 'capital' },
    { name: 'Bern',       lat: 46.9481, lon:  7.4474, type: 'capital' },
    { name: 'Andorra',    lat: 42.5063, lon:  1.5218, type: 'capital' },

    // N. de África
    { name: 'Tánger',     lat: 35.7595, lon: -5.8340 },
    { name: 'Rabat',      lat: 34.0209, lon: -6.8417, type: 'capital' },
    { name: 'Casablanca', lat: 33.5731, lon: -7.5898 },
    { name: 'Marrakech',  lat: 31.6295, lon: -7.9811 },
    { name: 'Alger',      lat: 36.7538, lon:  3.0588, type: 'capital' },
    { name: 'Tunis',      lat: 36.8065, lon: 10.1815, type: 'capital' },
  ];

  return { iberia, islands, coastlines, cities };
})();
