// Corte transversal geográfico multi-panel.
// Proyecta las TSAs sobre la recta geodésica centroide(primera) → centroide(última)
// y divide el eje X en hasta 3 paneles cuando hay muchas TSAs, de modo que los
// nombres y altitudes queden legibles sin perder la visibilidad de los solapes.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.crossSection = (function () {
  'use strict';

  const geom = window.TSAgestor.geom;
  const NS = 'http://www.w3.org/2000/svg';

  const BAND_COLORS = { low: '#22c55e', mid: '#f59e0b', high: '#ef4444' };

  const WIDTH = 1100;
  const PANEL_H = 440;
  const PANEL_GAP = 28;
  const HEADER_H = 60;
  const FOOTER_H = 80;

  // ── DOM helpers ──────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (children) for (const c of children) e.appendChild(c);
    return e;
  }

  // Texto con "halo" blanco alrededor para máxima legibilidad sobre cualquier fondo.
  function haloText(x, y, str, attrs) {
    const t = el('text', Object.assign({
      x, y,
      'font-family': 'sans-serif',
      'paint-order': 'stroke',
      stroke: '#ffffff',
      'stroke-width': 3,
      'stroke-linejoin': 'round',
    }, attrs || {}));
    t.textContent = str;
    return t;
  }

  function text(x, y, str, attrs) {
    const t = el('text', Object.assign({ x, y, 'font-family': 'sans-serif' }, attrs || {}));
    t.textContent = str;
    return t;
  }

  // ── Pre-cálculos globales ────────────────────────────────────────────
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

  function buildRects(tsas, A, B) {
    return tsas.map((tsa, idx) => {
      const range = geom.polygonAlongTrackRange(tsa.polygon, A.centroid, B.centroid);
      const centreKm = geom.alongTrackDistance(A.centroid, B.centroid, tsa.centroid);
      return {
        idx,
        tsa,
        xMin: Math.min(range.minKm, range.maxKm),
        xMax: Math.max(range.minKm, range.maxKm),
        centreKm,
        yMin: tsa.vertical.lowerFt,
        yMax: Math.max(tsa.vertical.lowerFt + 100, tsa.vertical.upperFt),
      };
    });
  }

  function formatFL(ft) {
    if (ft >= 99999) return 'UNL';
    if (ft <= 0) return 'GND';
    if (ft >= 10000) return 'FL' + Math.round(ft / 100);
    return ft + 'FT';
  }

  // Decide cuántos paneles (1–3) según el número de TSAs.
  function decidePanelCount(n) {
    if (n <= 5) return 1;
    if (n <= 10) return 2;
    return 3;
  }

  // Divide las TSAs en nPanels grupos por along-track centroide (tertiles).
  // Cada panel incluye TAMBIÉN las TSAs cuyo [xMin,xMax] se solapa con su tramo X
  // (así se ven los solapes aunque la TSA pertenezca a otro grupo).
  function buildPanels(rects, nPanels, totalXMax) {
    const sorted = [...rects].sort((a, b) => a.centreKm - b.centreKm);
    const out = [];
    for (let i = 0; i < nPanels; i++) {
      const lo = Math.floor((i * sorted.length) / nPanels);
      const hi = Math.floor(((i + 1) * sorted.length) / nPanels);
      const primary = sorted.slice(lo, hi);
      if (!primary.length) continue;

      let xMin = Infinity, xMax = -Infinity;
      for (const r of primary) { xMin = Math.min(xMin, r.xMin); xMax = Math.max(xMax, r.xMax); }

      // Margen extra para que los bordes de los rectángulos no queden pegados al borde.
      const span = Math.max(1, xMax - xMin);
      const margin = span * 0.08 + 3;
      xMin = Math.max(0, xMin - margin);
      xMax = Math.min(totalXMax, xMax + margin);

      // Incluye cualquier TSA que toque este rango (para detectar solapes cross-panel).
      const members = rects.filter(r => r.xMax > xMin && r.xMin < xMax);
      const primaryIds = new Set(primary.map(r => r.idx));

      out.push({ xMinKm: xMin, xMaxKm: xMax, members, primaryIds });
    }
    return out;
  }

  // Medición real de texto con canvas 2D (cacheado). Permite stagger preciso.
  let _measureCtx = null;
  function measureText(str, fontSize, bold) {
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = (bold ? 'bold ' : '') + fontSize + 'px sans-serif';
    return _measureCtx.measureText(str).width;
  }

  // Layout de callouts (nombre + altitud apilados) encima de cada rect.
  //  - Ancho = max(anchoNombre, anchoAltitud) + padding
  //  - Stagger greedy por filas sobre ese ancho real
  //  - Devuelve las Y exactas de la línea de nombre y la línea de altitud
  function layoutCallouts(panelRects, xScale, yScale) {
    const NAME_SIZE = 12;
    const ALT_SIZE  = 10;
    const LINE_GAP  = 2;
    const ROW_GAP   = 4;
    const ROW_H     = NAME_SIZE + LINE_GAP + ALT_SIZE + ROW_GAP; // ~28 px
    const H_PAD     = 6;
    const rows = [];
    const out = [];
    const ordered = [...panelRects].sort((a, b) => a.xMin - b.xMin);

    for (const r of ordered) {
      const altStr = `${r.tsa.vertical.lowerLabel} – ${r.tsa.vertical.upperLabel}`;
      const wName  = measureText(r.tsa.name, NAME_SIZE, true);
      const wAlt   = measureText(altStr, ALT_SIZE, false);
      const blockW = Math.max(wName, wAlt) + H_PAD * 2;

      const cx = (xScale(r.xMin) + xScale(r.xMax)) / 2;
      const xL = cx - blockW / 2;
      const xR = cx + blockW / 2;
      const rectTopY = yScale(r.yMax);

      let row = 0;
      while (true) {
        if (!rows[row]) rows[row] = [];
        const collide = rows[row].some(b => !(xR < b.xL || xL > b.xR));
        if (!collide) { rows[row].push({ xL, xR }); break; }
        row++;
      }
      // Callout "anclado" arriba del rect:
      //   baseY del bloque = rectTopY - 6 - row*ROW_H
      //   altY (línea inferior)     = baseY
      //   nameY (línea superior)    = baseY - LINE_GAP - ALT_SIZE
      const altY  = rectTopY - 6 - row * ROW_H;
      const nameY = altY - LINE_GAP - ALT_SIZE;
      out.push({ r, cx, xL, xR, altStr, nameY, altY, rectTopY, row });
    }
    return out;
  }

  // ── Render de un panel ───────────────────────────────────────────────
  function renderPanel(svg, panel, panelIndex, nPanels, topPx, maxY, defsAdded) {
    const pad = { left: 80, right: 40, top: 100, bottom: 40 };
    const plotW = WIDTH - pad.left - pad.right;
    const plotH = PANEL_H - pad.top - pad.bottom;
    const plotTop = topPx + pad.top;
    const plotBottom = plotTop + plotH;

    const span = Math.max(1, panel.xMaxKm - panel.xMinKm);
    const xScale = km => pad.left + ((km - panel.xMinKm) / span) * plotW;
    const yScale = ft => plotBottom - (ft / maxY) * plotH;

    // Título del panel
    const title = (nPanels > 1 ? `Tramo ${panelIndex + 1}/${nPanels} · ` : '') +
      `${panel.xMinKm.toFixed(0)}–${panel.xMaxKm.toFixed(0)} km`;
    svg.appendChild(text(pad.left, topPx + 24, title, {
      'font-size': 13, 'font-weight': 700, fill: '#0f172a',
    }));

    // Y grid + etiquetas altitud
    for (let ft = 0; ft <= maxY; ft += 5000) {
      const y = yScale(ft);
      svg.appendChild(el('line', {
        x1: pad.left, y1: y, x2: WIDTH - pad.right, y2: y,
        stroke: '#e2e8f0', 'stroke-width': 1,
      }));
      svg.appendChild(text(pad.left - 8, y + 4, formatFL(ft), {
        'text-anchor': 'end', 'font-size': 10, fill: '#64748b',
      }));
    }

    // X ticks (~6 divisiones)
    const xStep = niceStep(span / 6);
    const xStart = Math.ceil(panel.xMinKm / xStep) * xStep;
    for (let km = xStart; km <= panel.xMaxKm; km += xStep) {
      const x = xScale(km);
      svg.appendChild(el('line', {
        x1: x, y1: plotTop, x2: x, y2: plotBottom,
        stroke: '#f1f5f9', 'stroke-width': 1,
      }));
      svg.appendChild(text(x, plotBottom + 14, Math.round(km) + ' km', {
        'text-anchor': 'middle', 'font-size': 10, fill: '#64748b',
      }));
    }

    // Ejes
    svg.appendChild(el('line', {
      x1: pad.left, y1: plotTop, x2: pad.left, y2: plotBottom,
      stroke: '#334155', 'stroke-width': 1.5,
    }));
    svg.appendChild(el('line', {
      x1: pad.left, y1: plotBottom, x2: WIDTH - pad.right, y2: plotBottom,
      stroke: '#334155', 'stroke-width': 1.5,
    }));
    svg.appendChild(text(pad.left - 60, topPx + 40, 'Altitud', {
      'font-size': 11, 'font-weight': 600, fill: '#0f172a',
    }));

    // Clip-path para que nada pinte fuera del plot del panel
    const clipId = `clip-panel-${panelIndex}`;
    const defs = svg.querySelector('defs') || svg.insertBefore(el('defs'), svg.firstChild);
    const cp = el('clipPath', { id: clipId });
    cp.appendChild(el('rect', { x: pad.left, y: plotTop, width: plotW, height: plotH }));
    defs.appendChild(cp);
    const g = el('g', { 'clip-path': `url(#${clipId})` });
    svg.appendChild(g);

    // Rectángulos TSA: primero secundarios (cruzan el panel) con menor opacidad,
    // luego primarios encima.
    const primary = panel.members.filter(r => panel.primaryIds.has(r.idx));
    const secondary = panel.members.filter(r => !panel.primaryIds.has(r.idx));

    const drawRect = (r, isPrimary) => {
      const band = geom.altitudeBand(r.yMax);
      const color = BAND_COLORS[band];
      const x = xScale(r.xMin);
      const y = yScale(r.yMax);
      const w = Math.max(6, xScale(r.xMax) - xScale(r.xMin));
      const h = Math.max(4, yScale(r.yMin) - yScale(r.yMax));

      g.appendChild(el('rect', {
        x, y, width: w, height: h,
        fill: color,
        'fill-opacity': isPrimary ? 0.38 : 0.15,
        stroke: color,
        'stroke-width': isPrimary ? 1.8 : 1,
        'stroke-dasharray': isPrimary ? '' : '4 3',
      }));
    };
    secondary.forEach(r => drawRect(r, false));
    primary.forEach(r => drawRect(r, true));

    // Solapes entre miembros del panel: hatch + borde punteado
    if (!defsAdded.hatch) {
      const pat = el('pattern', {
        id: 'overlapHatch', width: 8, height: 8,
        patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
      });
      pat.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#0f172a', 'stroke-width': 2 }));
      defs.appendChild(pat);
      defsAdded.hatch = true;
    }
    for (let i = 0; i < panel.members.length; i++) {
      for (let j = i + 1; j < panel.members.length; j++) {
        const a = panel.members[i], b = panel.members[j];
        const ov = geom.rectOverlap(a, b);
        if (!ov) continue;
        const x = xScale(ov.xMin);
        const y = yScale(ov.yMax);
        const w = Math.max(2, xScale(ov.xMax) - xScale(ov.xMin));
        const h = Math.max(2, yScale(ov.yMin) - yScale(ov.yMax));
        g.appendChild(el('rect', {
          x, y, width: w, height: h,
          fill: 'url(#overlapHatch)',
          stroke: '#0f172a', 'stroke-width': 1.2, 'stroke-dasharray': '3 2',
        }));
      }
    }

    // Callouts (nombre + altitud apilados) sólo para primarios.
    const callouts = layoutCallouts(primary, xScale, yScale);
    for (const co of callouts) {
      if (co.row > 0) {
        svg.appendChild(el('line', {
          x1: co.cx, y1: co.rectTopY, x2: co.cx, y2: co.altY + 3,
          stroke: '#94a3b8', 'stroke-width': 1, 'stroke-dasharray': '2 2',
        }));
      }
      svg.appendChild(haloText(co.cx, co.nameY, co.r.tsa.name, {
        'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#0f172a',
      }));
      svg.appendChild(haloText(co.cx, co.altY, co.altStr, {
        'text-anchor': 'middle', 'font-size': 10, fill: '#334155',
      }));
    }
  }

  function niceStep(v) {
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    if (n < 1.5) return 1 * pow;
    if (n < 3) return 2 * pow;
    if (n < 7) return 5 * pow;
    return 10 * pow;
  }

  // ── Render principal ─────────────────────────────────────────────────
  function render(svgEl, tsas) {
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    if (!tsas || tsas.length < 2) {
      svgEl.setAttribute('viewBox', '0 0 600 200');
      svgEl.setAttribute('width', '600');
      svgEl.setAttribute('height', '200');
      svgEl.appendChild(text(300, 100, 'Se necesitan al menos 2 TSAs para el corte', {
        'text-anchor': 'middle', fill: '#64748b', 'font-size': 14,
      }));
      return { ok: false };
    }

    const { A, B, distance } = chooseExtremes(tsas);
    const rects = buildRects(tsas, A, B);

    // Normaliza a partir de 0 en A
    const xMinRaw = Math.min(0, ...rects.map(r => r.xMin));
    rects.forEach(r => { r.xMin -= xMinRaw; r.xMax -= xMinRaw; });
    const totalXMax = Math.max(distance - xMinRaw, ...rects.map(r => r.xMax));
    const maxY = Math.max(...rects.map(r => r.yMax), 10000) * 1.1;

    const nPanels = decidePanelCount(rects.length);
    const panels = buildPanels(rects, nPanels, totalXMax);

    const height =
      HEADER_H +
      panels.length * PANEL_H +
      (panels.length - 1) * PANEL_GAP +
      FOOTER_H;

    svgEl.setAttribute('viewBox', `0 0 ${WIDTH} ${height}`);
    svgEl.setAttribute('width', WIDTH);
    svgEl.setAttribute('height', height);
    svgEl.setAttribute('font-family', 'sans-serif');
    svgEl.appendChild(el('rect', { x: 0, y: 0, width: WIDTH, height, fill: '#ffffff' }));

    // Cabecera
    svgEl.appendChild(text(WIDTH / 2, 26,
      `Corte transversal: ${A.name}  →  ${B.name}`,
      { 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700, fill: '#0f172a' }
    ));
    svgEl.appendChild(text(WIDTH / 2, 46,
      `Distancia geodésica: ${distance.toFixed(1)} km · ${rects.length} TSAs · ` +
      `${panels.length} panel${panels.length === 1 ? '' : 'es'}`,
      { 'text-anchor': 'middle', 'font-size': 12, fill: '#475569' }
    ));

    // Paneles
    const defsAdded = { hatch: false };
    panels.forEach((panel, idx) => {
      const topPx = HEADER_H + idx * (PANEL_H + PANEL_GAP);
      renderPanel(svgEl, panel, idx, panels.length, topPx, maxY, defsAdded);
    });

    // Lista global de solapes (para resumen textual al pie)
    const overlaps = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const ov = geom.rectOverlap(rects[i], rects[j]);
        if (!ov) continue;
        overlaps.push({
          text: `${rects[i].tsa.name} × ${rects[j].tsa.name}: ${formatFL(ov.yMin)}–${formatFL(ov.yMax)}`,
        });
      }
    }

    // Leyenda inferior (bandas + solapes)
    const footerY = height - FOOTER_H + 10;
    svgEl.appendChild(text(40, footerY, 'Bandas:', {
      'font-size': 11, 'font-weight': 700, fill: '#0f172a',
    }));
    const bandsLegend = [
      { label: '≤ FL100', color: BAND_COLORS.low },
      { label: 'FL100–FL245', color: BAND_COLORS.mid },
      { label: '> FL245', color: BAND_COLORS.high },
    ];
    bandsLegend.forEach((b, i) => {
      svgEl.appendChild(el('rect', {
        x: 100 + i * 130, y: footerY - 10, width: 14, height: 12,
        fill: b.color, 'fill-opacity': 0.38, stroke: b.color, 'stroke-width': 1.5,
      }));
      svgEl.appendChild(text(118 + i * 130, footerY, b.label, {
        'font-size': 11, fill: '#0f172a',
      }));
    });

    svgEl.appendChild(text(40, footerY + 22, `Solapes (${overlaps.length}):`, {
      'font-size': 11, 'font-weight': 700, fill: '#0f172a',
    }));
    const shown = overlaps.slice(0, 6);
    shown.forEach((o, i) => {
      svgEl.appendChild(text(130 + (i % 2) * 460, footerY + 22 + Math.floor(i / 2) * 14,
        '• ' + o.text, { 'font-size': 10, fill: '#334155' }));
    });
    if (overlaps.length > 6) {
      svgEl.appendChild(text(130, footerY + 22 + Math.ceil(shown.length / 2) * 14 + 4,
        `…y ${overlaps.length - 6} solapes más`, { 'font-size': 10, fill: '#64748b' }));
    }

    return {
      ok: true,
      overlapCount: overlaps.length,
      extremes: { A: A.name, B: B.name },
      distance,
      panels: panels.length,
    };
  }

  // ── PNG export ───────────────────────────────────────────────────────
  async function toPNGDataURL(svgEl, scale) {
    scale = scale || 2;
    const svgStr = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const vb = svgEl.viewBox.baseVal;
      const w = (vb && vb.width) ? vb.width : (svgEl.clientWidth || WIDTH);
      const h = (vb && vb.height) ? vb.height : (svgEl.clientHeight || 560);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
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
