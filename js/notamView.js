// Pestanya NOTAMs — dos paneles para los aeropuertos del plan (o ICAOs
// arbitrarios introducidos a mano):
//
//   1) Weather Hold (matriz horaria) — para cada ICAO una fila con 6
//      celdas horarias coloreadas en verde/amarillo/rojo segun los
//      minimos meteo configurados en Ajustes (techo, visibilidad,
//      viento). Cada celda muestra al pasar el cursor el METAR o el
//      TAF previsto para ese periodo. Esto es lo que el usuario
//      considera "showstopper" de meteo.
//
//   2) NOTAMs del aerodromo — lista plana con TODOS los NOTAMs
//      activos (sin filtrar). Solo se separa visualmente cierre de
//      pista/aerodromo del resto.
//
// Fuentes:
//   - NOTAMs: Autorouter /v1.0/notam?aerodromes=...
//   - METAR/TAF: AviationWeather.gov (proxy /api/awc)
//

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.notamView = (function () {
  'use strict';

  const $ = sel => document.querySelector(sel);

  // Número de celdas horarias mostradas en el WX board (1 por hora).
  const WX_HOURS = 6;

  // ── Parseo de minima desde METAR / TAF ─────────────────────────────
  // Extrae techo (ft), visibilidad (m) y viento maximo (kt, incluyendo
  // racha) de un trozo de reporte METAR/TAF. Devuelve null si el reporte
  // no es interpretable.
  function extractWx(reportText) {
    if (!reportText) return null;
    const tokens = String(reportText).split(/\s+/);
    const out = { ceilingFt: null, visM: null, windKt: null, gustKt: null, cavok: false, nsc: false };
    for (const tok of tokens) {
      // CAVOK -> sin nubes <FL050, vis >=10km, sin meteo significativa
      if (tok === 'CAVOK') {
        out.cavok = true;
        out.visM = Math.max(out.visM || 0, 10000);
        continue;
      }
      // NSC / SKC / CLR / NCD = sin nubes operativamente significativas
      if (tok === 'NSC' || tok === 'SKC' || tok === 'CLR' || tok === 'NCD') {
        out.nsc = true;
        continue;
      }
      // Nubes con techo: BKN/OVC = primera cubierta significativa
      let m = tok.match(/^(BKN|OVC)(\d{3})(CB|TCU)?$/);
      if (m) {
        const ft = parseInt(m[2], 10) * 100;
        if (out.ceilingFt === null || ft < out.ceilingFt) out.ceilingFt = ft;
        continue;
      }
      // Visibilidad vertical (techo a efectos operativos)
      m = tok.match(/^VV(\d{3})$/);
      if (m) {
        const ft = parseInt(m[1], 10) * 100;
        if (out.ceilingFt === null || ft < out.ceilingFt) out.ceilingFt = ft;
        continue;
      }
      // Visibilidad metros (4 digitos) - no confundir con QNH (Qxxxx)
      m = tok.match(/^(\d{4})$/);
      if (m) {
        const v = parseInt(m[1], 10);
        if (v >= 0 && v <= 9999 && out.visM === null) out.visM = v === 9999 ? 10000 : v;
        continue;
      }
      // Visibilidad statute miles (US)
      m = tok.match(/^(\d+)SM$/);
      if (m && out.visM === null) {
        out.visM = parseInt(m[1], 10) * 1609;
        continue;
      }
      // Viento DDDff[Gff]KT  (VRB tambien)
      m = tok.match(/^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?KT$/);
      if (m && out.windKt === null) {
        out.windKt = parseInt(m[2], 10);
        if (m[3]) out.gustKt = parseInt(m[3], 10);
        continue;
      }
    }
    return out;
  }

  // Decide color de una celda comparando minima con limites configurados.
  // Devuelve { status: 'green'|'yellow'|'red'|'unknown', reasons: [...] }.
  function evalWx(wx, limits) {
    if (!wx) return { status: 'unknown', reasons: ['Sin reporte para esta hora'] };
    const reasons = [];
    let status = 'green';
    const worst = (next) => {
      const order = { green: 0, yellow: 1, red: 2 };
      if (order[next] > order[status]) status = next;
    };
    // Techo
    if (wx.ceilingFt != null) {
      if (wx.ceilingFt < limits.ceilingHardFt) {
        worst('red');
        reasons.push(`Techo ${wx.ceilingFt} ft < ${limits.ceilingHardFt}`);
      } else if (wx.ceilingFt < limits.ceilingMarginalFt) {
        worst('yellow');
        reasons.push(`Techo ${wx.ceilingFt} ft marginal`);
      }
    }
    // Visibilidad
    if (wx.visM != null) {
      if (wx.visM < limits.visibilityHardM) {
        worst('red');
        reasons.push(`Vis ${wx.visM} m < ${limits.visibilityHardM}`);
      } else if (wx.visM < limits.visibilityMarginalM) {
        worst('yellow');
        reasons.push(`Vis ${wx.visM} m marginal`);
      }
    }
    // Viento (peor de sostenido y racha)
    const w = Math.max(wx.windKt || 0, wx.gustKt || 0);
    if (w > 0) {
      if (w > limits.windHardKt) {
        worst('red');
        reasons.push(`Viento ${w} kt > ${limits.windHardKt}`);
      } else if (w > limits.windMarginalKt) {
        worst('yellow');
        reasons.push(`Viento ${w} kt marginal`);
      }
    }
    return { status, reasons };
  }

  // ── Resolucion temporal del TAF ────────────────────────────────────
  // Devuelve los tokens del grupo de pronostico activo en `targetMs`
  // segun un TAF crudo. Recorre los marcadores FM/BECMG/TEMPO/PROB y se
  // queda con el ultimo grupo "principal" cuya validez incluye target;
  // TEMPO/PROB se ignoran a efectos de minima (los anyadimos como nota).
  function tafForecastAt(rawTaf, targetMs) {
    if (!rawTaf) return null;
    const txt = String(rawTaf).trim().replace(/=+\s*$/, '').replace(/\s+/g, ' ');
    // Validity period del header: DDhh/DDhh
    const mVal = txt.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
    if (!mVal) return null;
    // Mes/anyo de referencia: usa el dia mas cercano a "now" para inferir.
    // Si el primer dia del TAF es muy anterior al actual, asume mes siguiente.
    const now = new Date();
    let year  = now.getUTCFullYear();
    let month = now.getUTCMonth();
    const firstDay = parseInt(mVal[1], 10);
    if (firstDay < now.getUTCDate() - 10) {
      month++;
      if (month > 11) { month = 0; year++; }
    }
    const baseStart = Date.UTC(year, month, firstDay, parseInt(mVal[2], 10));
    // Split en grupos por marcador de cambio.
    const parts = txt.split(/\s+(?=FM\d{6}\b|BECMG\b|TEMPO\b|PROB\d{2}\b)/);
    const sections = [];
    sections.push({ type: 'base', startMs: baseStart, endMs: Infinity, text: parts[0] });
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const fm = p.match(/^FM(\d{2})(\d{2})(\d{2})/);
      const grp = p.match(/^(BECMG|TEMPO|PROB\d{2}(?:\s+TEMPO)?)\s+(\d{2})(\d{2})\/(\d{2})(\d{2})/);
      if (fm) {
        const d = parseInt(fm[1], 10), h = parseInt(fm[2], 10), mn = parseInt(fm[3], 10);
        // FM puede saltar a un dia menor (mes siguiente).
        let fmYear = year, fmMonth = month;
        if (d < firstDay) { fmMonth++; if (fmMonth > 11) { fmMonth = 0; fmYear++; } }
        const startMs = Date.UTC(fmYear, fmMonth, d, h, mn);
        sections.push({ type: 'FM', startMs, endMs: Infinity, text: p });
      } else if (grp) {
        const d1 = parseInt(grp[2], 10), h1 = parseInt(grp[3], 10);
        const d2 = parseInt(grp[4], 10), h2 = parseInt(grp[5], 10);
        let y1 = year, mo1 = month, y2 = year, mo2 = month;
        if (d1 < firstDay) { mo1++; if (mo1 > 11) { mo1 = 0; y1++; } }
        if (d2 < firstDay) { mo2++; if (mo2 > 11) { mo2 = 0; y2++; } }
        sections.push({
          type: grp[1].startsWith('PROB') ? 'PROB' : grp[1],
          startMs: Date.UTC(y1, mo1, d1, h1),
          endMs:   Date.UTC(y2, mo2, d2, h2),
          text: p,
        });
      }
    }
    // Cierra la validez de cada grupo principal (base/FM) hasta el siguiente.
    let lastMain = -1;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].type === 'base' || sections[i].type === 'FM') {
        if (lastMain >= 0) sections[lastMain].endMs = sections[i].startMs;
        lastMain = i;
      }
    }
    // Activo: el ultimo principal con startMs <= target.
    let active = null;
    for (const s of sections) {
      if ((s.type === 'base' || s.type === 'FM') && s.startMs <= targetMs && targetMs < s.endMs) {
        active = s;
      }
    }
    if (!active) active = sections[0];
    // TEMPO/PROB activo sobre la ventana (lo devolvemos como nota).
    const overlay = sections.find(s =>
      (s.type === 'TEMPO' || s.type === 'BECMG' || s.type === 'PROB') &&
      s.startMs <= targetMs && targetMs <= s.endMs);
    return { active, overlay };
  }

  // ── Estado ─────────────────────────────────────────────────────────

  const _state = {
    icaos:     [],
    notams:    [],
    metars:    {},      // { ICAO: rawText }
    tafs:      {},      // { ICAO: rawText }
    depTimeMs: 0,
    loading:   false,
    error:     null,
  };

  function getWxLimits() {
    const s = window.TSAgestor && window.TSAgestor.settings;
    return {
      ceilingHardFt:      s ? s.get('wxLimits.ceilingHardFt',      500) : 500,
      ceilingMarginalFt:  s ? s.get('wxLimits.ceilingMarginalFt',  1000) : 1000,
      visibilityHardM:    s ? s.get('wxLimits.visibilityHardM',    1500) : 1500,
      visibilityMarginalM:s ? s.get('wxLimits.visibilityMarginalM',3000) : 3000,
      windHardKt:         s ? s.get('wxLimits.windHardKt',         30) : 30,
      windMarginalKt:     s ? s.get('wxLimits.windMarginalKt',     20) : 20,
    };
  }

  function getDepartureMs() {
    // Si el plan ya tiene plan-departure (ISO local), usala. Si no, "ahora".
    const inp = document.getElementById('plan-departure');
    if (inp && inp.value) {
      const t = new Date(inp.value);
      if (!isNaN(t.getTime())) return t.getTime();
    }
    return Date.now();
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtZ(ms) {
    const d = new Date(ms);
    return String(d.getUTCHours()).padStart(2, '0') + 'Z';
  }
  function fmtLocal(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + 'L';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  }

  // ── Render Weather Hold (matriz horaria) ───────────────────────────

  function renderWxBoard() {
    const root = $('#notam-wx-board');
    if (!root) return;
    if (!_state.icaos.length) {
      root.innerHTML = '';
      return;
    }
    const limits = getWxLimits();
    const depMs = _state.depTimeMs;
    // Alineamos a la hora exacta y empezamos 1h antes de la salida.
    const baseHourMs = Math.floor(depMs / 3600000) * 3600000 - 1 * 3600000;
    const hours = [];
    for (let i = 0; i < WX_HOURS; i++) hours.push(baseHourMs + i * 3600000);

    // Header
    let html = '<table class="wx-board">';
    html += '<thead><tr><th rowspan="2" class="wx-th-icao">Aeródromo<div class="dim">(hover para METAR/TAF)</div></th>';
    for (const h of hours) html += `<th>${escapeHTML(fmtLocal(h))}</th>`;
    html += '</tr><tr>';
    for (const h of hours) {
      const isDep = (h <= depMs && depMs < h + 3600000);
      html += `<th class="${isDep ? 'wx-th-dep' : ''}">${escapeHTML(fmtZ(h))}</th>`;
    }
    html += '</tr></thead><tbody>';

    // Una fila por aerodromo. Origen primero (Departure), siguiente como
    // Arrival si lo hay; el resto se etiquetan "ALT" pero el flujo
    // tipico es solo 2 (orig + dest).
    const labelFor = (i) => i === 0 ? 'Departure' : (i === 1 ? 'Arrival' : 'Alt');
    for (let i = 0; i < _state.icaos.length; i++) {
      const icao = _state.icaos[i];
      html += `<tr class="wx-band"><td colspan="${WX_HOURS + 1}">${escapeHTML(labelFor(i))}</td></tr>`;
      html += `<tr><td class="wx-icao">${escapeHTML(icao)}</td>`;
      for (const h of hours) {
        const cell = evaluateAt(icao, h, limits);
        // Guardamos el contenido del popup en un data-* y lo renderizamos
        // bajo demanda en _wxPopover. Asi no usamos el title= nativo (feo
        // y sin HTML) y mantenemos el HTML escapado fuera del DOM hasta
        // que el usuario hace hover.
        const popupHTML = buildCellPopupHTML(icao, h, cell);
        const dataAttr = encodeURIComponent(popupHTML);
        html += `<td class="wx-cell wx-${cell.status}" data-icao="${escapeHTML(icao)}" data-ms="${h}" data-popup="${dataAttr}">` +
                `<span class="wx-cell-text">${cell.label || ''}</span></td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    root.innerHTML = html;
    _wirePopover(root);
  }

  // Decide METAR vs TAF para una celda y devuelve estado + texto fuente.
  function evaluateAt(icao, hourMs, limits) {
    const nowMs = Date.now();
    const metar = _state.metars[icao] || '';
    const taf   = _state.tafs[icao]   || '';
    // Si la celda esta en el pasado o dentro de la hora actual y tenemos
    // METAR, lo usamos. Para futuros, TAF.
    let source = '';
    let sourceLabel = '';
    let wx = null;
    if (hourMs <= nowMs && metar) {
      source = metar;
      sourceLabel = 'METAR';
      wx = extractWx(metar);
    } else if (taf) {
      const fr = tafForecastAt(taf, hourMs + 1800000); // medio del slot
      if (fr && fr.active) {
        source = fr.active.text;
        sourceLabel = fr.active.type === 'base' ? 'TAF (base)' : 'TAF (FM)';
        wx = extractWx(fr.active.text);
        if (fr.overlay) {
          source += '\n+overlay: ' + fr.overlay.text;
          sourceLabel += ' + ' + fr.overlay.type;
        }
      } else {
        // Sin grupo activo en el TAF para esta hora: usamos base
        source = taf;
        sourceLabel = 'TAF';
        wx = extractWx(taf);
      }
    } else if (metar) {
      // Sin TAF disponible, caemos a METAR para todas las horas (con aviso).
      source = metar;
      sourceLabel = 'METAR (sin TAF disponible)';
      wx = extractWx(metar);
    } else {
      return { status: 'unknown', label: '?', source: '', sourceLabel: '', reasons: ['Sin METAR ni TAF']  };
    }
    const ev = evalWx(wx, limits);
    return {
      status: ev.status,
      label: ev.status === 'unknown' ? '?' : '',
      reasons: ev.reasons,
      wx,
      source,
      sourceLabel,
    };
  }

  function buildCellPopupHTML(icao, hourMs, cell) {
    const md = window.TSAgestor && window.TSAgestor.metarDecode;
    const isTaf = (cell.sourceLabel || '').startsWith('TAF');
    const decoded = (md && cell.source)
      ? (isTaf ? md.decodeTAF(cell.source) : md.decodeMETAR(cell.source))
      : [];

    // Resumen rapido de minima (chips de color)
    const w = cell.wx || {};
    const chips = [];
    if (w.cavok) chips.push(`<span class="wx-chip wx-chip-ok">CAVOK</span>`);
    else if (w.nsc) chips.push(`<span class="wx-chip wx-chip-ok">NSC</span>`);
    if (w.ceilingFt != null)
      chips.push(`<span class="wx-chip">Techo ${w.ceilingFt} ft</span>`);
    if (w.visM != null)
      chips.push(`<span class="wx-chip">Vis ${w.visM >= 10000 ? '≥10 km' : w.visM + ' m'}</span>`);
    if (w.windKt != null) {
      const g = w.gustKt ? `G${w.gustKt}` : '';
      chips.push(`<span class="wx-chip">Viento ${w.windKt}${g} kt</span>`);
    }

    const reasons = (cell.reasons && cell.reasons.length)
      ? `<div class="wx-pop-reasons wx-pop-reasons-${cell.status}">${cell.reasons.map(escapeHTML).join(' · ')}</div>`
      : '';

    const rawBlock = cell.source
      ? `<details class="wx-pop-raw"><summary>Texto crudo</summary><pre>${escapeHTML(cell.source)}</pre></details>`
      : '';

    const decodedHTML = (md && decoded.length)
      ? md.toHtmlList(decoded)
      : '<i class="dim">— sin decodificacion disponible —</i>';

    return `
      <div class="wx-pop-head">
        <span class="wx-pop-icao">${escapeHTML(icao)}</span>
        <span class="wx-pop-time">${escapeHTML(fmtLocal(hourMs))} · ${escapeHTML(fmtZ(hourMs))}</span>
        <span class="wx-pop-source ${cell.status}">${escapeHTML(cell.sourceLabel || '—')}</span>
      </div>
      ${chips.length ? `<div class="wx-pop-chips">${chips.join('')}</div>` : ''}
      ${reasons}
      <div class="wx-pop-decoded">${decodedHTML}</div>
      ${rawBlock}
    `;
  }

  // ── Popover compartido para todas las celdas WX ────────────────────
  // Un solo elemento DOM en body, posicionado dinamicamente al hover de
  // una celda. Mas elegante y portable que el title= nativo, y permite
  // HTML rico (chips, listas, details).
  let _popoverEl = null;
  function _getPopover() {
    if (_popoverEl) return _popoverEl;
    _popoverEl = document.createElement('div');
    _popoverEl.className = 'wx-popover';
    _popoverEl.style.display = 'none';
    document.body.appendChild(_popoverEl);
    return _popoverEl;
  }
  function _showPopover(cell, target) {
    const pop = _getPopover();
    const html = cell.getAttribute('data-popup');
    if (!html) return;
    pop.innerHTML = decodeURIComponent(html);
    pop.style.display = 'block';
    // Posicion: bajo la celda, alineada por la izquierda. Si se sale por
    // la derecha, lo desplazamos.
    const r = cell.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    let left = window.scrollX + r.left;
    let top  = window.scrollY + r.bottom + 6;
    // Reposicionar si se sale del viewport.
    if (left + popW > window.scrollX + window.innerWidth - 8) {
      left = window.scrollX + window.innerWidth - popW - 8;
    }
    if (left < 8) left = 8;
    if (top + popH > window.scrollY + window.innerHeight - 8 && r.top > popH + 8) {
      top = window.scrollY + r.top - popH - 6;     // por encima
    }
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
  }
  function _hidePopover() {
    if (_popoverEl) _popoverEl.style.display = 'none';
  }
  function _wirePopover(root) {
    // Eventos delegados sobre la tabla; un solo set de listeners por render.
    root.addEventListener('mouseover', (e) => {
      const cell = e.target.closest && e.target.closest('.wx-cell');
      if (cell) _showPopover(cell);
    });
    root.addEventListener('mouseout', (e) => {
      const cell = e.target.closest && e.target.closest('.wx-cell');
      if (cell && !cell.contains(e.relatedTarget)) _hidePopover();
    });
    root.addEventListener('mousemove', (e) => {
      // Reposicionar si el cursor se mueve entre celdas adyacentes muy rapido.
      const cell = e.target.closest && e.target.closest('.wx-cell');
      if (cell && _popoverEl && _popoverEl.style.display === 'block') {
        // No-op: dejamos el popover donde esta para no parpadear.
      }
    });
  }

  // ── Render NOTAMs (lista plana, todos los del aerodromo) ───────────

  function isClosureNotam(notam) {
    const raw = String(notam.text || notam.raw || '');
    if (/Q\)\s*[A-Z]{4}\/Q(?:MR|MA)(?:LC|LX)\//.test(raw)) return true;
    if (/\b(?:AD|AERODROME)\s+CLSD\b/i.test(raw)) return true;
    if (/\bALL\s+RWYS?\s+CLSD\b/i.test(raw)) return true;
    if (/\bRWY\s+[A-Z0-9\/]+\s+CLSD\b/i.test(raw)) return true;
    return false;
  }

  // M-series NOTAMs (M0833/26 estilo) son los emitidos por la FIR para
  // areas militares de operacion, corredores, ejercicios, etc. Tipico
  // de Espanya/Portugal (LECM/LECB/LPPC/GCCC). Los marcamos visualmente
  // con un tag AREA para que el piloto los identifique de un vistazo.
  function isAreaNotam(notam) {
    const id = String(notam.notamId || notam.id || '');
    if (/^M\d/.test(id)) return true;        // M-series por id
    if (notam.series === 'M') return true;   // si el API entrega series aparte
    const raw = String(notam.text || notam.raw || '');
    // Heuristicas de texto: AREA, CORREDOR, TSA, TRA, TMZ, CTA, FIR boundary
    if (/\b(AREA|CORRIDOR|CORREDOR|TSA|TRA|TMZ|RMZ|ESPACIO\s+AEREO)\b/i.test(raw)) return true;
    return false;
  }

  function renderNotamCard(n) {
    const raw = String(n.text || n.raw || '');
    const closure = isClosureNotam(n);
    const isArea  = isAreaNotam(n);
    const tags = [];
    if (closure) tags.push('<span class="notam-tag">CIERRE</span>');
    if (isArea && !closure) tags.push('<span class="notam-tag notam-tag-area">ÁREA</span>');
    return `
      <div class="notam-card ${closure ? 'notam-card-closure' : (isArea ? 'notam-card-area' : '')}">
        <div class="notam-head">
          <span class="notam-id"><b>${escapeHTML(n.notamId || n.id || '—')}</b></span>
          <span class="notam-ad">${escapeHTML(n.icaoLocation || n.location || '')}</span>
          <span class="notam-window">${fmtDate(n.fromDate || n.startValidity)} → ${fmtDate(n.toDate || n.endValidity)}</span>
          ${tags.join('')}
        </div>
        <pre class="notam-body">${escapeHTML(raw)}</pre>
      </div>`;
  }

  // Devuelve las FIRs aplicables a una lista de aerodromos. Siempre
  // incluimos LPPC (Lisboa) porque el usuario opera con cobertura
  // peninsular ibérica completa y los NOTAMs M-series portugueses
  // pueden afectar rutas Madrid-Lisboa o transitos al Atlantico.
  function firsForIcaos(icaos) {
    const firs = new Set(['LPPC']);
    for (const icao of icaos) {
      const p = (icao || '').slice(0, 2).toUpperCase();
      if (p === 'LE') { firs.add('LECM'); firs.add('LECB'); }
      else if (p === 'GC') { firs.add('GCCC'); }
      else if (p === 'LP') { firs.add('LPPC'); }
      else if (p === 'GM') { firs.add('GMMM'); }
      else if (p === 'LF') { firs.add('LFFF'); firs.add('LFMM'); }   // Francia
      else if (p === 'EG') { firs.add('EGTT'); }                       // UK
      else if (p === 'DA') { firs.add('DAAA'); }                       // Argelia
    }
    return [...firs];
  }
  const FIR_ICAO_RE = /^(LECM|LECB|LPPC|GCCC|GMMM|LFFF|LFMM|EGTT|DAAA)$/;
  function isFir(icao) { return FIR_ICAO_RE.test(icao); }

  function renderNotamList() {
    const root = $('#notam-results');
    if (!root) return;
    if (_state.error) {
      root.innerHTML = `<div class="notam-empty error"><b>Error al cargar NOTAMs:</b> ${escapeHTML(_state.error)}</div>`;
      return;
    }
    if (_state.loading) {
      root.innerHTML = '<div class="notam-empty"><i>Cargando NOTAMs y METAR/TAF…</i></div>';
      return;
    }
    if (!_state.icaos.length) {
      root.innerHTML = '';
      return;
    }
    // Agrupados por icaoLocation. Despues separamos por tipo (aerodromo
    // o FIR) para renderizar en dos bloques distintos.
    const byIcao = {};
    for (const n of _state.notams) {
      const k = String(n.icaoLocation || n.location || '?').toUpperCase();
      (byIcao[k] = byIcao[k] || []).push(n);
    }

    const sortFn = (a, b) => {
      const ca = isClosureNotam(a) ? 0 : 1, cb = isClosureNotam(b) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const ta = new Date(a.fromDate || a.startValidity || 0).getTime();
      const tb = new Date(b.fromDate || b.startValidity || 0).getTime();
      return tb - ta;
    };

    const renderSection = (icao, list, opts) => {
      list = list.slice().sort(sortFn);
      const closures = list.filter(isClosureNotam).length;
      const areas    = list.filter(isAreaNotam).length;
      const badges = [
        `<span class="badge">${list.length} NOTAMs</span>`,
        closures ? `<span class="badge badge-red">${closures} cierre${closures > 1 ? 's' : ''}</span>` : '',
        areas    ? `<span class="badge badge-amber">${areas} área${areas > 1 ? 's' : ''}</span>` : '',
      ].filter(Boolean).join(' ');
      const title = opts && opts.firLabel
        ? `<span class="dim">FIR ·</span> ${escapeHTML(icao)}`
        : escapeHTML(icao);
      return `
        <section class="notam-bucket ${opts && opts.firLabel ? 'notam-bucket-fir' : ''}">
          <h3>${title} ${badges}</h3>
          ${list.length ? list.map(renderNotamCard).join('') : '<div class="dim">Sin NOTAMs activos</div>'}
        </section>`;
    };

    // Bloque 1: NOTAMs por aerodromo (los ICAOs que pidio el usuario)
    const adSections = _state.icaos.map(icao => renderSection(icao, byIcao[icao] || [])).join('');

    // Bloque 2: NOTAMs por FIR (areas, corredores, M-series). Solo
    // mostramos FIRs que efectivamente devolvieron NOTAMs.
    const firsWithData = (_state.firs || []).filter(f => (byIcao[f] || []).length > 0);
    const firSections = firsWithData.length
      ? `<h2 class="notam-section-title">NOTAMs de FIR (áreas y corredores)</h2>
         <p class="dim notam-hint">Incluye M-series (áreas militares, corredores) y NOTAMs de espacio aéreo.</p>` +
        firsWithData.map(fir => renderSection(fir, byIcao[fir], { firLabel: true })).join('')
      : '';

    root.innerHTML = adSections + firSections;
  }

  function render() {
    renderWxBoard();
    renderNotamList();
  }

  function setStatus(msg, kind) {
    const el = $('#notam-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ── Carga combinada ────────────────────────────────────────────────

  async function loadFor(icaoList) {
    const mapi = window.TSAgestor && window.TSAgestor.meteoApi;
    if (!mapi) {
      _state.error = 'meteoApi no disponible';
      render(); return;
    }
    _state.icaos = icaoList.slice();
    _state.firs  = firsForIcaos(icaoList);
    _state.depTimeMs = getDepartureMs();
    _state.loading = true;
    _state.error = null;
    _state.notams = [];
    _state.metars = {};
    _state.tafs = {};
    render();
    const fullList = [...icaoList, ..._state.firs];
    setStatus(`Consultando NOTAMs (${icaoList.length} aeródromos + ${_state.firs.length} FIRs) y METAR/TAF…`, 'loading');

    // 3 fuentes paralelas:
    //   (1) Autorouter /notam con itemas = aerodromos + FIRs.
    //   (2) NotamHub /notams/aerodrome/{icao} + /notams/fir/{icao} para
    //       cada item de la lista. Solo entrega NOTAMs de territorio
    //       nacional, asi que ICAOs extranjeros vuelven vacios.
    //   (3) AWC METAR / TAF.
    // Las fuentes 1 y 2 se mezclan despues por notamId para no duplicar.
    const nh = window.TSAgestor && window.TSAgestor.notamHub;
    const notamPromise = mapi.fetchNotamsForAerodromes(fullList)
      .catch(e => { console.warn('[notam] Autorouter fetch error:', e); return { __error: e }; });
    const notamHubPromise = (nh && nh.fetchAllNotamsFor)
      ? nh.fetchAllNotamsFor(fullList).catch(e => {
          console.warn('[notam] NotamHub fetch error:', e); return [];
        })
      : Promise.resolve([]);
    const metarPromise = mapi.fetchMETAR ? mapi.fetchMETAR(icaoList).catch(e => {
      console.warn('[metar] fetch error:', e); return {};
    }) : Promise.resolve({});
    const tafPromise   = mapi.fetchTAF   ? mapi.fetchTAF(icaoList).catch(e => {
      console.warn('[taf] fetch error:', e); return {};
    }) : Promise.resolve({});

    const [notamRes, notamHubRes, metarRes, tafRes] = await Promise.all([
      notamPromise, notamHubPromise, metarPromise, tafPromise,
    ]);

    _state.metars = normalizeReports(metarRes);
    _state.tafs   = normalizeReports(tafRes);

    // Procesamos Autorouter (puede traer error, en cuyo caso solo
    // mostramos lo de NotamHub).
    let arNotams = [];
    let arError = null;
    if (notamRes && notamRes.__error) {
      const msg = String(notamRes.__error.message || notamRes.__error);
      if (msg === 'SERVER_NO_CREDS' || msg === 'TOKEN_REJECTED' || msg === 'NO_CREDS') {
        arError = 'Autorouter sin credenciales (ENV AUTOROUTER_USER/PASS).';
      } else {
        arError = 'Autorouter: ' + msg;
      }
    } else {
      arNotams = Array.isArray(notamRes) ? notamRes : (notamRes && notamRes.notams) || [];
    }
    const nhNotams = Array.isArray(notamHubRes) ? notamHubRes : [];

    // Fusion + dedup por notamId. Cuando ambas fuentes entregan el
    // mismo NOTAM (lo normal para boletines espanyoles), nos quedamos
    // con el de NotamHub porque su cuerpo (body) viene preparseado
    // y ademas indica is_permanent/is_estimate.
    const byId = new Map();
    for (const n of arNotams) {
      const id = String(n && (n.notamId || n.id) || '').trim();
      if (!id) continue;
      byId.set(id, Object.assign({ _source: 'autorouter' }, n));
    }
    for (const n of nhNotams) {
      const id = String(n.notamId || '').trim();
      if (!id) continue;
      byId.set(id, n);       // NotamHub gana
    }
    _state.notams = Array.from(byId.values());

    // Si SOLO falla Autorouter y NotamHub trajo cosas, ocultamos el
    // error (el usuario tiene datos para el origen nacional).
    if (arError && _state.notams.length === 0) {
      _state.error = arError;
    } else if (arError) {
      console.info('[notam] Autorouter fallo pero NotamHub trajo ' +
                   _state.notams.length + ' NOTAMs; ignoramos el error.');
    }

    _state.loading = false;
    const adCount   = _state.notams.filter(n => !isFir(String(n.icaoLocation || '').toUpperCase())).length;
    const firCount  = _state.notams.filter(n =>  isFir(String(n.icaoLocation || '').toUpperCase())).length;
    const fromAr    = _state.notams.filter(n => n._source === 'autorouter').length;
    const fromNh    = _state.notams.filter(n => n._source === 'notamhub').length;
    setStatus(
      `${_state.notams.length} NOTAMs (${adCount} aeródromo · ${firCount} FIR) ` +
      `· fuente: ${fromAr} Autorouter · ${fromNh} NotamHub ` +
      `· ${Object.keys(_state.metars).length} METAR · ${Object.keys(_state.tafs).length} TAF` +
      (_state.error ? ' · ⚠ error en NOTAMs' : ''),
      _state.error ? 'error' : 'ok'
    );
    render();
  }

  // Normaliza la respuesta de meteoApi.fetchMETAR/fetchTAF a
  // { ICAO: rawText }. Las funciones del repo devuelven la forma
  //   { ICAO: { raw: 'METAR ...', ... } }
  // pero soportamos tambien el formato bruto AWC (array con rawOb/rawTAF)
  // por si algun proxy lo entrega directo.
  function normalizeReports(res) {
    if (!res) return {};
    if (Array.isArray(res)) {
      const out = {};
      for (const item of res) {
        if (!item) continue;
        const id = String(item.icaoId || item.station || '').toUpperCase();
        const raw = item.rawOb || item.rawTAF || item.raw;
        if (id && raw) out[id] = raw;
      }
      return out;
    }
    if (typeof res === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(res)) {
        const id = String(k).toUpperCase();
        if (typeof v === 'string') out[id] = v;
        else if (v && (v.raw || v.rawOb || v.rawTAF)) out[id] = v.raw || v.rawOb || v.rawTAF;
      }
      return out;
    }
    return {};
  }

  // ── Wire-up UI ─────────────────────────────────────────────────────

  function getCurrentPlanIcaos() {
    const o = (document.getElementById('plan-origin') || {}).value;
    const d = (document.getElementById('plan-dest')   || {}).value;
    const out = [];
    if (o && /^[A-Z]{4}$/i.test(String(o).trim())) out.push(String(o).trim().toUpperCase());
    if (d && /^[A-Z]{4}$/i.test(String(d).trim())) out.push(String(d).trim().toUpperCase());
    // Dedup conservando orden.
    return [...new Set(out)];
  }

  function onTabOpen() {
    _wireUI();
    const planIcaos = getCurrentPlanIcaos();
    const input = $('#notam-icaos');
    if (input && !input.value && planIcaos.length) {
      input.value = planIcaos.join(' ');
    }
  }

  function _wireUI() {
    const btn = $('#btn-notam-load');
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', () => {
        const raw = ($('#notam-icaos') || {}).value || '';
        const list = raw.split(/[\s,;]+/).map(s => s.trim().toUpperCase())
                        .filter(s => /^[A-Z]{4}$/.test(s));
        if (!list.length) {
          setStatus('Introduce al menos un ICAO valido (4 letras).', 'error');
          return;
        }
        loadFor(list);
      });
    }
    const btnPlan = $('#btn-notam-from-plan');
    if (btnPlan && !btnPlan._wired) {
      btnPlan._wired = true;
      btnPlan.addEventListener('click', () => {
        const icaos = getCurrentPlanIcaos();
        if (!icaos.length) {
          setStatus('No hay origen/destino en el plan de vuelo.', 'error');
          return;
        }
        const input = $('#notam-icaos');
        if (input) input.value = icaos.join(' ');
        loadFor(icaos);
      });
    }
    // Si el usuario cambia los limites en Ajustes, repintamos sin refetch.
    const s = window.TSAgestor && window.TSAgestor.settings;
    if (s && s.onChange && !_wireUI._settingsHook) {
      _wireUI._settingsHook = true;
      s.onChange((path) => {
        if (typeof path === 'string' && path.startsWith('wxLimits.')) {
          renderWxBoard();
        }
      });
    }
  }

  return {
    onTabOpen,
    loadFor,
    // Expuesto para pruebas / debug
    _extractWx: extractWx,
    _evalWx: evalWx,
    _tafForecastAt: tafForecastAt,
  };
})();
