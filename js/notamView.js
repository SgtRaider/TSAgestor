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
  //
  // Weather phenomena tokens (WMO 306):
  //   intensity[-|+|VC]  descriptor[MI|PR|BC|DR|BL|SH|TS|FZ]?  phenomena+
  //   phenomena precip: DZ|RA|SN|SG|IC|PL|GR|GS|UP
  //   phenomena obscur: BR|FG|FU|VA|DU|SA|HZ|PY
  //   phenomena otros:  PO|SQ|FC|SS|DS
  //   RE... = recent (ultimo hora) — se cuenta igual.
  const WX_PHENOM_RE = /^(RE)?([\-+]|VC)?((?:MI|PR|BC|DR|BL|SH|TS|FZ)?)((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)$/;

  // Escanea un texto y devuelve flags de fenomenos operativamente
  // significativos ademas de la lista cruda de tokens WX para diagnostico.
  function scanPhenomena(text) {
    const flags = {
      rain: false, thunder: false, freezing: false,
      hail: false, snow: false, tornado: false,
      heavy: false, tokens: [],
    };
    if (!text) return flags;
    for (const rawTok of String(text).split(/\s+/)) {
      const tok = rawTok.trim();
      if (!tok) continue;
      const m = tok.match(WX_PHENOM_RE);
      if (!m) continue;
      const intensity = m[2] || '';
      const desc      = m[3] || '';
      const phen      = m[4] || '';
      flags.tokens.push(tok);
      if (intensity === '+') flags.heavy = true;
      // Tormenta: descriptor TS o phenom TS (VCTS / TS solo)
      if (desc === 'TS' || /TS/.test(phen)) flags.thunder = true;
      // Freezing (rain / drizzle / fog)
      if (desc === 'FZ') flags.freezing = true;
      // Lluvia (cualquier variante: RA, SHRA, TSRA, FZRA, -RA, +RA...)
      if (/RA/.test(phen)) flags.rain = true;
      // Granizo (GR o GS)
      if (/GR|GS/.test(phen)) flags.hail = true;
      // Nieve
      if (/SN|SG|PL/.test(phen)) flags.snow = true;
      // Tornado / funnel cloud
      if (/FC/.test(phen)) flags.tornado = true;
    }
    return flags;
  }

  // Extrae techo (ft), visibilidad (m), viento maximo (kt) y fenomenos
  // significativos de un trozo de reporte METAR/TAF. Devuelve null si el
  // reporte no es interpretable.
  function extractWx(reportText) {
    if (!reportText) return null;
    const tokens = String(reportText).split(/\s+/);
    const out = {
      ceilingFt: null, visM: null, windKt: null, gustKt: null,
      cavok: false, nsc: false,
      phenomena: scanPhenomena(reportText),
    };
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
    // Fenomenos significativos → rojo. Se aplica tanto al METAR (observado)
    // como al grupo activo del TAF y a las overlays TEMPO/PROB (previsto).
    const ph = wx.phenomena || {};
    if (ph.thunder)  { worst('red'); reasons.push('Tormenta (TS)'); }
    if (ph.rain)     { worst('red'); reasons.push(ph.heavy ? 'Lluvia intensa' : 'Lluvia (RA)'); }
    if (ph.freezing) { worst('red'); reasons.push('Precip. engelante (FZ)'); }
    if (ph.hail)     { worst('red'); reasons.push('Granizo (GR/GS)'); }
    if (ph.tornado)  { worst('red'); reasons.push('Nube embudo / tornado (FC)'); }
    if (ph.snow && status !== 'red') { worst('yellow'); reasons.push('Nieve (SN)'); }
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
    // Filtros: preset ∈ {all, closures, next24h, perm, expired-soon}
    // category ∈ null | 'RWY' | 'TWY' | ... (ver classifyNotam)
    // sort ∈ {time-desc, time-asc, cat, icao}
    filter: {
      preset:   'all',
      category: '',
      sort:     'time-desc',
    },
  };

  function getWxLimits() {
    const s = window.TSAgestor && window.TSAgestor.settings;
    return {
      ceilingHardFt:      s ? s.get('wxLimits.ceilingHardFt',      1500) : 1500,
      ceilingMarginalFt:  s ? s.get('wxLimits.ceilingMarginalFt',  2000) : 2000,
      visibilityHardM:    s ? s.get('wxLimits.visibilityHardM',    3000) : 3000,
      visibilityMarginalM:s ? s.get('wxLimits.visibilityMarginalM',5000) : 5000,
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
    if (_state.loading) {
      // Skeleton de la matriz: filas con celdas pulsantes (1 fila por
      // ICAO). El layout coincide con el wx-board final para evitar
      // jump visual al cambiar de skeleton a tabla real.
      const cells = Array.from({length: WX_HOURS}, () => '<td><span class="skel-bar skel-bar-wxcell"></span></td>').join('');
      const rows = _state.icaos.map(icao => `
        <tr>
          <td class="wx-icao">${escapeHTML(icao)}</td>
          ${cells}
        </tr>`).join('');
      root.innerHTML = `
        <table class="wx-board wx-board-skeleton" aria-busy="true">
          <thead><tr><th></th>${Array.from({length: WX_HOURS}, () => '<th><span class="skel-bar skel-bar-sm"></span></th>').join('')}</tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
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
          // Los TEMPO/BECMG/PROB son "previsto" — sus fenomenos cuentan
          // para el color aunque no sobrescriban los minima numericos.
          const ovPh = scanPhenomena(fr.overlay.text);
          if (wx && wx.phenomena) {
            wx.phenomena.rain     = wx.phenomena.rain     || ovPh.rain;
            wx.phenomena.thunder  = wx.phenomena.thunder  || ovPh.thunder;
            wx.phenomena.freezing = wx.phenomena.freezing || ovPh.freezing;
            wx.phenomena.hail     = wx.phenomena.hail     || ovPh.hail;
            wx.phenomena.snow     = wx.phenomena.snow     || ovPh.snow;
            wx.phenomena.tornado  = wx.phenomena.tornado  || ovPh.tornado;
            wx.phenomena.heavy    = wx.phenomena.heavy    || ovPh.heavy;
            wx.phenomena.tokens   = wx.phenomena.tokens.concat(ovPh.tokens);
          }
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
    const ph = w.phenomena || {};
    if (ph.thunder)  chips.push(`<span class="wx-chip wx-chip-bad">Tormenta</span>`);
    if (ph.rain)     chips.push(`<span class="wx-chip wx-chip-bad">${ph.heavy ? 'Lluvia +' : 'Lluvia'}</span>`);
    if (ph.freezing) chips.push(`<span class="wx-chip wx-chip-bad">Engelante</span>`);
    if (ph.hail)     chips.push(`<span class="wx-chip wx-chip-bad">Granizo</span>`);
    if (ph.snow)     chips.push(`<span class="wx-chip">Nieve</span>`);
    if (ph.tornado)  chips.push(`<span class="wx-chip wx-chip-bad">Tornado</span>`);

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

  // Clasificacion por categoria. Devuelve { id, label } usado como
  // modificador CSS (.notam-cat-{id}) y texto del badge. Prioridad:
  //   1) Q-code (si esta presente en el body — formato ICAO).
  //   2) Heuristicas de texto en castellano e ingles.
  // El id se mantiene corto y estable porque tambien pinta el color
  // del borde izquierdo del card.
  function classifyNotam(notam) {
    const raw = String(notam.text || notam.raw || notam.body || '').toUpperCase();
    const q = raw.match(/Q\)\s*[A-Z]{4}\/Q([A-Z])([A-Z])/);
    if (q) {
      const c1 = q[1];
      if (c1 === 'M') return { id: 'RWY',  label: 'Pista' };
      if (c1 === 'L') return { id: 'LGT',  label: 'Iluminación' };
      if (c1 === 'I' || c1 === 'N') return { id: 'NAV', label: 'Radioayudas' };
      if (c1 === 'G') return { id: 'GPS',  label: 'GNSS' };
      if (c1 === 'C') return { id: 'COMM', label: 'Comunicaciones' };
      if (c1 === 'A') return { id: 'ATC',  label: 'ATC' };
      if (c1 === 'O') return { id: 'OBST', label: 'Obstáculo' };
      if (c1 === 'F') return { id: 'FAC',  label: 'Instalaciones' };
      if (c1 === 'P') return { id: 'PROC', label: 'Procedimientos' };
      if (c1 === 'W') return { id: 'WARN', label: 'Aviso' };
    }
    // Test order: lo MAS especifico primero. Procedimientos (IAC/RNP/
    // SID/STAR) y augmentaciones GNSS (GBAS/SBAS/EGNOS) se evaluan
    // ANTES que RWY/NAV genericos porque un NOTAM tipo "IAC 1 - RNP Z
    // RWY 07 NO AVBL" es semanticamente un problema de procedimiento,
    // no de pista; y "GBAS GLS RWY 14L U/S" es GNSS, no NAV.
    if (/\b(SID|STAR|APCH|IAC|IAP|RNP|RNAV)\b/.test(raw))            return { id: 'PROC', label: 'Procedimientos' };
    if (/\b(GBAS|SBAS|EGNOS|GPS|GNSS|RAIM)\b/.test(raw))             return { id: 'GPS',  label: 'GNSS' };
    if (/\b(CRANE|GRUA|OBSTACL|OBST\b|MAST|TORRE|CHIMNEY)\b/.test(raw)) return { id: 'OBST', label: 'Obstáculo' };
    // LGT antes que RWY porque "VASIS RWY 13 U/S" es un problema de
    // iluminacion, no de pista. PAPI/VASIS/LGT son keywords muy
    // especificos: solo aparecen en NOTAMs de iluminacion.
    if (/\b(PAPI|VASIS|LIGHT(?:ING)?|LGT|ILUMINACI[OÓ]N)\b/.test(raw)) return { id: 'LGT',  label: 'Iluminación' };
    if (/\b(RWY|RUNWAY|PISTA)\b/.test(raw))                          return { id: 'RWY',  label: 'Pista' };
    if (/\b(TWY|TAXIWAY|RODAJE|APN|APRON|PLATAFORMA)\b/.test(raw))   return { id: 'TWY',  label: 'Calle de rodaje' };
    if (/\b(ILS|VOR|NDB|DME|LOC|GP|TACAN)\b/.test(raw))              return { id: 'NAV',  label: 'Radioayudas' };
    if (/\b(GCA|TWR|APP|ATC|TORRE\s+CONTROL)\b/.test(raw))           return { id: 'ATC',  label: 'ATC' };
    if (/\b(FREQ|FRECUENCIA|MHZ|KHZ|ATIS|GND\s+CTL)\b/.test(raw))    return { id: 'COMM', label: 'Comunicaciones' };
    if (/\b(FUEL|JET\s*A1|AVGAS|COMBUSTIBLE)\b/.test(raw))           return { id: 'FUEL', label: 'Combustible' };
    if (/\b(WIP|WORK\s+IN\s+PROGRESS|TRABAJOS|OBRAS)\b/.test(raw))   return { id: 'WIP',  label: 'Obras' };
    if (/\b(AIP|AMDT|SUP)\b/.test(raw))                              return { id: 'AIP',  label: 'AIP' };
    return { id: 'OTHER', label: 'Otros' };
  }

  // Estado temporal relativo. Devuelve { kind, label } para pintar un
  // chip junto a la ventana de validez. nowMs por defecto = ahora.
  function notamTimeStatus(notam, nowMs) {
    nowMs = nowMs || Date.now();
    const fromMs = Date.parse(notam.fromDate || notam.startValidity || '');
    if (Number.isNaN(fromMs)) return null;
    const permanent = !!notam._isPermanent ||
      /PERM/i.test(String(notam.toDate || notam.endValidity || ''));
    const toMs = permanent ? Infinity : Date.parse(notam.toDate || notam.endValidity || '');
    if (!permanent && Number.isNaN(toMs)) return null;

    const HOUR = 3600 * 1000;
    const DAY  = 24 * HOUR;

    if (nowMs < fromMs) {
      return { kind: 'future', label: 'Inicia en ' + humanDelta(fromMs - nowMs) };
    }
    if (!permanent && nowMs > toMs) {
      return { kind: 'expired', label: 'Expirado' };
    }
    if (permanent) {
      return { kind: 'perm', label: 'Activo · PERM' };
    }
    const left = toMs - nowMs;
    if (left < HOUR)       return { kind: 'urgent', label: 'Termina en <1 h' };
    if (left < DAY)        return { kind: 'urgent', label: 'Termina en ' + humanDelta(left) };
    if (left < 3 * DAY)    return { kind: 'soon',   label: 'Termina en ' + humanDelta(left) };
    return { kind: 'active', label: 'Activo · ' + humanDelta(left) + ' restantes' };
  }

  function humanDelta(ms) {
    if (ms < 60 * 1000) return '<1 min';
    const min = Math.round(ms / 60000);
    if (min < 60) return min + ' min';
    const h = Math.round(min / 60);
    if (h < 48) return h + ' h';
    const d = Math.round(h / 24);
    return d + ' d';
  }

  // Subraya tokens operativamente relevantes dentro del texto crudo del
  // NOTAM. La entrada se escapa primero a HTML, luego se inyectan los
  // <span> con clases hl-* (RWY/TWY codes, frecuencias, FL, estados
  // U/S/CLSD/AVBL, fechas). Asi el piloto identifica de un vistazo
  // que esta limitado.
  function highlightBody(text) {
    let s = String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    // RWY/TWY designators (RWY 14L/32R, RWY 04, TWY E-4, TWY B)
    s = s.replace(/\bRWY\s+([0-9]{1,2}[LRC]?(?:\/[0-9]{1,2}[LRC]?)?)\b/g,
      '<span class="hl-rwy">RWY $1</span>');
    s = s.replace(/\bTWY\s+([A-Z](?:[0-9A-Z\-\/]{0,6}))\b/g,
      '<span class="hl-twy">TWY $1</span>');
    // Frecuencias VHF/MHz/kHz
    s = s.replace(/\b(\d{3}\.\d{1,3})\s*MHZ\b/g, '<span class="hl-freq">$1 MHz</span>');
    s = s.replace(/\b(\d{3,4})\s*KHZ\b/g, '<span class="hl-freq">$1 kHz</span>');
    // Niveles de vuelo y altitudes
    s = s.replace(/\bFL\s*0*([0-9]{2,3})\b/g, '<span class="hl-fl">FL$1</span>');
    s = s.replace(/\b(\d{3,5})\s*FT\s*(AMSL|MSL|AGL|GND)?\b/g, function(_m, ft, ref) {
      return '<span class="hl-fl">' + ft + ' FT' + (ref ? ' ' + ref : '') + '</span>';
    });
    // Estado: malo
    s = s.replace(/\b(U\/S|UNSERVICEABLE|CLSD|CLOSED|CERRAD[OA]S?|NOT\s+AVBL|NO\s+AVBL|PROHIB)\b/g,
      '<span class="hl-bad">$1</span>');
    // Estado: bueno
    s = s.replace(/\b(AVBL|AVAILABLE|DISPONIBLE|SERVICEABLE)\b/g,
      '<span class="hl-good">$1</span>');
    // Estado: precaucion
    s = s.replace(/\b(LIMITADO|LIMITED|DEGRADED|DEGRADADO|RESTRINGIDO|RESTRICTED|REDUCED)\b/g,
      '<span class="hl-warn">$1</span>');
    return s;
  }

  function renderNotamCard(n) {
    const raw = String(n.text || n.raw || n.body || '');
    const closure = isClosureNotam(n);
    const isArea  = isAreaNotam(n);
    const id = String(n.notamId || n.id || '—');
    const series = id.match(/^([A-Z])/) ? id[0] : '';
    const seriesLabel = ({
      A: 'AD intl', B: 'AD reg', C: 'COMM', D: 'Danger',
      E: 'En-route', G: 'GPS',   M: 'Mil',  W: 'Warning',
      L: 'Lighting', R: 'Restrict',
    })[series] || '';
    const fromIso = n.fromDate || n.startValidity;
    const toIso   = n.toDate   || n.endValidity;
    const perm = n._isPermanent || (toIso && /PERM/i.test(String(toIso)));
    const cat = classifyNotam(n);
    const status = notamTimeStatus(n);

    const tags = [];
    if (closure) tags.push('<span class="notam-tag notam-tag-red">CIERRE</span>');
    else tags.push(`<span class="notam-tag notam-cat-tag notam-cat-${cat.id}">${escapeHTML(cat.label)}</span>`);
    if (isArea && !closure) tags.push('<span class="notam-tag notam-tag-amber">ÁREA</span>');
    if (perm) tags.push('<span class="notam-tag notam-tag-grey">PERM</span>');
    if (n._isEstimate) tags.push('<span class="notam-tag notam-tag-grey" title="Validez estimada">EST</span>');

    const cardClass = closure
      ? 'notam-card-closure'
      : (isArea ? 'notam-card-area' : `notam-card-cat-${cat.id}`);

    // Cabecera estructurada con chips de metadatos
    const metaChips = [];
    if (n.icaoLocation || n.location) {
      metaChips.push(`<span class="notam-chip notam-chip-icao">${escapeHTML(n.icaoLocation || n.location)}</span>`);
    }
    if (seriesLabel) {
      metaChips.push(`<span class="notam-chip notam-chip-series" title="Serie ICAO ${escapeHTML(series)}">${escapeHTML(series)} · ${escapeHTML(seriesLabel)}</span>`);
    }

    const statusChip = status
      ? `<span class="notam-status-chip notam-status-${status.kind}">${escapeHTML(status.label)}</span>`
      : '';

    return `
      <article class="notam-card ${cardClass}">
        <header class="notam-card-head">
          <div class="notam-card-head-left">
            <span class="notam-id">${escapeHTML(id)}</span>
            ${metaChips.join('')}
            ${tags.join('')}
          </div>
          <div class="notam-card-window">
            ${statusChip}
            <span class="notam-window-dates">
              <span class="notam-window-label">Desde</span> ${escapeHTML(fmtDate(fromIso))}
              <span class="notam-window-arrow">→</span>
              <span class="notam-window-label">Hasta</span> ${perm ? '<b>PERM</b>' : escapeHTML(fmtDate(toIso))}
            </span>
          </div>
        </header>
        <pre class="notam-body">${highlightBody(raw)}</pre>
      </article>`;
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

  // Decide si una `section` del NOTAM corresponde a un apartado de
  // area / espacio aereo segregado / TSA. ICARO XXI usa los nombres
  // "AREAS", "AREAS SEGREGADAS", "ESPACIO AEREO", etc.
  function isAreaSection(section) {
    if (!section) return false;
    const s = String(section).toUpperCase();
    return /\bAREAS?\b/.test(s) ||
           /\bSEGREGAD/.test(s) ||
           /\bTSA\b/.test(s) ||
           /\bTRA\b/.test(s) ||
           /\bESPACIO\s+AEREO\b/.test(s);
  }

  // Decide si una `section` del NOTAM lo marca explicitamente como
  // NOTAM de aerodromo (AERODROMOS / WARNINGS_AERODROMOS). Si es asi,
  // NO aplicamos el filtro por serie ICAO (D/M/W) — esos NOTAMs son
  // warnings del aerodromo aunque su body describa TSAs cercanas.
  // Ejemplo verificado: D3006/26 (section=WARNINGS_AERODROMOS,
  // aerodrome=LEBZ) describe TSA TALAVERA LOW que afecta a LEBZ;
  // antes se descartaba por empezar con D, ahora se conserva.
  function isAerodromeSection(section) {
    if (!section) return false;
    return /AERODROMOS?/i.test(String(section));
  }

  // Detecta NOTAMs de area por OTROS criterios ademas de la section:
  //   - Series ICAO D / M / W (D = danger area / military activity,
  //     M = military, W = warning). En el sistema espanyol estos son
  //     los apartados de areas peligrosas / segregadas.
  //   - Q-code subject R* (RR restringido, RD peligroso, RT temporal,
  //     RP prohibido, RA airspace, RM restringido militar) que ICAO
  //     usa para clasificar NOTAMs de espacio aereo.
  function isAreaByIdOrQcode(notam) {
    const id = String(notam.notamId || notam.id || '').trim();
    // D2428/26, M0833/26, W0123/26 -> primera letra es la serie.
    if (/^[DMW]\d/.test(id)) return true;
    const raw = String(notam.text || notam.raw || notam.body || '');
    // Q-line: Q) FIR/QXXYY/...  primera pareja XX = subject. R* = areas.
    const m = raw.match(/Q\)\s*[A-Z]{4}\/Q([A-Z]{2})([A-Z]{2})\//);
    if (m && /^R[RDPTAM]$/.test(m[1])) return true;
    return false;
  }

  // Detecta NOTAMs de area por el CONTENIDO del body, no por section
  // ni por serie. Algunos NOTAMs (p.ej. D3006/26 sobre TSA TALAVERA
  // LOW) vienen del API marcados con section=WARNINGS_AERODROMOS
  // porque su aeropuerto vecino se ve afectado, pero su contenido es
  // claramente un NOTAM de TSA y el usuario no lo quiere en la lista
  // de aerodromo. El body manda cuando estas frases aparecen.
  function isAreaByBody(notam) {
    const raw = String(notam.text || notam.raw || notam.body || '');
    if (!raw) return false;
    // Castellano (ICARO XXI) e ingles (ICAO).
    return /\b(?:TSA|TRA)\s+[A-Z0-9]/.test(raw) ||                      // "TSA TALAVERA", "TRA NORTE"
           /AREAS?\s+TEMPORALMENTE\s+SEGREGAD/i.test(raw) ||             // "AREAS TEMPORALMENTE SEGREGADAS"
           /TEMPO(?:RARY)?\s+SEGREGATED\s+AREA/i.test(raw) ||            // "TEMPORARY SEGREGATED AREA"
           /AREAS?\s+SEGREGAD/i.test(raw) ||                             // "AREA SEGREGADA"
           /CORREDOR(?:\s+(?:NORTE|SUR|ESTE|OESTE))?\b/i.test(raw) ||    // "CORREDOR SUR", "CORREDOR"
           /\bPASILLO\b/i.test(raw);                                     // "PASILLO HUELVA"
  }

  // Categorias disponibles para el filtro (mismas que classifyNotam).
  const NOTAM_FILTER_CATEGORIES = [
    { id: 'RWY',  label: 'Pista' },
    { id: 'TWY',  label: 'Calle de rodaje' },
    { id: 'LGT',  label: 'Iluminación' },
    { id: 'NAV',  label: 'Radioayudas' },
    { id: 'GPS',  label: 'GNSS' },
    { id: 'COMM', label: 'Comunicaciones' },
    { id: 'ATC',  label: 'ATC' },
    { id: 'OBST', label: 'Obstáculo' },
    { id: 'FUEL', label: 'Combustible' },
    { id: 'WIP',  label: 'Obras' },
    { id: 'PROC', label: 'Procedimientos' },
    { id: 'AIP',  label: 'AIP' },
    { id: 'OTHER', label: 'Otros' },
  ];

  // Aplica el filtro/orden actual a una lista de NOTAMs. La filtracion
  // es AND entre preset + categoria; el orden se aplica por separado.
  function applyNotamFilter(list, nowMs) {
    nowMs = nowMs || Date.now();
    const f = _state.filter || { preset: 'all', category: '', sort: 'time-desc' };
    const DAY = 24 * 3600 * 1000;
    const filtered = list.filter(n => {
      // Preset
      if (f.preset === 'closures') {
        if (!isClosureNotam(n)) return false;
      } else if (f.preset === 'next24h') {
        const st = notamTimeStatus(n, nowMs);
        if (!st) return false;
        if (st.kind === 'expired' || st.kind === 'future' || st.kind === 'perm') return false;
        // Activo y termina antes de 24h => urgent o soon (cuando <3d).
        // Para "proximas 24h" exigimos termina en <24h.
        const toMs = Date.parse(n.toDate || n.endValidity || '');
        if (Number.isNaN(toMs)) return false;
        if (toMs - nowMs > DAY) return false;
      } else if (f.preset === 'perm') {
        const perm = !!n._isPermanent || /PERM/i.test(String(n.toDate || n.endValidity || ''));
        if (!perm) return false;
      } else if (f.preset === 'active-now') {
        const st = notamTimeStatus(n, nowMs);
        if (!st) return false;
        if (st.kind === 'expired' || st.kind === 'future') return false;
      }
      // Categoria
      if (f.category) {
        if (classifyNotam(n).id !== f.category) return false;
      }
      return true;
    });
    // Sort
    const tMs = n => Date.parse(n.fromDate || n.startValidity || '') || 0;
    if (f.sort === 'time-asc') {
      filtered.sort((a, b) => tMs(a) - tMs(b));
    } else if (f.sort === 'cat') {
      filtered.sort((a, b) => {
        const ca = classifyNotam(a).id, cb = classifyNotam(b).id;
        if (ca !== cb) return ca.localeCompare(cb);
        return tMs(b) - tMs(a);
      });
    } else {
      // default time-desc, pero cierres siempre arriba
      filtered.sort((a, b) => {
        const ca = isClosureNotam(a) ? 0 : 1, cb = isClosureNotam(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return tMs(b) - tMs(a);
      });
    }
    return filtered;
  }

  // Cuenta NOTAMs por preset, para mostrar el numero en cada chip.
  function countPresets(list, nowMs) {
    nowMs = nowMs || Date.now();
    const DAY = 24 * 3600 * 1000;
    let closures = 0, next24h = 0, perm = 0, activeNow = 0;
    for (const n of list) {
      if (isClosureNotam(n)) closures++;
      const isPerm = !!n._isPermanent || /PERM/i.test(String(n.toDate || n.endValidity || ''));
      if (isPerm) perm++;
      const st = notamTimeStatus(n, nowMs);
      if (st && st.kind !== 'expired' && st.kind !== 'future') {
        activeNow++;
        if (!isPerm) {
          const toMs = Date.parse(n.toDate || n.endValidity || '');
          if (!Number.isNaN(toMs) && toMs - nowMs <= DAY) next24h++;
        }
      }
    }
    return { total: list.length, closures, next24h, perm, activeNow };
  }

  function renderNotamFilterBar(counts) {
    const f = _state.filter;
    const chip = (preset, label, count, extra) => {
      const active = f.preset === preset ? ' is-active' : '';
      const cls = 'notam-chip-btn' + active + (extra ? ' ' + extra : '');
      return `<button type="button" class="${cls}" data-notam-filter-preset="${preset}">${escapeHTML(label)}<span class="notam-chip-count">${count}</span></button>`;
    };
    const catOpts = ['<option value="">— Todas las categorías —</option>']
      .concat(NOTAM_FILTER_CATEGORIES.map(c =>
        `<option value="${c.id}"${f.category === c.id ? ' selected' : ''}>${escapeHTML(c.label)}</option>`
      )).join('');
    const sortOpts = [
      ['time-desc', 'Más reciente primero'],
      ['time-asc',  'Más antiguo primero'],
      ['cat',       'Agrupar por categoría'],
    ].map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('');
    return `
      <div class="notam-filter-bar">
        <div class="notam-filter-group notam-filter-chips">
          ${chip('all',        'Todos',        counts.total)}
          ${chip('closures',   'Cierres',      counts.closures,   'notam-chip-btn-red')}
          ${chip('active-now', 'Activos',      counts.activeNow,  'notam-chip-btn-green')}
          ${chip('next24h',    'Termina <24h', counts.next24h,    'notam-chip-btn-amber')}
          ${chip('perm',       'PERM',         counts.perm,       'notam-chip-btn-grey')}
        </div>
        <div class="notam-filter-group">
          <select class="notam-filter-select" data-notam-filter-cat>${catOpts}</select>
          <select class="notam-filter-select" data-notam-filter-sort>${sortOpts}</select>
        </div>
      </div>`;
  }

  function renderNotamList() {
    const root = $('#notam-results');
    if (!root) return;
    if (_state.error) {
      root.innerHTML = `<div class="notam-empty error">
        <div class="notam-empty-icon">⚠</div>
        <div><b>Error al cargar NOTAMs:</b><br>${escapeHTML(_state.error)}</div>
      </div>`;
      return;
    }
    if (_state.loading) {
      // Skeleton placeholder: simula 1 bucket + 3 cards mientras el
      // fetch va. Da sensacion de progreso en los 3-4 s de NotamHub.
      const skelCard = `
        <div class="skel-card" aria-hidden="true">
          <div class="skel-card-head">
            <span class="skel-bar skel-bar-id"></span>
            <span class="skel-bar skel-bar-chip"></span>
            <span class="skel-bar skel-bar-chip"></span>
            <span class="skel-bar skel-bar-window"></span>
          </div>
          <div class="skel-block"></div>
        </div>`;
      root.innerHTML = `
        <div class="notam-skeleton" role="status" aria-live="polite" aria-busy="true">
          <div class="skel-bucket">
            <div class="skel-bucket-head">
              <span class="skel-bar skel-bar-title"></span>
              <span class="skel-bar skel-bar-badge"></span>
            </div>
            <div class="skel-bucket-body">${skelCard}${skelCard}${skelCard}</div>
          </div>
          <span class="visually-hidden">Cargando NOTAMs y METAR/TAF…</span>
        </div>`;
      return;
    }
    if (!_state.icaos.length) {
      root.innerHTML = `<div class="notam-empty hint">
        <div class="notam-empty-icon">✈</div>
        <div>Introduce uno o varios ICAOs y pulsa <b>Consultar</b>, o usa el botón <b>Origen + destino del plan</b>.</div>
      </div>`;
      return;
    }

    const nowMs = Date.now();
    const counts = countPresets(_state.notams, nowMs);
    const filterBarHtml = renderNotamFilterBar(counts);

    // Agrupados por icaoLocation tras filtrar. Cada bucket aplica el
    // mismo filtro/orden.
    const filtered = applyNotamFilter(_state.notams, nowMs);
    const byIcao = {};
    for (const n of filtered) {
      const k = String(n.icaoLocation || n.location || '?').toUpperCase();
      (byIcao[k] = byIcao[k] || []).push(n);
    }
    const totalShown = filtered.length;

    const renderSection = (icao, list, opts) => {
      const closures = list.filter(isClosureNotam).length;
      const areas    = list.filter(isAreaNotam).length;
      const badges = [
        `<span class="badge">${list.length}</span>`,
        closures ? `<span class="badge badge-red">${closures} cierre${closures > 1 ? 's' : ''}</span>` : '',
        areas    ? `<span class="badge badge-amber">${areas} área${areas > 1 ? 's' : ''}</span>` : '',
      ].filter(Boolean).join(' ');
      const isFirSection = !!(opts && opts.firLabel);
      const icaoLabel = isFirSection
        ? `<span class="notam-bucket-prefix">FIR</span>${escapeHTML(icao)}`
        : `<span class="notam-bucket-prefix">AD</span>${escapeHTML(icao)}`;
      return `
        <section class="notam-bucket ${isFirSection ? 'notam-bucket-fir' : ''}">
          <header class="notam-bucket-head">
            <h3>${icaoLabel}</h3>
            <div class="notam-bucket-badges">${badges}</div>
          </header>
          <div class="notam-bucket-body">
            ${list.length ? list.map(renderNotamCard).join('') : '<div class="notam-empty notam-empty-mini">Sin NOTAMs con este filtro</div>'}
          </div>
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

    const empty = totalShown === 0
      ? `<div class="notam-empty hint">
           <div class="notam-empty-icon">🔍</div>
           <div>Ningún NOTAM coincide con el filtro actual. Pulsa <b>Todos</b> para verlos.</div>
         </div>`
      : '';

    root.innerHTML = filterBarHtml + empty + adSections + firSections;
  }

  // Delegacion: clicks/cambios sobre la barra de filtros re-renderizan
  // sin volver a pedir datos al backend.
  function wireNotamFilterDelegation() {
    const root = $('#notam-results');
    if (!root || root._notamFilterWired) return;
    root._notamFilterWired = true;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-notam-filter-preset]');
      if (!btn) return;
      e.preventDefault();
      _state.filter.preset = btn.dataset.notamFilterPreset;
      renderNotamList();
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('[data-notam-filter-cat]')) {
        _state.filter.category = t.value || '';
        renderNotamList();
      } else if (t && t.matches && t.matches('[data-notam-filter-sort]')) {
        _state.filter.sort = t.value;
        renderNotamList();
      }
    });
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
    const nh   = window.TSAgestor && window.TSAgestor.notamHub;
    if (!nh || !nh.fetchAllNotamsFor) {
      _state.error = 'notamHub no disponible';
      render(); return;
    }
    _state.icaos = icaoList.slice();
    _state.firs  = [];                  // ya no consultamos FIRs aqui
    _state.depTimeMs = getDepartureMs();
    _state.loading = true;
    _state.error = null;
    _state.notams = [];
    _state.metars = {};
    _state.tafs = {};
    render();
    setStatus(`Consultando NOTAMs de aeródromo (${icaoList.length}) en NotamHub y METAR/TAF…`, 'loading');

    // Solo NotamHub (los NOTAMs de aerodromo nacionales) + AWC METAR/TAF
    // en paralelo. Autorouter queda fuera de esta pestanya: aqui solo
    // queremos NOTAMs nacionales del aerodromo seleccionado.
    const notamPromise = nh.fetchAllNotamsFor(icaoList).catch(e => {
      console.warn('[notam] NotamHub fetch error:', e); return { __error: e };
    });
    const metarPromise = mapi && mapi.fetchMETAR
      ? mapi.fetchMETAR(icaoList).catch(e => { console.warn('[metar] fetch error:', e); return {}; })
      : Promise.resolve({});
    const tafPromise = mapi && mapi.fetchTAF
      ? mapi.fetchTAF(icaoList).catch(e => { console.warn('[taf] fetch error:', e); return {}; })
      : Promise.resolve({});

    const [notamRes, metarRes, tafRes] = await Promise.all([
      notamPromise, metarPromise, tafPromise,
    ]);

    _state.metars = normalizeReports(metarRes);
    _state.tafs   = normalizeReports(tafRes);

    if (notamRes && notamRes.__error) {
      // notamRes.__error puede ser un Error, un string, o cualquier
      // cosa que el catch del fetch capturase. Optional chaining +
      // String() para no crashear ante valores raros.
      const errMsg = (notamRes.__error && notamRes.__error.message)
        || notamRes.__error
        || 'desconocido';
      _state.error = 'NotamHub: ' + String(errMsg);
      _state.notams = [];
    } else {
      // Dedup defensivo por notamId por si NotamHub repite alguno entre
      // las consultas aerodromo+FIR (improbable pero seguro).
      const byId = new Map();
      let droppedAreas = 0;
      for (const n of (Array.isArray(notamRes) ? notamRes : [])) {
        const id = String(n.notamId || '').trim();
        if (!id) continue;
        // Omitir NOTAMs de area (areas segregadas, TSAs, corredores,
        // ejercicios militares). Orden de chequeos:
        //   1) Body habla de TSAs/corredores/AREAS SEGREGADAS ->
        //      DESCARTAR aunque el section diga AERODROMOS. Esto es
        //      lo que filtra D3006/D2473 en LEBZ: section dice
        //      WARNINGS_AERODROMOS pero el cuerpo es TSA TALAVERA.
        //   2) section dice AREAS / TSA / ESPACIO AEREO -> descartar.
        //   3) section dice AERODROMOS y no hay matches de #1 ->
        //      conservar (deja pasar warnings reales de aerodromo).
        //   4) Sin section claro, heuristico por serie ICAO y Q-code.
        if (isAreaByBody(n)) {
          droppedAreas++; continue;
        }
        if (isAerodromeSection(n._section)) {
          // Pass-through: NOTAM marcado como aerodromo por el API y
          // cuyo body no menciona TSAs/corredores.
        } else if (isAreaSection(n._section) || isAreaByIdOrQcode(n)) {
          droppedAreas++; continue;
        }
        if (!byId.has(id)) byId.set(id, n);
      }
      _state.notams = Array.from(byId.values());
      if (droppedAreas > 0) {
        console.info(`[notam] omitidos ${droppedAreas} NOTAMs de apartados de area/segregadas`);
      }
    }

    _state.loading = false;
    setStatus(
      `${_state.notams.length} NOTAMs (fuente: NotamHub) · ` +
      `${Object.keys(_state.metars).length} METAR · ${Object.keys(_state.tafs).length} TAF` +
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
    wireNotamFilterDelegation();
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
