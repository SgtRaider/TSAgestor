// SVG cross-section: each TSA rendered as a vertical bar (lower FL → upper FL).

const NS  = 'http://www.w3.org/2000/svg';
const M   = { top: 50, right: 30, bottom: 100, left: 75 };
const BAR = { w: 58, gap: 14 };

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function flLabel(ft) {
  if (ft === 0) return 'GND';
  return 'FL' + String(Math.round(ft / 100)).padStart(3, '0');
}

function barColor(lowerFt, upperFt) {
  const mid = (lowerFt + upperFt) / 2;
  if (mid <  5000) return { fill: '#44cc00', stroke: '#33aa00' };
  if (mid < 15000) return { fill: '#ffaa00', stroke: '#cc8800' };
  if (mid < 25000) return { fill: '#0099ff', stroke: '#0077cc' };
  if (mid < 35000) return { fill: '#ff4444', stroke: '#cc2222' };
  return                   { fill: '#cc00ff', stroke: '#9900cc' };
}

function gridStep(maxFt) {
  if (maxFt <= 10000)  return 2000;
  if (maxFt <= 25000)  return 5000;
  if (maxFt <= 50000)  return 10000;
  return 20000;
}

export function renderCrossSection(tsas) {
  const svg = document.getElementById('cross-section-svg');
  // Clear
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (!tsas.length) {
    svg.setAttribute('width', 400);
    svg.setAttribute('height', 200);
    svg.appendChild(el('text', {
      x: 200, y: 110,
      'text-anchor': 'middle',
      fill: '#8b949e',
      'font-size': 14,
      'font-family': 'Segoe UI, sans-serif',
    }, 'Sin datos — carga un documento y aplica un filtro'));
    return;
  }

  const maxFt    = Math.max(...tsas.map(t => t.verticalLimits.upperFt), 10000);
  const step     = gridStep(maxFt);
  const chartW   = tsas.length * (BAR.w + BAR.gap) + BAR.gap;
  const chartH   = 380;
  const totalW   = chartW + M.left + M.right;
  const totalH   = chartH + M.top  + M.bottom;

  svg.setAttribute('width',   totalW);
  svg.setAttribute('height',  totalH);
  svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);

  // Background
  svg.appendChild(el('rect', { width: totalW, height: totalH, fill: '#161b22' }));

  // Chart area background
  svg.appendChild(el('rect', {
    x: M.left, y: M.top, width: chartW, height: chartH,
    fill: '#1c2128', rx: 4,
  }));

  const scaleY = ft => M.top + chartH - (ft / maxFt) * chartH;

  // Grid lines + Y labels
  for (let fl = 0; fl <= maxFt; fl += step) {
    const y = scaleY(fl);
    const isBase = fl === 0;

    svg.appendChild(el('line', {
      x1: M.left, x2: M.left + chartW, y1: y, y2: y,
      stroke: isBase ? '#8b949e' : '#30363d',
      'stroke-width': isBase ? 1.5 : 1,
      'stroke-dasharray': isBase ? '' : '4 3',
    }));

    svg.appendChild(el('text', {
      x: M.left - 8, y: y + 4,
      'text-anchor': 'end',
      fill: '#8b949e',
      'font-size': 10,
      'font-family': 'monospace',
    }, flLabel(fl)));
  }

  // Y-axis title
  const ytx = M.top + chartH / 2;
  const yty = 18;
  const yt  = el('text', {
    x: -ytx, y: yty,
    transform: 'rotate(-90)',
    'text-anchor': 'middle',
    fill: '#8b949e',
    'font-size': 11,
    'font-family': 'Segoe UI, sans-serif',
  }, 'Altitud (FL)');
  svg.appendChild(yt);

  // Chart title
  svg.appendChild(el('text', {
    x: totalW / 2, y: 28,
    'text-anchor': 'middle',
    fill: '#c9d1d9',
    'font-size': 13,
    'font-weight': 'bold',
    'font-family': 'Segoe UI, sans-serif',
  }, 'Corte Transversal del Espacio Aéreo'));

  // TSA bars
  tsas.forEach((tsa, i) => {
    const x    = M.left + BAR.gap + i * (BAR.w + BAR.gap);
    const yTop = scaleY(tsa.verticalLimits.upperFt);
    const yBot = scaleY(tsa.verticalLimits.lowerFt);
    const h    = Math.max(yBot - yTop, 2);
    const c    = barColor(tsa.verticalLimits.lowerFt, tsa.verticalLimits.upperFt);
    const cx   = x + BAR.w / 2;

    // Bar background glow
    svg.appendChild(el('rect', {
      x: x - 1, y: yTop - 1, width: BAR.w + 2, height: h + 2,
      fill: c.fill, opacity: 0.12, rx: 3,
    }));

    // Main bar
    const rect = el('rect', {
      x, y: yTop, width: BAR.w, height: h,
      fill: c.fill, 'fill-opacity': 0.65,
      stroke: c.stroke, 'stroke-width': 1.5, rx: 3,
    });
    rect.appendChild(el('title', {},
      `${tsa.name}\n${tsa.verticalLimits.lower} / ${tsa.verticalLimits.upper}`));
    svg.appendChild(rect);

    // Upper FL label
    svg.appendChild(el('text', {
      x: cx, y: yTop - 5,
      'text-anchor': 'middle',
      fill: '#c9d1d9',
      'font-size': 9,
      'font-family': 'monospace',
    }, tsa.verticalLimits.upper));

    // Lower FL label (only if bar is tall enough)
    if (h > 18) {
      svg.appendChild(el('text', {
        x: cx, y: yBot + 11,
        'text-anchor': 'middle',
        fill: '#8b949e',
        'font-size': 9,
        'font-family': 'monospace',
      }, tsa.verticalLimits.lower));
    }

    // TSA name (rotated 45°)
    const nameX = cx;
    const nameY = M.top + chartH + 12;
    const short = tsa.name.replace(/^TSA\s+/i, '').slice(0, 22);
    svg.appendChild(el('text', {
      x: nameX, y: nameY,
      transform: `rotate(40, ${nameX}, ${nameY})`,
      'text-anchor': 'start',
      fill: '#c9d1d9',
      'font-size': 10,
      'font-family': 'Segoe UI, sans-serif',
    }, short));
  });

  // Legend (bottom-left inside chart area)
  const legX = M.left + 8;
  let   legY = M.top + chartH - 8;

  const legendItems = [
    { label: '< FL050',       fill: '#44cc00' },
    { label: 'FL050–FL150',   fill: '#ffaa00' },
    { label: 'FL150–FL250',   fill: '#0099ff' },
    { label: 'FL250–FL350',   fill: '#ff4444' },
    { label: '> FL350',       fill: '#cc00ff' },
  ];

  // Draw legend in a small bottom-right box
  const lbX = M.left + chartW - 110;
  const lbY = M.top + 8;
  svg.appendChild(el('rect', {
    x: lbX - 4, y: lbY - 4, width: 110, height: legendItems.length * 16 + 8,
    fill: '#1c2128', stroke: '#30363d', 'stroke-width': 1, rx: 4,
  }));
  legendItems.forEach((li, j) => {
    const ly = lbY + j * 16 + 8;
    svg.appendChild(el('rect', { x: lbX, y: ly - 8, width: 10, height: 10, fill: li.fill, rx: 1 }));
    svg.appendChild(el('text', {
      x: lbX + 14, y: ly,
      fill: '#8b949e',
      'font-size': 9,
      'font-family': 'Segoe UI, sans-serif',
    }, li.label));
  });
}
