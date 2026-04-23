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
  };
})();
