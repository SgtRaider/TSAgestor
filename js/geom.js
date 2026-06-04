// Utilidades geométricas puras sobre la esfera terrestre.
// Distancias en km, altitudes en pies, coordenadas [lat, lon] en grados.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.geom = (function () {
  'use strict';

  const R = 6371.0088; // radio medio terrestre en km
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;

  function centroid(polygon) {
    if (!polygon || polygon.length === 0) return [0, 0];
    let lat = 0, lon = 0;
    for (const [a, b] of polygon) { lat += a; lon += b; }
    return [lat / polygon.length, lon / polygon.length];
  }

  function greatCircleDistance(a, b) {
    const φ1 = toRad(a[0]), φ2 = toRad(b[0]);
    const Δφ = toRad(b[0] - a[0]);
    const Δλ = toRad(b[1] - a[1]);
    const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const φ1 = toRad(a[0]), φ2 = toRad(b[0]);
    const Δλ = toRad(b[1] - a[1]);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Along-track distance (km) de A→B del punto P proyectado sobre la geodésica.
  // Puede ser negativo (antes de A) o mayor que |AB| (después de B).
  function alongTrackDistance(A, B, P) {
    const d13 = greatCircleDistance(A, P) / R; // angular
    if (d13 === 0) return 0;
    const θ13 = toRad(bearing(A, P));
    const θ12 = toRad(bearing(A, B));
    const dxt = Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12));
    const dat = Math.acos(Math.cos(d13) / Math.max(1e-12, Math.cos(dxt)));
    const sign = Math.cos(θ12 - θ13) >= 0 ? 1 : -1;
    return sign * dat * R;
  }

  // Rango [min, max] de along-track distances para todos los vértices del polígono.
  function polygonAlongTrackRange(polygon, A, B) {
    let min = Infinity, max = -Infinity;
    for (const p of polygon) {
      const d = alongTrackDistance(A, B, p);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { minKm: min, maxKm: max };
  }

  // Intersección rectangular en (X, Y). null si no solapan.
  function rectOverlap(r1, r2) {
    const x1 = Math.max(r1.xMin, r2.xMin);
    const x2 = Math.min(r1.xMax, r2.xMax);
    const y1 = Math.max(r1.yMin, r2.yMin);
    const y2 = Math.min(r1.yMax, r2.yMax);
    if (x1 >= x2 || y1 >= y2) return null;
    return { xMin: x1, xMax: x2, yMin: y1, yMax: y2 };
  }

  // Destino dado punto, rumbo (grados) y distancia (km) — para aproximar círculos ICAO.
  function destinationPoint(origin, bearingDeg, distanceKm) {
    const δ = distanceKm / R;
    const θ = toRad(bearingDeg);
    const φ1 = toRad(origin[0]);
    const λ1 = toRad(origin[1]);
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
    return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
  }

  function circleToPolygon(center, radiusKm, segments) {
    segments = segments || 36;
    const pts = [];
    for (let i = 0; i < segments; i++) {
      pts.push(destinationPoint(center, (360 * i) / segments, radiusKm));
    }
    return pts;
  }

  // Banda de altitud (para colorear): low <10000ft, mid <24500ft, high resto.
  function altitudeBand(upperFt) {
    if (upperFt <= 10000) return 'low';
    if (upperFt <= 24500) return 'mid';
    return 'high';
  }

  // ─── KIAS → TAS via tabla bilineal ─────────────────────────────────
  // Tabla suministrada por el usuario. Filas = altitud densidad (pies),
  // columnas = KIAS. Las celdas vacias (null) representan puntos fuera
  // del rango de operacion practica (TAS muy altas a poca KIAS son
  // imposibles, p.ej. 180 KIAS a 28000+ ft).
  const TAS_DA   = [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000,
                    20000, 22000, 24000, 26000, 28000, 30000, 32000, 34000, 36000];
  const TAS_KIAS = [60, 80, 100, 120, 140, 160, 180];
  const TAS_TABLE = [
    [ 60,  80, 100, 120, 140, 160, 180],
    [ 62,  82, 103, 124, 144, 165, 185],
    [ 64,  85, 106, 127, 149, 170, 191],
    [ 66,  88, 109, 131, 153, 175, 197],
    [ 68,  90, 113, 135, 158, 180, 203],
    [ 70,  93, 116, 140, 163, 186, 209],
    [ 72,  96, 120, 144, 168, 192, 216],
    [ 74,  99, 124, 149, 174, 198, 223],
    [ 77, 103, 128, 154, 179, 205, 231],
    [ 79, 106, 132, 159, 185, 212, 238],
    [ 82, 110, 137, 164, 192, 219, 247],
    [ 85, 113, 142, 170, 198, 227, null],
    [ 88, 117, 147, 176, 205, 235, null],
    [ 91, 122, 152, 182, 213, 243, null],
    [ 95, 126, 158, 189, 221, null, null],
    [ 98, 131, 163, 196, 229, null, null],
    [102, 136, 170, 204, 238, null, null],
    [106, 141, 176, 211, 247, null, null],
    [110, 147, 183, 220, null, null, null],
  ];

  // Busca el indice inferior del array para hacer interpolacion lineal.
  // Devuelve [i0, i1, t] tal que val esta en [arr[i0], arr[i1]] y
  // t = (val - arr[i0]) / (arr[i1] - arr[i0]). Extrapola con clamping.
  function _bracket(arr, val) {
    if (val <= arr[0]) return [0, 0, 0];
    if (val >= arr[arr.length - 1]) return [arr.length - 1, arr.length - 1, 0];
    for (let i = 0; i < arr.length - 1; i++) {
      if (val >= arr[i] && val <= arr[i + 1]) {
        const t = (val - arr[i]) / (arr[i + 1] - arr[i]);
        return [i, i + 1, t];
      }
    }
    return [arr.length - 1, arr.length - 1, 0];
  }

  // Lookup bilineal TAS(KIAS, altitud_densidad_ft). Si alguna esquina
  // de la celda es null (fuera de rango operativo), usamos la mas
  // cercana disponible en la columna.
  function kiasToTAS(kias, daFt) {
    if (!Number.isFinite(kias) || kias <= 0) return kias;
    if (!Number.isFinite(daFt)) daFt = 0;
    const [r0, r1, tr] = _bracket(TAS_DA,   daFt);
    const [c0, c1, tc] = _bracket(TAS_KIAS, kias);
    // Si la celda destino tiene null, hace fallback a la fila previa con valor.
    function cell(r, c) {
      let v = TAS_TABLE[r][c];
      if (v != null) return v;
      // Sube por la columna hasta encontrar una fila con dato.
      for (let rr = r - 1; rr >= 0; rr--) {
        if (TAS_TABLE[rr][c] != null) return TAS_TABLE[rr][c];
      }
      return null;
    }
    const v00 = cell(r0, c0), v01 = cell(r0, c1);
    const v10 = cell(r1, c0), v11 = cell(r1, c1);
    // Si todo es null, devolvemos KIAS (sin correccion).
    if (v00 == null && v01 == null && v10 == null && v11 == null) return kias;
    const v0 = (v00 == null ? v01 : v01 == null ? v00 : v00 + (v01 - v00) * tc);
    const v1 = (v10 == null ? v11 : v11 == null ? v10 : v10 + (v11 - v10) * tc);
    if (v0 == null) return v1;
    if (v1 == null) return v0;
    return v0 + (v1 - v0) * tr;
  }

  // ─── Density Altitude ─────────────────────────────────────────────
  // Para que el lookup TAS sea correcto cuando la atmosfera real difiere
  // del modelo ISA. En dias calidos a la cota de cruise, la DA puede
  // ser >2000 ft por encima del FL (densidad menor -> TAS mas alta para
  // la misma KIAS).
  //
  // ISA temp (°C) en altitud de presion PA (ft): 15 - 1.98 * PA/1000.
  function isaTempC(paFt) {
    if (!Number.isFinite(paFt)) return 15;
    return 15 - 1.98 * (paFt / 1000);
  }
  // Density Altitude (ft) por la regla estandar de aviacion:
  //   DA = PA + 118.8 * (OAT - ISA_temp(PA))
  // (118.8 es el factor empirico usado en cartas y formularios POH;
  // a veces se ve redondeado a 120). Si OAT no esta disponible,
  // devuelve PA (asume ISA).
  function densityAltitudeFt(paFt, oatC) {
    if (!Number.isFinite(paFt)) return paFt;
    if (!Number.isFinite(oatC)) return paFt;
    return paFt + 118.8 * (oatC - isaTempC(paFt));
  }

  // Distancia mínima de un punto P a un segmento geodésico AB (km).
  function pointToSegmentKm(P, A, B) {
    const dAB = greatCircleDistance(A, B);
    if (dAB < 1e-6) return greatCircleDistance(P, A);
    const along = alongTrackDistance(A, B, P);
    if (along <= 0) return greatCircleDistance(P, A);
    if (along >= dAB) return greatCircleDistance(P, B);
    // Cross-track aproximado en plano local: √(dPA² − along²)
    const dPA = greatCircleDistance(P, A);
    return Math.sqrt(Math.max(0, dPA * dPA - along * along));
  }

  // Distancia mínima de un punto P a una polilínea (array de [lat,lon]).
  function pointToPolylineKm(P, polyline) {
    if (!polyline || polyline.length === 0) return Infinity;
    if (polyline.length === 1) return greatCircleDistance(P, polyline[0]);
    let best = Infinity;
    for (let i = 0; i < polyline.length - 1; i++) {
      const d = pointToSegmentKm(P, polyline[i], polyline[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  return {
    centroid,
    greatCircleDistance,
    bearing,
    alongTrackDistance,
    polygonAlongTrackRange,
    rectOverlap,
    destinationPoint,
    circleToPolygon,
    altitudeBand,
    pointToSegmentKm,
    pointToPolylineKm,
    kiasToTAS,
    isaTempC,
    densityAltitudeFt,
  };
})();
