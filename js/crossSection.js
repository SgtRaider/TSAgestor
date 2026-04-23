// Corte transversal geográfico: proyecta las TSAs sobre la recta geodésica
// centroide(primera) → centroide(última) y dibuja rectángulos altitud × distancia.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.crossSection = (function () {
  'use strict';

  const geom = window.TSAgestor.geom;
  const NS = 'http://www.w3.org/2000/svg';

  const BAND_COLORS = { low: '#22c55e', mid: '#f59e0b', high: '#ef4444' };

  function el(tag, attrs, children) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (children) for (const c of children) e.appendChild(c);
    return e;
  }

  function text(x, y, str, attrs) {
    const t = el('text', Object.assign({ x, y }, attrs || {}));
    t.textContent = str;
    return t;
  }

  // Elige par de TSAs más distantes como extremos A/B del corte.
  function chooseExtremes(tsas) {
    let best = { i: 0, j: 1, d: -1 };
    for (let i = 0; i < tsas.length; i++) {
      for (let j = i + 1; j < tsas.length; j++) {
        const d = geom.greatCircleDistance(tsas[i].centroid, tsas[j].centroid);
        if (d > best.d) best = { i, j, d };
      }
    }
    return { A: tsas[best.i], B: tsas[best.j], distance: best.d };
  }

  // Construye datos (rectángulos) ordenados por along-track distance del centroide.
  function buildRects(tsas, A, B) {
    const rects = tsas.map(tsa => {
      const range = geom.polygonAlongTrackRange(tsa.polygon, A.centroid, B.centroid);
      const centreKm = geom.alongTrackDistance(A.centroid, B.centroid, tsa.centroid);
      return {
        tsa,
        xMin: Math.min(range.minKm, range.maxKm),
        xMax: Math.max(range.minKm, range.maxKm),
        centreKm,
        yMin: tsa.vertical.lowerFt,
        yMax: Math.max(tsa.vertical.lowerFt + 100, tsa.vertical.upperFt),
      };
    });
    rects.sort((a, b) => a.centreKm - b.centreKm);
    return rects;
  }

  function formatFL(ft) {
    if (ft >= 99999) return 'UNL';
    if (ft <= 0) return 'GND';
    if (ft >= 10000) return 'FL' + Math.round(ft / 100);
    return ft + 'FT';
  }

  function render(svgEl, tsas) {
    // Limpia el SVG
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    if (!tsas || tsas.length < 2) {
      svgEl.setAttribute('viewBox', '0 0 600 200');
      svgEl.setAttribute('width', '600');
      svgEl.setAttribute('height', '200');
      svgEl.appendChild(text(300, 100, 'Se necesitan al menos 2 TSAs para el corte', {
        'text-anchor': 'middle', fill: '#64748b', 'font-size': '14', 'font-family': 'sans-serif',
      }));
      return { ok: false };
    }

    const { A, B, distance } = chooseExtremes(tsas);
    const rects = buildRects(tsas, A, B);

    // Normaliza X para que A quede en 0 (descartamos offsets negativos).
    const xMinRaw = Math.min(...rects.map(r => r.xMin), 0);
    rects.forEach(r => { r.xMin -= xMinRaw; r.xMax -= xMinRaw; });

    const maxX = Math.max(distance - xMinRaw, ...rects.map(r => r.xMax));
    const maxY = Math.max(...rects.map(r => r.yMax), 10000) * 1.1;
    const minY = 0;

    // Layout
    const width = Math.max(900, 120 + rects.length * 120);
    const height = 560;
    const pad = { left: 80, right: 40, top: 70, bottom: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const xScale = km => pad.left + (km / maxX) * plotW;
    const yScale = ft => pad.top + plotH - ((ft - minY) / (maxY - minY)) * plotH;

    svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svgEl.setAttribute('width', width);
    svgEl.setAttribute('height', height);
    svgEl.setAttribute('font-family', 'sans-serif');

    // Fondo blanco (garantiza PNG opaco al exportar)
    svgEl.appendChild(el('rect', { x: 0, y: 0, width, height, fill: '#ffffff' }));

    // Título
    svgEl.appendChild(text(width / 2, 28,
      `Corte transversal: ${A.name} → ${B.name}`,
      { 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700, fill: '#0f172a' }
    ));
    svgEl.appendChild(text(width / 2, 48,
      `Distancia geodésica: ${distance.toFixed(1)} km · ${rects.length} TSAs proyectadas`,
      { 'text-anchor': 'middle', 'font-size': 12, fill: '#475569' }
    ));

    // Gridlines Y cada 5000 ft + etiquetas
    for (let ft = 0; ft <= maxY; ft += 5000) {
      const y = yScale(ft);
      svgEl.appendChild(el('line', {
        x1: pad.left, y1: y, x2: width - pad.right, y2: y,
        stroke: '#e2e8f0', 'stroke-width': 1,
      }));
      svgEl.appendChild(text(pad.left - 8, y + 4, formatFL(ft), {
        'text-anchor': 'end', 'font-size': 10, fill: '#64748b',
      }));
    }

    // Eje X: marcas cada ~round(maxX/8) km
    const xStep = Math.max(10, Math.round(maxX / 8 / 10) * 10);
    for (let km = 0; km <= maxX; km += xStep) {
      const x = xScale(km);
      svgEl.appendChild(el('line', {
        x1: x, y1: pad.top, x2: x, y2: height - pad.bottom,
        stroke: '#f1f5f9', 'stroke-width': 1,
      }));
      svgEl.appendChild(text(x, height - pad.bottom + 16, km + ' km', {
        'text-anchor': 'middle', 'font-size': 10, fill: '#64748b',
      }));
    }

    // Ejes
    svgEl.appendChild(el('line', {
      x1: pad.left, y1: pad.top, x2: pad.left, y2: height - pad.bottom,
      stroke: '#334155', 'stroke-width': 1.5,
    }));
    svgEl.appendChild(el('line', {
      x1: pad.left, y1: height - pad.bottom, x2: width - pad.right, y2: height - pad.bottom,
      stroke: '#334155', 'stroke-width': 1.5,
    }));
    svgEl.appendChild(text(pad.left - 55, pad.top - 10, 'Altitud', {
      'font-size': 11, 'font-weight': 600, fill: '#0f172a',
    }));
    svgEl.appendChild(text(width - pad.right, height - pad.bottom + 35,
      'Distancia a lo largo del corte', {
      'text-anchor': 'end', 'font-size': 11, 'font-weight': 600, fill: '#0f172a',
    }));

    // Definición de pattern para solapes
    const defs = el('defs');
    const pat = el('pattern', { id: 'overlapHatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.appendChild(el('rect', { width: 8, height: 8, fill: 'rgba(15,23,42,0.0)' }));
    pat.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#0f172a', 'stroke-width': 2 }));
    defs.appendChild(pat);
    svgEl.appendChild(defs);

    // Rectángulos TSA
    for (const r of rects) {
      const band = geom.altitudeBand(r.yMax);
      const color = BAND_COLORS[band];
      const x = xScale(r.xMin);
      const y = yScale(r.yMax);
      const w = Math.max(6, xScale(r.xMax) - xScale(r.xMin));
      const h = Math.max(4, yScale(r.yMin) - yScale(r.yMax));

      svgEl.appendChild(el('rect', {
        x, y, width: w, height: h,
        fill: color, 'fill-opacity': 0.35, stroke: color, 'stroke-width': 1.5,
      }));

      // Etiquetas dentro o encima del rectángulo
      const cx = x + w / 2;
      svgEl.appendChild(text(cx, y - 4, r.tsa.name, {
        'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#0f172a',
      }));
      svgEl.appendChild(text(cx, y + h / 2 + 4,
        `${r.tsa.vertical.lowerLabel} – ${r.tsa.vertical.upperLabel}`, {
        'text-anchor': 'middle', 'font-size': 10, fill: '#0f172a',
      }));
    }

    // Solapes
    const labelSlots = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const ov = geom.rectOverlap(rects[i], rects[j]);
        if (!ov) continue;
        const x = xScale(ov.xMin);
        const y = yScale(ov.yMax);
        const w = Math.max(2, xScale(ov.xMax) - xScale(ov.xMin));
        const h = Math.max(2, yScale(ov.yMin) - yScale(ov.yMax));
        svgEl.appendChild(el('rect', {
          x, y, width: w, height: h,
          fill: 'url(#overlapHatch)', stroke: '#0f172a', 'stroke-width': 1, 'stroke-dasharray': '3 2',
        }));
        labelSlots.push({
          x: x + w / 2,
          y: y + h / 2,
          text: `Solape ${rects[i].tsa.name} × ${rects[j].tsa.name}: ${formatFL(ov.yMin)}–${formatFL(ov.yMax)}`,
        });
      }
    }

    // Leyenda inferior con etiquetas de solapes (máx 6, resto agrupado).
    if (labelSlots.length) {
      const startY = height - pad.bottom + 35;
      const listX = pad.left;
      svgEl.appendChild(text(listX, startY, 'Solapes detectados:', {
        'font-size': 11, 'font-weight': 700, fill: '#0f172a',
      }));
      const shown = labelSlots.slice(0, 6);
      shown.forEach((l, i) => {
        svgEl.appendChild(text(listX + 130 + (i % 2) * 320, startY + Math.floor(i / 2) * 14,
          '• ' + l.text, { 'font-size': 10, fill: '#334155' }));
      });
      if (labelSlots.length > 6) {
        svgEl.appendChild(text(listX + 130, startY + Math.ceil(shown.length / 2) * 14,
          `…y ${labelSlots.length - 6} solapes más`, { 'font-size': 10, fill: '#64748b' }));
      }
    }

    return { ok: true, overlapCount: labelSlots.length, extremes: { A: A.name, B: B.name }, distance };
  }

  async function toPNGDataURL(svgEl, scale) {
    scale = scale || 2;
    const svgStr = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const vb = svgEl.viewBox.baseVal;
      const w = (vb && vb.width) ? vb.width : svgEl.clientWidth || 900;
      const h = (vb && vb.height) ? vb.height : svgEl.clientHeight || 560;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  return { render, toPNGDataURL };
})();
