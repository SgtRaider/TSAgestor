// Decodificador de METAR y TAF a texto legible en español. Cubre los
// elementos comunes (estación, hora, viento, visibilidad, fenómenos
// meteorológicos, capas de nubes, temperatura, QNH, tendencias y grupos
// de cambio TAF). Tokens desconocidos se ignoran silenciosamente.
//
// API:
//   decodeMETAR(raw) → [{label, value}, ...]
//   decodeTAF(raw)   → [{label, value, level?}, ...]
// donde level marca si es subgrupo (TEMPO/BECMG/FM/PROBxx).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.metarDecode = (function () {
  'use strict';

  const WX_INTENSITY = { '-': 'débil', '+': 'fuerte', 'VC': 'en proximidad' };

  const WX_DESCRIPTOR = {
    MI: 'baja', PR: 'parcial', BC: 'bancos de', DR: 'rastrera',
    BL: 'soplada por viento', SH: 'chubascos de', TS: 'tormenta con',
    FZ: 'engelante',
  };

  const WX_PHENOMENA = {
    DZ: 'llovizna', RA: 'lluvia', SN: 'nieve', SG: 'cinarra',
    IC: 'cristales de hielo', PL: 'hielo granulado', GR: 'granizo',
    GS: 'granizo pequeño', UP: 'precipitación desconocida',
    BR: 'neblina', FG: 'niebla', FU: 'humo', VA: 'cenizas volcánicas',
    DU: 'polvo extendido', SA: 'arena', HZ: 'calima', PY: 'rocío marino',
    PO: 'remolinos de polvo', SQ: 'turbonadas', FC: 'tornado / manga marina',
    SS: 'tormenta de arena', DS: 'tormenta de polvo',
  };

  const CLOUD_AMOUNT = {
    FEW: 'pocas nubes',     SCT: 'nubes dispersas',
    BKN: 'nubes fragmentadas', OVC: 'cielo cubierto',
    NSC: 'sin nubes significativas', NCD: 'sin nubes detectadas',
    SKC: 'cielo despejado', CLR: 'cielo despejado',
    NSW: 'sin meteo significativa',
  };

  // ── Helpers de parseo de tokens individuales ──────────────────────

  function parseStationICAO(tok) {
    return /^[A-Z]{4}$/.test(tok) ? tok : null;
  }

  function parseTime(tok) {
    const m = tok.match(/^(\d{2})(\d{2})(\d{2})Z$/);
    return m ? `día ${m[1]} a las ${m[2]}:${m[3]} UTC` : null;
  }

  function parseWind(tok) {
    const m = tok.match(/^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/);
    if (!m) return null;
    const speed = parseInt(m[2], 10);
    if (m[1] === '000' && speed === 0) return 'calma';
    const unit = m[4] === 'KT' ? 'kt' : (m[4] === 'MPS' ? 'm/s' : 'km/h');
    const dir = m[1] === 'VRB' ? 'variable' : `del ${parseInt(m[1], 10)}°`;
    let s = `${dir} a ${speed} ${unit}`;
    if (m[3]) s += ` (rachas ${parseInt(m[3], 10)} ${unit})`;
    return s;
  }

  function parseWindVar(tok) {
    const m = tok.match(/^(\d{3})V(\d{3})$/);
    return m ? `entre ${parseInt(m[1], 10)}° y ${parseInt(m[2], 10)}°` : null;
  }

  function parseVisibility(tok) {
    if (tok === '9999') return '≥ 10 km';
    if (/^\d{4}$/.test(tok)) {
      const v = parseInt(tok, 10);
      return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} km` : `${v} m`;
    }
    const m = tok.match(/^(\d{4})([NSEW]{1,2})$/);
    if (m) return `${parseInt(m[1], 10)} m hacia el ${m[2]}`;
    // SM US (e.g. 5SM, 1 1/2SM)
    const sm = tok.match(/^(\d+)SM$/);
    if (sm) return `${parseInt(sm[1], 10) * 1.609} km`;
    return null;
  }

  function parseRVR(tok) {
    return /^R\d{2}[LCR]?\/\S+$/.test(tok);  // skip but recognize
  }

  function parseWeather(tok) {
    if (tok.length < 2 || tok.length > 8) return null;
    let s = tok;
    let intensity = '';
    if (s[0] === '-' || s[0] === '+') {
      intensity = WX_INTENSITY[s[0]] + ' ';
      s = s.slice(1);
    } else if (s.startsWith('VC')) {
      intensity = WX_INTENSITY.VC + ' ';
      s = s.slice(2);
    }
    let descriptor = '';
    if (s.length >= 2 && WX_DESCRIPTOR[s.slice(0, 2)]) {
      descriptor = WX_DESCRIPTOR[s.slice(0, 2)] + ' ';
      s = s.slice(2);
    }
    const phen = [];
    while (s.length >= 2) {
      const p = s.slice(0, 2);
      if (WX_PHENOMENA[p]) {
        phen.push(WX_PHENOMENA[p]);
        s = s.slice(2);
      } else break;
    }
    if (s.length > 0) return null;
    if (!phen.length && !descriptor) return null;
    return (intensity + descriptor + phen.join(' y ')).trim();
  }

  function parseClouds(tok) {
    if (CLOUD_AMOUNT[tok]) return CLOUD_AMOUNT[tok];
    let m = tok.match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
    if (m) {
      const amount = CLOUD_AMOUNT[m[1]];
      const hundreds = parseInt(m[2], 10);
      const ft = hundreds * 100;
      const fl = hundreds >= 100 ? `FL${m[2]}` : null;
      const type = m[3] === 'CB'
        ? ' tipo cumulonimbo'
        : (m[3] === 'TCU' ? ' tipo cúmulo en torre' : '');
      const heightStr = fl
        ? `${fl} (${ft.toLocaleString('es-ES')} ft)`
        : `${ft.toLocaleString('es-ES')} ft`;
      return `${amount} a ${heightStr}${type}`;
    }
    m = tok.match(/^VV(\d{3})$/);
    if (m) return `visibilidad vertical ${parseInt(m[1], 10) * 100} ft`;
    return null;
  }

  function parseTempDew(tok) {
    const m = tok.match(/^(M?)(\d{2})\/(M?)(\d{2})$/);
    if (!m) return null;
    const t = (m[1] === 'M' ? -1 : 1) * parseInt(m[2], 10);
    const d = (m[3] === 'M' ? -1 : 1) * parseInt(m[4], 10);
    return `${t}°C / punto rocío ${d}°C`;
  }

  function parseQNH(tok) {
    let m = tok.match(/^Q(\d{4})$/);
    if (m) return `${parseInt(m[1], 10)} hPa`;
    m = tok.match(/^A(\d{4})$/);
    if (m) {
      const inhg = parseInt(m[1], 10) / 100;
      const hpa = inhg * 33.8639;
      return `${inhg.toFixed(2)} inHg (${hpa.toFixed(0)} hPa)`;
    }
    return null;
  }

  function parsePeriod(tok) {
    const m = tok.match(/^(\d{2})(\d{2})\/(\d{2})(\d{2})$/);
    return m ? `día ${m[1]} ${m[2]}:00 UTC → día ${m[3]} ${m[4]}:00 UTC` : null;
  }

  // ── Decodificador METAR ────────────────────────────────────────────

  function decodeMETAR(raw) {
    if (!raw) return [];
    const txt = raw.trim().replace(/=+\s*$/, '').replace(/\s+/g, ' ');
    const tokens = txt.split(' ');
    const lines = [];
    let stationFound = false;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      if (tok === 'METAR' || tok === 'SPECI') continue;
      if (tok === 'COR')  { lines.push({ label: 'Tipo', value: 'corregido' }); continue; }
      if (tok === 'AUTO') { lines.push({ label: 'Tipo', value: 'observación automática' }); continue; }
      if (tok === 'NIL')  { lines.push({ label: 'Estado', value: 'sin observación disponible' }); continue; }

      if (tok === 'RMK') {
        const rest = tokens.slice(i + 1).join(' ').trim();
        if (rest) lines.push({ label: 'Observaciones', value: rest });
        break;
      }

      if (!stationFound) {
        const st = parseStationICAO(tok);
        if (st) { lines.push({ label: 'Estación', value: st }); stationFound = true; continue; }
      }

      const t = parseTime(tok);
      if (t) { lines.push({ label: 'Hora', value: t }); continue; }

      const w = parseWind(tok);
      if (w) { lines.push({ label: 'Viento', value: w }); continue; }

      const wv = parseWindVar(tok);
      if (wv) { lines.push({ label: 'Variación dir.', value: wv }); continue; }

      const v = parseVisibility(tok);
      if (v) { lines.push({ label: 'Visibilidad', value: v }); continue; }

      if (tok === 'CAVOK') {
        lines.push({ label: 'CAVOK', value: 'visibilidad ≥10 km, sin nubes ni meteo adversa' });
        continue;
      }

      if (parseRVR(tok)) continue; // RVR omitido

      const wx = parseWeather(tok);
      if (wx) { lines.push({ label: 'Meteo', value: wx }); continue; }

      const cl = parseClouds(tok);
      if (cl) { lines.push({ label: 'Nubes', value: cl }); continue; }

      const td = parseTempDew(tok);
      if (td) { lines.push({ label: 'T / Td', value: td }); continue; }

      const q = parseQNH(tok);
      if (q) { lines.push({ label: 'QNH', value: q }); continue; }

      if (tok === 'NOSIG') {
        lines.push({ label: 'Tendencia', value: 'sin cambios significativos las próximas 2h' });
        continue;
      }

      // Grupos de cambio en METAR (BECMG/TEMPO al final tras el cuerpo).
      if (tok === 'BECMG' || tok === 'TEMPO') {
        const trendType = tok === 'BECMG' ? 'cambio gradual' : 'temporalmente';
        lines.push({ label: 'Tendencia', value: trendType, level: 1 });
        continue;
      }

      // Token no reconocido → ignorar silenciosamente.
    }
    return lines;
  }

  // ── Decodificador TAF ──────────────────────────────────────────────

  function decodeTAF(raw) {
    if (!raw) return [];
    const txt = raw.trim().replace(/=+\s*$/, '').replace(/\s+/g, ' ');
    // Divide en grupos por palabras-marca de cambio.
    const groups = txt.split(/\s+(?=BECMG\b|TEMPO\b|FM\d{6}\b|PROB\d{2}\b)/);
    const out = [];
    for (let g = 0; g < groups.length; g++) {
      decodeTAFGroup(groups[g], g === 0, out);
    }
    return out;
  }

  function decodeTAFGroup(group, isFirst, out) {
    const tokens = group.split(' ');
    let i = 0;
    let level = isFirst ? 0 : 1;

    if (isFirst) {
      if (tokens[i] === 'TAF') i++;
      if (tokens[i] === 'COR' || tokens[i] === 'AMD') {
        out.push({ label: 'Tipo', value: tokens[i] === 'COR' ? 'corregido' : 'enmendado' });
        i++;
      }
      if (parseStationICAO(tokens[i])) {
        out.push({ label: 'Estación', value: tokens[i] });
        i++;
      }
      const issue = tokens[i] && parseTime(tokens[i]);
      if (issue) { out.push({ label: 'Emitido', value: issue }); i++; }
      const period = tokens[i] && parsePeriod(tokens[i]);
      if (period) { out.push({ label: 'Validez', value: period }); i++; }
    } else {
      // Grupo de cambio: BECMG / TEMPO / FMddhhmm / PROBxx [TEMPO] [period]
      const head = tokens[i++];
      let label = '↳ ';
      if (head === 'BECMG')      label += 'Cambio gradual';
      else if (head === 'TEMPO') label += 'Temporalmente';
      else if (/^FM\d{6}$/.test(head)) {
        const m = head.match(/^FM(\d{2})(\d{2})(\d{2})$/);
        label += `Desde día ${m[1]} ${m[2]}:${m[3]} UTC`;
      } else if (/^PROB\d{2}$/.test(head)) {
        const prob = head.slice(4);
        label += `Probabilidad ${prob}%`;
        if (tokens[i] === 'TEMPO' || tokens[i] === 'BECMG') {
          label += ' ' + tokens[i++].toLowerCase();
        }
      } else {
        label += head;
      }
      // Periodo opcional
      if (i < tokens.length && /^\d{4}\/\d{4}$/.test(tokens[i])) {
        label += ` · ${parsePeriod(tokens[i])}`;
        i++;
      } else if (i < tokens.length && /^\d{6}$/.test(tokens[i])) {
        // FM puede llevar timestamp ya en cabecera, no aquí; ignorar.
      }
      out.push({ label, value: '', level });
    }

    // Cuerpo: viento, visibilidad, weather, nubes
    for (; i < tokens.length; i++) {
      const tok = tokens[i];
      const sub = '   ';
      const w = parseWind(tok);
      if (w) { out.push({ label: sub + 'Viento', value: w, level: level + 1 }); continue; }
      const wv = parseWindVar(tok);
      if (wv) { out.push({ label: sub + 'Variación dir.', value: wv, level: level + 1 }); continue; }
      const v = parseVisibility(tok);
      if (v) { out.push({ label: sub + 'Visibilidad', value: v, level: level + 1 }); continue; }
      if (tok === 'CAVOK') {
        out.push({ label: sub + 'CAVOK', value: 'visibilidad ≥10 km, sin nubes ni meteo adversa', level: level + 1 });
        continue;
      }
      const wx = parseWeather(tok);
      if (wx) { out.push({ label: sub + 'Meteo', value: wx, level: level + 1 }); continue; }
      const cl = parseClouds(tok);
      if (cl) { out.push({ label: sub + 'Nubes', value: cl, level: level + 1 }); continue; }
    }
  }

  // ── HTML helper para popups y cards ────────────────────────────────

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toHtmlList(decodedLines) {
    if (!decodedLines || !decodedLines.length) return '<i class="meteo-decoded-empty">— sin datos para decodificar —</i>';
    return '<ul class="meteo-decoded">' + decodedLines.map(d => {
      const cls = d.level ? ' class="lvl-' + d.level + '"' : '';
      return `<li${cls}><span class="lbl">${escapeHTML(d.label)}:</span> ${escapeHTML(d.value)}</li>`;
    }).join('') + '</ul>';
  }

  return { decodeMETAR, decodeTAF, toHtmlList };
})();
