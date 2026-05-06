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

  // Bandas de nubes (Open-Meteo / WMO):
  //   bajas:  0 – 2 km   ≈ 0 – 6 500 ft
  //   medias: 2 – 7 km   ≈ 6 500 – 23 000 ft
  //   altas:  7 – 13 km  ≈ 23 000 – 43 000 ft
  const CLOUD_BANDS = [
    { id: 'low',  ftMin:     0, ftMax:  6500, color: '#94a3b8', label: 'Bajas' },
    { id: 'mid',  ftMin:  6500, ftMax: 23000, color: '#cbd5e1', label: 'Medias' },
    { id: 'high', ftMin: 23000, ftMax: 43000, color: '#e2e8f0', label: 'Altas' },
  ];

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

  // Eje Norte-Sur: meridiano que pasa por la longitud media de las TSAs
  // visibles, entre la latitud minima (km 0, sur) y la maxima (norte).
  // Devuelve null si las TSAs estan tan agrupadas en latitud que el corte
  // resulta degenerado (caera en chooseExtremes como fallback).
  function chooseNorthSouthAxis(tsas) {
    if (!tsas || !tsas.length) return null;
    let latMin = Infinity, latMax = -Infinity;
    let lonSum = 0, lonN = 0;
    for (const t of tsas) {
      if (t.centroid && Number.isFinite(t.centroid[1])) {
        lonSum += t.centroid[1];
        lonN++;
      }
      const poly = t.polygon || [];
      for (const v of poly) {
        const lat = v[0];
        if (!Number.isFinite(lat)) continue;
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
      }
    }
    if (!Number.isFinite(latMin) || !Number.isFinite(latMax)) return null;
    if ((latMax - latMin) < 0.05) return null; // ~5.5 km — degenerado
    const lonC = lonN ? lonSum / lonN : 0;
    const A = { name: `${latMin.toFixed(2)}°N`, centroid: [latMin, lonC] };
    const B = { name: `${latMax.toFixed(2)}°N`, centroid: [latMax, lonC] };
    return { A, B, distance: geom.greatCircleDistance(A.centroid, B.centroid) };
  }

  // Decide qué eje usar:
  //   - Hay plan: la distancia acumulada de la ruta (vale para circuitos).
  //   - Sin plan: meridiano N→S que pasa por el centro de las TSAs (km 0
  //     queda en la latitud mas al sur, donde "toca tierra").
  //   - Fallback (TSAs casi alineadas en latitud): geodesica entre los dos
  //     TSAs mas alejados (comportamiento previo).
  function pickAxis(tsas, plan) {
    if (plan && plan.coords && plan.coords.length >= 2) {
      const f = plan.coords[0];
      const l = plan.coords[plan.coords.length - 1];
      const totalKm = l.cumDistKm || 0;
      return {
        A: { name: f.name, centroid: [f.lat, f.lon] },
        B: { name: l.name, centroid: [l.lat, l.lon] },
        distance: totalKm,
        fromPlan: true,
      };
    }
    if (!tsas || !tsas.length) return null;
    const ns = chooseNorthSouthAxis(tsas);
    if (ns) return Object.assign({ fromPlan: false, axisKind: 'NS' }, ns);
    if (tsas.length >= 2) {
      return Object.assign({ fromPlan: false, axisKind: 'extremes' }, chooseExtremes(tsas));
    }
    return null;
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

  // Cuando el eje es la ruta del plan, mostramos un rect por cada CRUCE de
  // la ruta a través de cada TSA. Un circuito (LEBZ → … → LEBZ) puede pasar
  // por la misma TSA varias veces (ida y vuelta) y cada paso aparece como
  // rectángulo independiente en su posición correcta del corte.
  function buildRectsForPlan(tsas, planCoords) {
    if (!tsas || !tsas.length || !planCoords || planCoords.length < 2) return [];
    const result = [];
    let nextIdx = 0;
    for (const tsa of tsas) {
      const ranges = routeInsideTSARanges(tsa.polygon, planCoords);
      for (const r of ranges) {
        result.push({
          idx: nextIdx++,
          tsa,
          xMin: r.min,
          xMax: r.max,
          centreKm: (r.min + r.max) / 2,
          yMin: tsa.vertical.lowerFt,
          yMax: Math.max(tsa.vertical.lowerFt + 100, tsa.vertical.upperFt),
        });
      }
    }
    return result;
  }

  // Recorre la ruta muestreando cada segmento y devuelve un array de
  // {min, max} de cumDistKm para CADA cruce (entrada→salida) por la TSA.
  // Si la ruta nunca entra → array vacío. Si entra y sale varias veces →
  // varios rangos. Después fusiona rangos consecutivos separados por menos
  // de MERGE_GAP_KM para eliminar artefactos donde la ruta roza la frontera
  // del polígono y un sample queda fuera entre dos dentros.
  function routeInsideTSARanges(polygon, planCoords) {
    const ranges = [];
    let current = null;
    const SAMPLES = 60;     // por segmento (~1 km en tramos de 60 km)
    for (let i = 0; i < planCoords.length - 1; i++) {
      const a = planCoords[i], b = planCoords[i + 1];
      const cumStart = a.cumDistKm || 0;
      const cumEnd   = b.cumDistKm || 0;
      const segLen   = cumEnd - cumStart;
      if (segLen <= 0) continue;
      for (let k = 0; k <= SAMPLES; k++) {
        const t = k / SAMPLES;
        const lat = a.lat + (b.lat - a.lat) * t;
        const lon = a.lon + (b.lon - a.lon) * t;
        const cumX = cumStart + segLen * t;
        if (pointInPoly([lat, lon], polygon)) {
          if (current === null) current = { min: cumX, max: cumX };
          else current.max = cumX;
        } else if (current !== null) {
          ranges.push(current);
          current = null;
        }
      }
    }
    if (current !== null) ranges.push(current);
    return mergeNearbyRanges(ranges, 8);
  }

  // Fusiona rangos consecutivos cuya separación es <= mergeGapKm.
  // Sirve para eliminar "huecos" artificiales debidos al muestreo cuando
  // la ruta sigue una arista del polígono (un sample queda fuera por
  // diferencias decimales). NO fusiona cruces realmente separados como
  // los de un circuito (ida + vuelta), que están a cientos de km.
  function mergeNearbyRanges(ranges, mergeGapKm) {
    if (!ranges || ranges.length < 2) return ranges;
    const out = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = out[out.length - 1];
      const next = ranges[i];
      if (next.min - last.max <= mergeGapKm) {
        last.max = Math.max(last.max, next.max);
      } else {
        out.push(next);
      }
    }
    return out;
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
  function renderPanel(svg, panel, panelIndex, nPanels, topPx, maxY, defsAdded, planPts, clouds) {
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

    // ── Nubes (Open-Meteo) bajo todo lo demás ───────────────────────────
    if (clouds && planPts && planPts.length === clouds.length) {
      drawCloudBands(g, planPts, clouds, xScale, yScale, panel);
      drawCloudBoundaryLabels(svg, yScale, plotTop, plotBottom, pad);
    }

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

    // ── Plan de vuelo: polilínea de la ruta y marcadores de waypoint ──
    if (planPts && planPts.length >= 2) {
      drawPlanRoute(g, svg, planPts, xScale, yScale, panel, plotTop, plotBottom);
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

  // ── Helpers de plan + nubes ─────────────────────────────────────────

  // Pinta franjas de cobertura nubosa por segmento de ruta. Para cada par
  // (wp[i], wp[i+1]) usamos la cobertura media en cada banda y trazamos un
  // rectángulo con opacidad proporcional.
  function drawCloudBands(g, planPts, clouds, xScale, yScale, panel) {
    const MAX_OP = 0.65;
    for (let i = 0; i < planPts.length - 1; i++) {
      const a = planPts[i], b = planPts[i + 1];
      // Recorta a la región del panel.
      const segMinKm = Math.min(a.xKm, b.xKm);
      const segMaxKm = Math.max(a.xKm, b.xKm);
      if (segMaxKm < panel.xMinKm || segMinKm > panel.xMaxKm) continue;
      const x1 = xScale(Math.max(segMinKm, panel.xMinKm));
      const x2 = xScale(Math.min(segMaxKm, panel.xMaxKm));
      if (x2 - x1 < 1) continue;
      const cA = clouds[i] || {}, cB = clouds[i + 1] || {};
      const avg = (a, b) => {
        const v = [a, b].filter(x => Number.isFinite(x));
        return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
      };
      const covers = {
        low:  avg(cA.coverLow,  cB.coverLow),
        mid:  avg(cA.coverMid,  cB.coverMid),
        high: avg(cA.coverHigh, cB.coverHigh),
      };
      for (const band of CLOUD_BANDS) {
        const cv = covers[band.id];
        if (!cv || cv < 5) continue;
        const yTop = yScale(band.ftMax);
        const yBot = yScale(band.ftMin);
        g.appendChild(el('rect', {
          x: x1, y: yTop, width: x2 - x1, height: yBot - yTop,
          fill: band.color,
          'fill-opacity': MAX_OP * (cv / 100),
        }));
        // Etiqueta numérica de % en el centro de la franja, sólo si cabe.
        const cx = (x1 + x2) / 2;
        const w = x2 - x1;
        if (w > 60) {
          g.appendChild(haloText(cx, (yTop + yBot) / 2 + 3,
            Math.round(cv) + '%', {
              'text-anchor': 'middle', 'font-size': 10,
              'font-weight': 600, fill: '#1e293b',
            }));
        }
      }
    }
  }

  // Etiquetas a la derecha del plot indicando los límites de cada banda
  // de nube (FL y altitud en pies). Sólo se llaman cuando hay nubes.
  function drawCloudBoundaryLabels(svg, yScale, plotTop, plotBottom, pad) {
    for (const band of CLOUD_BANDS) {
      const y = yScale(band.ftMax);
      if (y < plotTop || y > plotBottom) continue;
      svg.appendChild(el('line', {
        x1: WIDTH - pad.right, y1: y,
        x2: WIDTH - pad.right + 6, y2: y,
        stroke: '#475569', 'stroke-width': 1,
      }));
      svg.appendChild(text(WIDTH - pad.right + 8, y - 1, band.label + ' ↑', {
        'font-size': 9, fill: '#475569', 'font-weight': 600,
      }));
      svg.appendChild(text(WIDTH - pad.right + 8, y + 9,
        formatFL(band.ftMax), { 'font-size': 9, fill: '#64748b' }));
    }
  }

  // Polilínea del plan de vuelo + marcadores de waypoints + etiquetas FL.
  function drawPlanRoute(g, svg, planPts, xScale, yScale, panel, plotTop, plotBottom) {
    // Filtra waypoints visibles en este panel (incluye uno fuera a cada lado
    // para que la línea no se corte abrupta en los bordes).
    const inPanel = (xKm) => xKm >= panel.xMinKm - 1 && xKm <= panel.xMaxKm + 1;
    const visIdx = [];
    for (let i = 0; i < planPts.length; i++) {
      if (inPanel(planPts[i].xKm)) visIdx.push(i);
    }
    if (!visIdx.length) return;
    if (visIdx[0] > 0) visIdx.unshift(visIdx[0] - 1);
    if (visIdx[visIdx.length - 1] < planPts.length - 1) visIdx.push(visIdx[visIdx.length - 1] + 1);

    // Línea principal: halo oscuro + amarillo brillante encima.
    const points = visIdx.map(i => `${xScale(planPts[i].xKm)},${yScale(planPts[i].fl * 100)}`).join(' ');
    g.appendChild(el('polyline', {
      points, fill: 'none', stroke: '#1f2937',
      'stroke-width': 6, 'stroke-opacity': 0.45,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    g.appendChild(el('polyline', {
      points, fill: 'none', stroke: '#f59e0b',
      'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    // Marcadores y etiquetas
    for (const i of visIdx) {
      const wp = planPts[i];
      const x = xScale(wp.xKm), y = yScale(wp.fl * 100);
      const isExtreme = (i === 0 || i === planPts.length - 1);
      const isTSA = !!wp.tsa;
      g.appendChild(el('circle', {
        cx: x, cy: y, r: isExtreme ? 5 : 4,
        fill: isTSA ? '#dc2626' : (isExtreme ? '#f59e0b' : '#fde68a'),
        stroke: '#1f2937', 'stroke-width': 1.5,
      }));
      // Etiqueta nombre + FL encima del marcador
      svg.appendChild(haloText(x, y - 9, wp.name, {
        'text-anchor': 'middle', 'font-size': 10,
        'font-weight': 700, fill: '#0f172a',
      }));
      svg.appendChild(haloText(x, y + 16, 'FL' + wp.fl, {
        'text-anchor': 'middle', 'font-size': 9,
        fill: '#7c2d12', 'font-weight': 600,
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

  // ── Vista de inventario altitudinal (sin plan) ────────────────────────
  // Cuando no hay ruta, la proyeccion espacial es engañosa con TSAs
  // concentricas (caso Talavera). Agrupamos por proximidad geografica
  // (cluster <30NM = mismo "complejo" militar), y dentro de cada cluster
  // ordenamos por altitud para que el solape se lea visualmente: dos TSAs
  // adyacentes con barras que se superponen en X comparten airspace.

  // Prefijo comun mas largo (case-insensitive en separadores) — sirve
  // para nombrar el cluster como "TSA TALAVERA" si todas comparten root.
  function commonNamePrefix(names) {
    if (!names.length) return '';
    let p = names[0];
    for (let i = 1; i < names.length; i++) {
      while (p.length && !names[i].startsWith(p)) p = p.slice(0, -1);
      if (!p) break;
    }
    return p.replace(/[\s\-_·]+$/, '').trim();
  }

  // Cluster greedy por distancia entre centroides (km).
  function clusterTsasByCentroid(tsas, distanceKm) {
    distanceKm = distanceKm || 56; // ~30 NM
    const clusters = [];
    for (const t of tsas) {
      let best = null, bestD = Infinity;
      for (const c of clusters) {
        const d = geom.greatCircleDistance(t.centroid, c.centroid);
        if (d < bestD && d <= distanceKm) { bestD = d; best = c; }
      }
      if (best) {
        best.tsas.push(t);
        const n = best.tsas.length;
        best.centroid = [
          (best.centroid[0] * (n - 1) + t.centroid[0]) / n,
          (best.centroid[1] * (n - 1) + t.centroid[1]) / n,
        ];
      } else {
        clusters.push({ centroid: t.centroid.slice(), tsas: [t] });
      }
    }
    for (const c of clusters) {
      c.tsas.sort((a, b) => {
        if (a.vertical.lowerFt !== b.vertical.lowerFt) return a.vertical.lowerFt - b.vertical.lowerFt;
        if (a.vertical.upperFt !== b.vertical.upperFt) return a.vertical.upperFt - b.vertical.upperFt;
        return a.name.localeCompare(b.name);
      });
      const prefix = commonNamePrefix(c.tsas.map(t => t.name));
      c.name = prefix && prefix.length >= 4
        ? prefix
        : `Grupo ${c.centroid[0].toFixed(2)}°N ${Math.abs(c.centroid[1]).toFixed(2)}°${c.centroid[1] < 0 ? 'W' : 'E'}`;
    }
    // Norte primero (latitud descendente).
    clusters.sort((a, b) => b.centroid[0] - a.centroid[0]);
    return clusters;
  }

  function fmtCoord(latLon) {
    const lat = latLon[0], lon = latLon[1];
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
  }

  function renderAltitudeList(svgEl, tsas, opts) {
    opts = opts || {};
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    if (!tsas || !tsas.length) {
      svgEl.setAttribute('viewBox', '0 0 600 200');
      svgEl.setAttribute('width', '600');
      svgEl.setAttribute('height', '200');
      svgEl.appendChild(text(300, 100,
        'Carga ≥1 TSA para ver el inventario altitudinal',
        { 'text-anchor': 'middle', fill: '#64748b', 'font-size': 14 }));
      return { ok: false };
    }

    const clusters = clusterTsasByCentroid(tsas);

    const ROW_H = 26;
    const CLUSTER_HDR_H = 30;
    const CLUSTER_GAP = 10;
    const HEADER = 76;
    const FOOTER = 56;
    const NAME_W = 230;
    const SCHED_W = 200;
    const PADDING = 16;
    const BAR_X0 = NAME_W + PADDING * 2;
    const BAR_W  = WIDTH - BAR_X0 - SCHED_W - PADDING * 2;

    // Altura total: cabecera + sum(cluster_hdr + tsas*ROW_H) + gaps + footer.
    let bodyH = 0;
    for (let i = 0; i < clusters.length; i++) {
      bodyH += CLUSTER_HDR_H + clusters[i].tsas.length * ROW_H;
      if (i < clusters.length - 1) bodyH += CLUSTER_GAP;
    }
    const totalH = HEADER + bodyH + FOOTER;

    svgEl.setAttribute('viewBox', `0 0 ${WIDTH} ${totalH}`);
    svgEl.setAttribute('width', WIDTH);
    svgEl.setAttribute('height', totalH);
    svgEl.setAttribute('font-family', 'sans-serif');
    svgEl.appendChild(el('rect', { x: 0, y: 0, width: WIDTH, height: totalH, fill: '#ffffff' }));

    // Cabecera
    svgEl.appendChild(text(WIDTH / 2, 28,
      `Inventario altitudinal — ${tsas.length} TSA${tsas.length === 1 ? '' : 's'} en ${clusters.length} grupo${clusters.length === 1 ? '' : 's'}`,
      { 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700, fill: '#0f172a' }));
    svgEl.appendChild(text(WIDTH / 2, 48,
      'Agrupadas por proximidad (<30 NM) y ordenadas por altitud · barras superpuestas dentro de un grupo = solape de airspace',
      { 'text-anchor': 'middle', 'font-size': 11, fill: '#64748b' }));

    // Escala de altitud comun a todos los clusters.
    const maxFt = Math.max(20000, ...tsas.map(t => Math.max(t.vertical.upperFt, t.vertical.lowerFt + 100)));
    const niceMax = Math.ceil(maxFt / 5000) * 5000;
    const xScaleFt = ft => BAR_X0 + (Math.max(0, Math.min(ft, niceMax)) / niceMax) * BAR_W;

    // Grid vertical (lineas + etiquetas) cada 5000 ft hasta 18000, despues FL.
    const gridStops = [];
    for (let ft = 0; ft <= niceMax; ft += 5000) gridStops.push(ft);
    if (gridStops[gridStops.length - 1] !== niceMax) gridStops.push(niceMax);
    const gridY1 = HEADER - 12;
    const gridY2 = HEADER + bodyH + 6;
    for (const ft of gridStops) {
      const x = xScaleFt(ft);
      svgEl.appendChild(el('line', {
        x1: x, y1: gridY1, x2: x, y2: gridY2,
        stroke: '#e2e8f0', 'stroke-width': 1,
      }));
      const lbl = ft === 0 ? 'GND' : (ft < 18000 ? `${(ft / 1000) | 0}k ft` : `FL${(ft / 100) | 0}`);
      svgEl.appendChild(text(x, HEADER - 18, lbl, {
        'text-anchor': 'middle', 'font-size': 10, fill: '#64748b', 'font-weight': 600,
      }));
    }
    svgEl.appendChild(text(PADDING, HEADER - 18, 'TSA', {
      'font-size': 10, fill: '#64748b', 'font-weight': 700,
    }));
    svgEl.appendChild(text(WIDTH - PADDING, HEADER - 18, 'Próxima ventana', {
      'text-anchor': 'end', 'font-size': 10, fill: '#64748b', 'font-weight': 700,
    }));

    // Renderiza cada cluster.
    let yCursor = HEADER;
    let totalOverlaps = 0;
    for (const cluster of clusters) {
      // Banda de fondo del cluster (sutil) que abarca cabecera + filas.
      const clusterTopY = yCursor;
      const clusterH = CLUSTER_HDR_H + cluster.tsas.length * ROW_H;
      svgEl.appendChild(el('rect', {
        x: 0, y: clusterTopY, width: WIDTH, height: clusterH,
        fill: '#f1f5f9', 'fill-opacity': 0.5,
      }));
      // Linea separadora superior gruesa
      svgEl.appendChild(el('line', {
        x1: 0, y1: clusterTopY, x2: WIDTH, y2: clusterTopY,
        stroke: '#cbd5e1', 'stroke-width': 1.5,
      }));

      // Cabecera del cluster
      svgEl.appendChild(text(PADDING, yCursor + 20,
        cluster.name,
        { 'font-size': 13, 'font-weight': 700, fill: '#0f172a' }));
      svgEl.appendChild(text(WIDTH - PADDING, yCursor + 20,
        `${cluster.tsas.length} TSA${cluster.tsas.length === 1 ? '' : 's'} · centro ${fmtCoord(cluster.centroid)}`,
        { 'text-anchor': 'end', 'font-size': 11, fill: '#475569' }));
      yCursor += CLUSTER_HDR_H;

      // Filas del cluster
      const rowYs = []; // para dibujar marcadores de solape despues
      cluster.tsas.forEach((tsa, idx) => {
        const y = yCursor + idx * ROW_H;
        rowYs.push(y);
        if (idx % 2 === 1) {
          svgEl.appendChild(el('rect', { x: 0, y, width: WIDTH, height: ROW_H, fill: '#ffffff', 'fill-opacity': 0.6 }));
        }
        const name = tsa.name.length > 32 ? tsa.name.slice(0, 31) + '…' : tsa.name;
        svgEl.appendChild(text(PADDING + 8, y + ROW_H / 2 + 4, name, {
          'font-size': 12, 'font-weight': 600, fill: '#0f172a',
        }));
        const x1 = xScaleFt(tsa.vertical.lowerFt);
        const x2 = xScaleFt(Math.max(tsa.vertical.lowerFt + 100, tsa.vertical.upperFt));
        const band = (geom.altitudeBand && geom.altitudeBand(tsa.vertical.upperFt)) || 'mid';
        const color = BAND_COLORS[band] || BAND_COLORS.mid;
        svgEl.appendChild(el('rect', {
          x: x1, y: y + 5, width: Math.max(2, x2 - x1), height: ROW_H - 10,
          fill: color, 'fill-opacity': 0.42,
          stroke: color, 'stroke-width': 1.4,
          class: 'cs-tsa-rect', 'data-tsa-id': tsa.id,
        }));
        svgEl.appendChild(haloText(x1 - 4, y + ROW_H / 2 + 4, tsa.vertical.lowerLabel, {
          'text-anchor': 'end', 'font-size': 10, fill: '#0f172a', 'font-weight': 600,
        }));
        svgEl.appendChild(haloText(x2 + 4, y + ROW_H / 2 + 4, tsa.vertical.upperLabel, {
          'text-anchor': 'start', 'font-size': 10, fill: '#0f172a', 'font-weight': 600,
        }));
        const sch = tsa.schedules && tsa.schedules[0];
        let schedTxt = '—';
        if (sch && sch.startUTC && sch.endUTC) {
          const pad = n => String(n).padStart(2, '0');
          const d = sch.startUTC;
          schedTxt = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ` +
                     `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` +
                     `–${pad(sch.endUTC.getUTCHours())}:${pad(sch.endUTC.getUTCMinutes())}Z`;
          if (tsa.schedules.length > 1) schedTxt += ` (+${tsa.schedules.length - 1})`;
        }
        svgEl.appendChild(text(WIDTH - PADDING, y + ROW_H / 2 + 4, schedTxt, {
          'text-anchor': 'end', 'font-size': 10, fill: '#475569',
        }));
      });

      // Marcadores de solape altitudinal: contamos TODOS los pares con
      // intersection, pero dibujamos solo los pares ADYACENTES (i, i+1).
      // Asi el solape se ve a simple vista como una "escalera" descendente
      // sin saturar el SVG con N*(N-1)/2 marcadores cuando hay 30+ TSAs.
      for (let i = 0; i < cluster.tsas.length; i++) {
        for (let j = i + 1; j < cluster.tsas.length; j++) {
          const a = cluster.tsas[i], b = cluster.tsas[j];
          const lo = Math.max(a.vertical.lowerFt, b.vertical.lowerFt);
          const hi = Math.min(a.vertical.upperFt, b.vertical.upperFt);
          if (hi <= lo) continue;
          totalOverlaps++;
        }
      }
      for (let i = 0; i < cluster.tsas.length - 1; i++) {
        const a = cluster.tsas[i], b = cluster.tsas[i + 1];
        const lo = Math.max(a.vertical.lowerFt, b.vertical.lowerFt);
        const hi = Math.min(a.vertical.upperFt, b.vertical.upperFt);
        if (hi <= lo) continue;
        const xA = xScaleFt(lo), xB = xScaleFt(hi);
        const yA = rowYs[i] + ROW_H - 4;
        const yB = rowYs[i + 1] + 4;
        // Banda hatch sutil entre las dos filas en la franja de solape.
        svgEl.appendChild(el('rect', {
          x: xA, y: yA, width: Math.max(2, xB - xA), height: yB - yA,
          fill: '#dc2626', 'fill-opacity': 0.18,
          stroke: '#dc2626', 'stroke-width': 0.8, 'stroke-dasharray': '3 2',
          'stroke-opacity': 0.7,
        }));
      }

      yCursor += cluster.tsas.length * ROW_H + CLUSTER_GAP;
    }

    // Pie con leyenda
    const legY = HEADER + bodyH + 30;
    const legendItems = [
      { c: BAND_COLORS.low,  l: 'Banda baja (≤ FL100)' },
      { c: BAND_COLORS.mid,  l: 'Banda media' },
      { c: BAND_COLORS.high, l: 'Banda alta (> FL245)' },
    ];
    let lx = PADDING;
    for (const it of legendItems) {
      svgEl.appendChild(el('rect', { x: lx, y: legY - 9, width: 14, height: 10, fill: it.c, 'fill-opacity': 0.6, stroke: it.c }));
      svgEl.appendChild(text(lx + 18, legY, it.l, { 'font-size': 11, fill: '#475569' }));
      lx += 180;
    }
    // Indicador de solapes
    svgEl.appendChild(el('line', { x1: lx, y1: legY - 5, x2: lx + 14, y2: legY - 5, stroke: '#dc2626', 'stroke-width': 1, 'stroke-dasharray': '3 2' }));
    svgEl.appendChild(text(lx + 18, legY, `Solape altitudinal (${totalOverlaps})`, { 'font-size': 11, fill: '#475569' }));

    return {
      ok: true,
      mode: 'altitudeList',
      count: tsas.length,
      clusters: clusters.length,
      overlapCount: totalOverlaps,
      extremes: { A: 'GND', B: `FL${(niceMax / 100) | 0}` },
      distance: niceMax,
      panels: clusters.length,
    };
  }

  // ── Render principal ─────────────────────────────────────────────────
  // opts = { plan, clouds }
  function render(svgEl, tsas, opts) {
    opts = opts || {};
    const plan = opts.plan || null;
    const clouds = opts.clouds || null;
    tsas = tsas || [];

    // Sin plan: vista de inventario altitudinal (filas, sin proyeccion
    // espacial). Con plan: vista espacial sobre la ruta.
    const hasPlan = plan && plan.coords && plan.coords.length >= 2;
    if (!hasPlan) {
      return renderAltitudeList(svgEl, tsas, opts);
    }

    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    const axis = pickAxis(tsas, plan);
    if (!axis) {
      svgEl.setAttribute('viewBox', '0 0 600 200');
      svgEl.setAttribute('width', '600');
      svgEl.setAttribute('height', '200');
      svgEl.appendChild(text(300, 100,
        'Necesitas un plan de vuelo o ≥2 TSAs visibles para el corte',
        { 'text-anchor': 'middle', fill: '#64748b', 'font-size': 14 }));
      return { ok: false };
    }

    const { A, B, distance, fromPlan, axisKind } = axis;
    // Cuando hay plan, las TSAs se proyectan sobre el segmento más cercano de
    // la ruta; sin plan, sobre la geodésica A→B (extremos de TSAs).
    const rects = fromPlan
      ? buildRectsForPlan(tsas, plan.coords)
      : buildRects(tsas, A, B);

    // Normaliza a partir de 0. Cuando es plan, todo arranca en 0 (cumDist).
    const xMinRaw = fromPlan ? 0 : Math.min(0, ...rects.map(r => r.xMin));
    if (xMinRaw !== 0) rects.forEach(r => { r.xMin -= xMinRaw; r.xMax -= xMinRaw; });
    const totalXMax = Math.max(distance - xMinRaw, ...rects.map(r => r.xMax), distance);

    // Waypoints del plan: xKm = distancia acumulada desde el origen (válido
    // para circuito y para ruta lineal por igual).
    let planPts = null;
    if (plan && plan.coords && plan.coords.length >= 2) {
      planPts = plan.coords.map(c => ({
        name: c.name,
        fl: c.fl != null ? c.fl : (plan.flightLevel || 350),
        tsa: c.tsa || null,
        xKm: c.cumDistKm || 0,
      }));
    }

    // maxY: máx entre TSAs, banda de nubes altas y FL del plan.
    let maxYft = Math.max(10000, ...rects.map(r => r.yMax));
    if (planPts) maxYft = Math.max(maxYft, ...planPts.map(p => p.fl * 100));
    if (clouds && clouds.length) maxYft = Math.max(maxYft, 43000);
    const maxY = maxYft * 1.12;

    const nPanels = decidePanelCount(Math.max(rects.length, planPts ? 2 : 0));
    const panels = buildPanels(rects, nPanels, totalXMax);

    // Si no había TSAs (solo plan), buildPanels devuelve []. Crea uno cubriendo
    // toda la ruta para que se dibuje el plan.
    if (!panels.length && planPts) {
      panels.push({ xMinKm: 0, xMaxKm: totalXMax, members: [], primaryIds: new Set() });
    }

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
    const axisLabel = fromPlan
      ? '  ·  ruta del plan de vuelo'
      : (axisKind === 'NS' ? '  ·  eje Sur → Norte' : '');
    svgEl.appendChild(text(WIDTH / 2, 26,
      `Corte transversal: ${A.name}  →  ${B.name}${axisLabel}`,
      { 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700, fill: '#0f172a' }
    ));
    const subParts = [
      `${distance.toFixed(1)} km`,
    ];
    if (fromPlan) {
      const uniqueTsas = new Set(rects.map(r => r.tsa)).size;
      const passes = rects.length;
      const passWord = passes === 1 ? 'paso' : 'pasos';
      subParts.push(`${uniqueTsas} TSAs cruzadas (${passes} ${passWord}) / ${tsas.length} visibles`);
    } else {
      subParts.push(`${rects.length} TSAs`);
    }
    subParts.push(`${panels.length} panel${panels.length === 1 ? '' : 'es'}`);
    if (planPts) subParts.push(`${planPts.length} waypoints`);
    if (clouds && clouds.length) subParts.push('nubes Open-Meteo');
    svgEl.appendChild(text(WIDTH / 2, 46, subParts.join(' · '),
      { 'text-anchor': 'middle', 'font-size': 12, fill: '#475569' }
    ));

    // Paneles
    const defsAdded = { hatch: false };
    panels.forEach((panel, idx) => {
      const topPx = HEADER_H + idx * (PANEL_H + PANEL_GAP);
      renderPanel(svgEl, panel, idx, panels.length, topPx, maxY, defsAdded, planPts, clouds);
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

    // Leyenda inferior (bandas TSA, plan y nubes)
    const footerY = height - FOOTER_H + 10;
    svgEl.appendChild(text(40, footerY, 'TSA:', {
      'font-size': 11, 'font-weight': 700, fill: '#0f172a',
    }));
    const bandsLegend = [
      { label: '≤ FL100', color: BAND_COLORS.low },
      { label: 'FL100–FL245', color: BAND_COLORS.mid },
      { label: '> FL245', color: BAND_COLORS.high },
    ];
    bandsLegend.forEach((b, i) => {
      svgEl.appendChild(el('rect', {
        x: 80 + i * 110, y: footerY - 10, width: 14, height: 12,
        fill: b.color, 'fill-opacity': 0.38, stroke: b.color, 'stroke-width': 1.5,
      }));
      svgEl.appendChild(text(98 + i * 110, footerY, b.label, {
        'font-size': 11, fill: '#0f172a',
      }));
    });

    // Plan
    if (planPts) {
      const px = 460;
      svgEl.appendChild(text(px, footerY, 'Plan:', {
        'font-size': 11, 'font-weight': 700, fill: '#0f172a',
      }));
      svgEl.appendChild(el('line', {
        x1: px + 35, y1: footerY - 4, x2: px + 70, y2: footerY - 4,
        stroke: '#f59e0b', 'stroke-width': 3,
      }));
      svgEl.appendChild(text(px + 76, footerY, 'ruta · marcadores rojos = waypoints en TSA', {
        'font-size': 10, fill: '#334155',
      }));
    }

    // Nubes
    if (clouds && clouds.length) {
      const cx = 760;
      svgEl.appendChild(text(cx, footerY, 'Nubes:', {
        'font-size': 11, 'font-weight': 700, fill: '#0f172a',
      }));
      CLOUD_BANDS.forEach((b, i) => {
        const x = cx + 45 + i * 90;
        svgEl.appendChild(el('rect', {
          x, y: footerY - 10, width: 12, height: 12,
          fill: b.color, 'fill-opacity': 0.5,
          stroke: '#475569', 'stroke-width': 0.5,
        }));
        svgEl.appendChild(text(x + 16, footerY,
          `${b.label} ${(b.ftMin/1000).toFixed(0)}–${(b.ftMax/1000).toFixed(0)}k ft`,
          { 'font-size': 10, fill: '#334155' }));
      });
    }

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
