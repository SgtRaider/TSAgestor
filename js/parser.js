// Parser de NOTAM: extrae texto de PDF y produce TSAs estructuradas.
// Soporta formato AIP-España y NOTAM ICAO estándar (detección automática).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.parser = (function () {
  'use strict';

  const geom = window.TSAgestor.geom;

  const PDF_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const MONTHS = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    // Alias en español (MAR, MAY, JUN, JUL, SEP, OCT, NOV coinciden con los ingleses)
    ENE: 0, ABR: 3, AGO: 7, DIC: 11,
  };

  // ── PDF text extraction ──────────────────────────────────────────────

  async function extractTextFromPDF(arrayBuffer) {
    const lib = window.pdfjsLib;
    if (!lib) throw new Error('PDF.js no está disponible. Comprueba la conexión a internet.');
    lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;

    const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Agrupar items por coordenada Y (tolerancia) para reconstruir líneas.
      const rows = new Map();
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const y = Math.round(item.transform[5]);
        let key = null;
        for (const k of rows.keys()) { if (Math.abs(k - y) <= 4) { key = k; break; } }
        if (key === null) { key = y; rows.set(key, []); }
        rows.get(key).push(item);
      }
      const ys = [...rows.keys()].sort((a, b) => b - a);
      const lines = ys.map(y =>
        rows.get(y)
          .sort((a, b) => a.transform[4] - b.transform[4])
          .map(i => i.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      );
      pages.push(lines.join('\n'));
    }
    let out = pages.join('\n\n');
    // Post-proceso: PDF.js junta items en una linea con un espacio entre
    // ellos. Eso parte tokens "tight" en piezas: "(16)" -> "(1 6 )",
    // "0070136W" -> "0 070136 W", "FL350" -> "FL 3 50", etc. Normalizamos:
    //   - parens con digitos sueltos y espacios:  "( 1 6 )" -> "(16)"
    //   - FL con espacios:                         "FL 3 50" -> "FL350"
    //   - coordenadas lat/lon con digitos partidos:
    //     "390950 N 00 70136 W" -> "390950N 0070136W"
    out = out
      .replace(/\(\s*(\d[\d\s]*)\)/g, (m, p) => '(' + p.replace(/\s/g, '') + ')')
      // FL con espacios. Limitamos a 2-3 digitos totales para no glomerar
      // el numero de seccion siguiente (p.ej. "FL 165 4. FECHAS" no debe
      // colapsar a "FL1654."). Permitimos un espacio opcional entre digitos.
      .replace(/\bFL\s*(\d(?:\s?\d){1,2})(?!\s?\d)/g, (m, p) => 'FL' + p.replace(/\s/g, ''))
      .replace(/(\d[\d\s]{4,7}\d)\s*([NS])\s+(\d[\d\s]{5,8}\d)\s*([EW])/g,
        (m, lat, h1, lon, h2) => lat.replace(/\s/g, '') + h1 + ' ' + lon.replace(/\s/g, '') + h2);
    return out;
  }

  // ── Coordinate / altitude helpers ────────────────────────────────────

  // "414530N" → 41.7583  |  "0033045W" → -3.5125
  function parseLat(s) {
    const m = s.match(/^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])$/i);
    if (!m) return null;
    const v = +m[1] + (+m[2]) / 60 + (+m[3]) / 3600;
    return m[4].toUpperCase() === 'S' ? -v : v;
  }
  function parseLon(s) {
    const m = s.match(/^(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])$/i);
    if (!m) return null;
    const v = +m[1] + (+m[2]) / 60 + (+m[3]) / 3600;
    return m[4].toUpperCase() === 'W' ? -v : v;
  }

  // Busca pares (DDMMSS[.d]N DDDMMSS[.d]E/W) en un bloque de texto.
  function parseCoordinates(text) {
    const coords = [];
    const re = /(\d{6}(?:\.\d+)?[NS])\s+(\d{7}(?:\.\d+)?[EW])/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const lat = parseLat(m[1]);
      const lon = parseLon(m[2]);
      if (lat !== null && lon !== null) coords.push([lat, lon]);
    }
    return coords;
  }

  // "FL150" | "1500FT" | "GND" | "SFC" | "UNL" | "3500 FT AGL" | "500M AMSL" → pies
  function parseAltitudeToken(str) {
    if (!str) return { ft: 0, label: '?' };
    const s = str.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!s) return { ft: 0, label: '?' };
    if (/^(GND|SFC|MSL)$/.test(s)) return { ft: 0, label: 'GND' };
    if (/^UNL(IMITED)?$/.test(s)) return { ft: 99999, label: 'UNL' };
    // FL245 | FL 245 | FL0245 (con sufijo opcional)
    const fl = s.match(/^FL\s*0*(\d+)(?:\s+[A-Z]+)?$/);
    if (fl) return { ft: +fl[1] * 100, label: `FL${fl[1]}` };
    // 5000FT | 5000 FT | 5000FT AMSL/AGL/MSL | 1,500FT
    const ft = s.match(/^(\d[\d,.]*)\s*FT(?:\s+(AMSL|AGL|MSL|ASFC))?$/);
    if (ft) {
      const num = parseFloat(ft[1].replace(/,/g, ''));
      const ref = ft[2] ? ' ' + ft[2] : '';
      return { ft: Math.round(num), label: `${Math.round(num)}FT${ref}` };
    }
    // 500M | 500 M | 500M AGL
    const mt = s.match(/^(\d+(?:[.,]\d+)?)\s*M(?:\s+(AMSL|AGL|MSL))?$/);
    if (mt) {
      const num = parseFloat(mt[1].replace(',', '.'));
      const ref = mt[2] ? ' ' + mt[2] : '';
      return { ft: Math.round(num * 3.28084), label: `${num}M${ref}` };
    }
    // Sólo número (ambiguo): tratar como pies
    const raw = s.match(/^(\d+)$/);
    if (raw) return { ft: +raw[1], label: `${raw[1]}FT` };
    return { ft: 0, label: '?' };
  }

  // Parsea formato "<inf>/<sup>" — el más habitual.
  // Itera línea a línea: la primera línea que contenga un único "/" entre dos
  // tokens reconocibles de altitud es la respuesta. Antes se colapsaba todo
  // a una línea con un único espacio, lo que confundía el "/" de la altitud
  // con el "/" de cosas como "APP/TWR" dentro de los RMK.
  function parseSlashAlt(text) {
    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.indexOf('/') < 0) continue;
      // Restringimos al primer "/" de la línea: parte izquierda y derecha.
      const slashIdx = line.indexOf('/');
      const leftRaw  = line.slice(0, slashIdx).trim();
      const rightRaw = line.slice(slashIdx + 1).trim()
                            // recorta basura típica al final ("(observaciones…)" o "RMK:…")
                            .replace(/\s+RMK:.*$/i, '')
                            .replace(/\s*\(.*$/, '')
                            .trim();
      const lo = parseAltitudeToken(leftRaw);
      const hi = parseAltitudeToken(rightRaw);
      if (lo.label !== '?' && hi.label !== '?') {
        return { lowerFt: lo.ft, lowerLabel: lo.label, upperFt: hi.ft, upperLabel: hi.label };
      }
    }
    return null;
  }

  // Parsea formato "INF: <x> SUP: <y>" usado en cabeceras AENA.
  // En este formato los valores numéricos sin sufijo SON niveles de vuelo
  // (p.ej. "INF: 0  SUP: 350" → GND a FL350).
  function parseINFSUP(text) {
    const m = text.match(/\bINF\b\s*[:.]?\s*([A-Z0-9]+)\s+\bSUP\b\s*[:.]?\s*([A-Z0-9]+)/i);
    if (!m) return null;
    function toFL(s) {
      const up = s.toUpperCase();
      if (/^(GND|SFC|MSL|0)$/.test(up)) return { ft: 0, label: 'GND' };
      if (/^UNL/.test(up)) return { ft: 99999, label: 'UNL' };
      if (/^\d+$/.test(up)) return { ft: +up * 100, label: `FL${+up}` };
      return parseAltitudeToken(s);
    }
    const lo = toFL(m[1]);
    const hi = toFL(m[2]);
    if (lo.label === '?' || hi.label === '?') return null;
    return { lowerFt: lo.ft, lowerLabel: lo.label, upperFt: hi.ft, upperLabel: hi.label };
  }

  // Parsea "Inferior: X  Superior: Y" o "Lower: X Upper: Y"
  function parseInfSupWords(text) {
    const m = text.match(/(?:INFERIOR|LOWER|LIM\.?\s*INF\.?)\s*[:.]?\s*([A-Z0-9]+(?:\s*FT|\s*M)?(?:\s+(?:AMSL|AGL|MSL))?).*?(?:SUPERIOR|UPPER|LIM\.?\s*SUP\.?)\s*[:.]?\s*([A-Z0-9]+(?:\s*FT|\s*M)?(?:\s+(?:AMSL|AGL|MSL))?)/i);
    if (!m) return null;
    const lo = parseAltitudeToken(m[1]);
    const hi = parseAltitudeToken(m[2]);
    if (lo.label === '?' || hi.label === '?') return null;
    return { lowerFt: lo.ft, lowerLabel: lo.label, upperFt: hi.ft, upperLabel: hi.label };
  }

  function parseVerticalBlock(text) {
    return parseSlashAlt(text)
        || parseINFSUP(text)
        || parseInfSupWords(text)
        || { lowerFt: 0, lowerLabel: '?', upperFt: 0, upperLabel: '?' };
  }

  // ── Schedule helpers ─────────────────────────────────────────────────

  function hhmmToMinutes(hhmm) {
    const m = hhmm.match(/^(\d{2}):?(\d{2})$/);
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }

  function makeUTC(year, month, day, hhmm) {
    const mm = hhmmToMinutes(hhmm);
    if (mm === null) return null;
    return new Date(Date.UTC(year, month, day, Math.floor(mm / 60), mm % 60));
  }

  // Parseo de horarios AIP: admite día único, rango de días y lista de días.
  //   "APR 27 HR 1830-2359"
  //   "APR 01-30 HR 0000-2359"          → genera una ventana por cada día
  //   "APR 21,22,25 HR 0800-1800"       → genera una ventana por cada día
  function parseAIPSchedules(text, defaultYear) {
    const out = [];
    const consumed = []; // pares [inicio,fin) de matches ya cubiertos por los patrones complejos

    function pushWindow(year, month, day, hhmm1, hhmm2, raw) {
      const s = makeUTC(year, month, day, hhmm1);
      let e = makeUTC(year, month, day, hhmm2);
      if (!s || !e) return;
      if (e <= s) e = new Date(e.getTime() + 24 * 3600 * 1000);
      out.push({ startUTC: s, endUTC: e, raw });
    }

    function consume(m) { consumed.push([m.index, m.index + m[0].length]); }
    function isConsumed(idx) { return consumed.some(([a, b]) => idx >= a && idx < b); }

    // 1. Rango: "MMM DD-DD HR HHMM-HHMM" (admite guion normal o en-dash)
    const reRange = /\b([A-Z]{3})\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\s+HR\s+(\d{4})\s*-\s*(\d{4})\b/gi;
    let m;
    while ((m = reRange.exec(text)) !== null) {
      const mo = MONTHS[m[1].toUpperCase()];
      if (mo === undefined) continue;
      const lo = Math.min(+m[2], +m[3]);
      const hi = Math.max(+m[2], +m[3]);
      for (let d = lo; d <= hi; d++) pushWindow(defaultYear, mo, d, m[4], m[5], m[0]);
      consume(m);
    }

    // 2. Lista: "MMM D1,D2,D3[...] HR HHMM-HHMM"
    const reList = /\b([A-Z]{3})\s+(\d{1,2}(?:\s*[,;/]\s*\d{1,2})+)\s+HR\s+(\d{4})\s*-\s*(\d{4})\b/gi;
    while ((m = reList.exec(text)) !== null) {
      const mo = MONTHS[m[1].toUpperCase()];
      if (mo === undefined) continue;
      const days = m[2].split(/\s*[,;/]\s*/).map(Number).filter(n => !Number.isNaN(n));
      for (const d of days) pushWindow(defaultYear, mo, d, m[3], m[4], m[0]);
      consume(m);
    }

    // 3. Mixto separado por espacios: "MMM 07 11-12 HR 1030-1830" o
    //    "MMM 04-08 11-15 18-22 25-29 HR 0600-1830". Cada token entre el
    //    mes y "HR" puede ser dia suelto (DD) o rango (DD-DD).
    const reMixed = /\b([A-Z]{3})\s+((?:\d{1,2}(?:\s*[-–]\s*\d{1,2})?\s+){2,})HR\s+(\d{4})\s*-\s*(\d{4})\b/gi;
    while ((m = reMixed.exec(text)) !== null) {
      if (isConsumed(m.index)) continue;
      const mo = MONTHS[m[1].toUpperCase()];
      if (mo === undefined) continue;
      const tokens = m[2].trim().split(/\s+/);
      const days = [];
      for (const tok of tokens) {
        if (/^\d{1,2}$/.test(tok)) { days.push(+tok); continue; }
        const r = tok.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
        if (r) {
          const a = +r[1], b = +r[2];
          for (let d = Math.min(a,b); d <= Math.max(a,b); d++) days.push(d);
        }
      }
      for (const d of days) pushWindow(defaultYear, mo, d, m[3], m[4], m[0]);
      consume(m);
    }

    // 4. Día único: "MMM DD HR HHMM-HHMM" (saltando los ya consumidos).
    const reSingle = /\b([A-Z]{3})\s+(\d{1,2})\s+HR\s+(\d{4})\s*-\s*(\d{4})\b/gi;
    while ((m = reSingle.exec(text)) !== null) {
      if (isConsumed(m.index)) continue;
      const mo = MONTHS[m[1].toUpperCase()];
      if (mo === undefined) continue;
      pushWindow(defaultYear, mo, +m[2], m[3], m[4], m[0]);
    }
    return out;
  }

  // ── AIP parser ───────────────────────────────────────────────────────

  // Detecta el periodo de actividad del documento (cabecera del NOTAM).
  // Soporta:
  //   "CON PERIODO DE ACTIVIDAD: APR 01 06-10 13-17 20-24 27-30 0600-1830"
  //   "DESDE 01/04/2026 06:00 HASTA 30/04/2026 18:30"  (fallback)
  function parseDocumentLevelSchedules(text, defaultYear) {
    // Multi-línea: capturar hasta la siguiente sección reconocida o doble salto.
    const m = text.match(/CON\s+PERIODO\s+DE\s+ACTIVIDAD\s*:\s*([\s\S]+?)(?=\n\s*(?:L[ÍI]MITES|TSA\b|RMK|FECHAS|AREAS\b|OBSERV|\n)|$)/i);
    if (m) {
      const out = parseMixedDaySpec(m[1].replace(/\s+/g, ' ').trim(), defaultYear);
      if (out.length > 0) return out;
    }
    const m2 = text.match(/DESDE\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s+HASTA\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/i);
    if (m2) {
      const s = new Date(Date.UTC(+m2[3], +m2[2] - 1, +m2[1], +m2[4], +m2[5]));
      const e = new Date(Date.UTC(+m2[8], +m2[7] - 1, +m2[6], +m2[9], +m2[10]));
      return [{ startUTC: s, endUTC: e, raw: m2[0] }];
    }
    return [];
  }

  // Extrae los límites verticales del nivel de documento (cabecera AENA).
  // Sólo busca en el texto ANTES de la primera línea "TSA …".
  function parseDocumentLevelVertical(text) {
    const idx = text.search(/(^|\n)TSA\b/);
    const head = idx >= 0 ? text.slice(0, idx) : text;
    const m = head.match(/L[ÍI]MITES\s+VERTICALES\s*:([^\n]+(?:\n[^\n]*)?)/i);
    if (!m) return null;
    return parseVerticalBlock(m[1]);
  }

  // "APR 01 06-10 13-17 20-24 27-30 0600-1830"
  //   → mes APR, días [1, 6..10, 13..17, 20..24, 27..30], horario 0600-1830
  function parseMixedDaySpec(line, defaultYear) {
    const tokens = line.split(/\s+/);
    if (tokens.length < 3) return [];
    const lastTok = tokens[tokens.length - 1];
    const tm = lastTok.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (!tm) return [];
    const month = MONTHS[tokens[0].toUpperCase()];
    if (month === undefined) return [];
    const days = [];
    for (const tok of tokens.slice(1, -1)) {
      if (/^\d{1,2}$/.test(tok)) { days.push(+tok); continue; }
      const r = tok.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
      if (r) {
        const lo = Math.min(+r[1], +r[2]), hi = Math.max(+r[1], +r[2]);
        for (let d = lo; d <= hi; d++) days.push(d);
        continue;
      }
      for (const p of tok.split(/[,;]/)) if (/^\d{1,2}$/.test(p)) days.push(+p);
    }
    const out = [];
    for (const d of days) {
      const s = makeUTC(defaultYear, month, d, tm[1]);
      let e = makeUTC(defaultYear, month, d, tm[2]);
      if (!s || !e) continue;
      if (e <= s) e = new Date(e.getTime() + 24 * 3600 * 1000);
      out.push({ startUTC: s, endUTC: e, raw: line });
    }
    return out;
  }

  // "CIRCULO DE 08NM DE RADIO CENTRADO EN 385329N 0064917W"
  // (también admite radios decimales con coma: "5,9NM")
  function parseCircleDefinition(text) {
    // Soporta español ("CIRCULO DE 08NM DE RADIO CENTRADO EN") e inglés
    // ("CIRCLE OF 08NM RADIUS CENTRED ON" / "CENTERED ON").
    // Tambien acepta variantes con "el punto" o "the point" intermedios:
    // "centrado en el punto 385329N 0064917W".
    const re = /(?:C[IÍ]RCULO\s+DE|CIRCLE\s+OF)\s+([\d.,]+)\s*NM\s+(?:DE\s+RADIO\s+CENTRADO\s+EN|RADIUS\s+CENT(?:E|RE)D\s+ON)(?:\s+(?:EL\s+PUNTO|THE\s+POINT))?\s+(\d{6}(?:\.\d+)?[NS])\s+(\d{7}(?:\.\d+)?[EW])/i;
    const m = text.match(re);
    if (!m) return null;
    const radiusNM = parseFloat(m[1].replace(',', '.'));
    if (Number.isNaN(radiusNM)) return null;
    const lat = parseLat(m[2]);
    const lon = parseLon(m[3]);
    if (lat === null || lon === null) return null;
    return { center: [lat, lon], radiusKm: radiusNM * 1.852 };
  }

  // Encuentra todos los DESDE/HASTA del documento con su posición.
  // Estos delimitan secciones NOTAM y dan la VALIDEZ contextual de cada TSA.
  function findDesdeHasta(text) {
    const out = [];
    const re = /DESDE\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s+HASTA\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({
        index: m.index,
        validity: {
          start: new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])),
          end:   new Date(Date.UTC(+m[8], +m[7] - 1, +m[6], +m[9], +m[10])),
          raw: m[0],
        },
      });
    }
    return out;
  }

  function lastBefore(entries, pos) {
    let best = null;
    for (const e of entries) {
      if (e.index < pos) best = e; else break;
    }
    return best;
  }

  // Expande "CON PERIODO" dentro de un rango de validez.
  // Soporta varios formatos:
  //   "04 11 18 25 0600-1830"           → días sueltos del rango, una franja
  //   "MAY 09 1900-1910, MAY 10 ..."    → cláusulas separadas por coma
  //   "1300-1900"                       → cada día del rango con esa franja
  //   "TUE 0830-1115"                   → cada martes del rango
  //   "APR-OCT 0700-1800"               → cada día del rango cuyo mes esté en [APR..OCT]
  //   "0000-2359"                       → cada día completo del rango
  function expandPeriod(line, validity) {
    if (!validity) return [];
    const out = [];
    for (const clause of line.split(',').map(s => s.trim()).filter(Boolean)) {
      out.push(...expandPeriodClause(clause, validity));
    }
    return out;
  }

  const DOWS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

  function expandPeriodClause(clause, validity) {
    // 1. Extrae todas las franjas horarias HHMM-HHMM
    const times = [];
    const tre = /\b(\d{4})-(\d{4})\b/g;
    let tm;
    while ((tm = tre.exec(clause)) !== null) times.push([tm[1], tm[2]]);
    if (!times.length) return [];

    // 2. Quita las franjas y clasifica el resto (días, meses, DOW)
    const noTimes = clause.replace(/\b\d{4}-\d{4}\b/g, ' ');
    const days = [], months = [], dows = [];
    for (const tok of noTimes.split(/\s+/).filter(Boolean)) {
      const u = tok.toUpperCase();
      if (/^\d{1,2}$/.test(u)) { days.push(+u); continue; }
      if (/^\d{1,2}[-–]\d{1,2}$/.test(u)) {
        const [a, b] = u.split(/[-–]/).map(Number);
        for (let d = Math.min(a,b); d <= Math.max(a,b); d++) days.push(d);
        continue;
      }
      if (MONTHS[u] !== undefined) { months.push(MONTHS[u]); continue; }
      if (DOWS[u] !== undefined)   { dows.push(DOWS[u]);     continue; }
      const mr = u.match(/^([A-Z]{3})[-–]([A-Z]{3})$/);
      if (mr && MONTHS[mr[1]] !== undefined && MONTHS[mr[2]] !== undefined) {
        let cur = MONTHS[mr[1]], end = MONTHS[mr[2]];
        while (true) { months.push(cur); if (cur === end) break; cur = (cur + 1) % 12; }
      }
      // Tokens desconocidos (SR-SS, EST, etc.) se ignoran
    }

    // 3. Itera por cada día calendario dentro del rango de validez.
    const out = [];
    const startMs = Date.UTC(
      validity.start.getUTCFullYear(),
      validity.start.getUTCMonth(),
      validity.start.getUTCDate()
    );
    const endMs = validity.end.getTime();
    const validStart = validity.start.getTime();
    const validEnd = validity.end.getTime();

    for (let ms = startMs; ms <= endMs; ms += 86400000) {
      const d = new Date(ms);
      const yy = d.getUTCFullYear(), mo = d.getUTCMonth(), dd = d.getUTCDate(), dw = d.getUTCDay();
      if (days.length   && !days.includes(dd))   continue;
      if (months.length && !months.includes(mo)) continue;
      if (dows.length   && !dows.includes(dw))   continue;
      for (const t of times) {
        const s = makeUTC(yy, mo, dd, t[0]);
        let e = makeUTC(yy, mo, dd, t[1]);
        if (!s || !e) continue;
        if (e <= s) e = new Date(e.getTime() + 86400000);
        // Recorta a la validez (NOTAM puede empezar/terminar a media franja)
        if (e.getTime() < validStart || s.getTime() > validEnd) continue;
        out.push({
          startUTC: new Date(Math.max(s.getTime(), validStart)),
          endUTC:   new Date(Math.min(e.getTime(), validEnd)),
          raw: clause,
        });
      }
    }
    return out;
  }

  function parseAIP(rawText, defaultYear) {
    const text = rawText.replace(/\r\n?/g, '\n');

    // Posiciones de las cabeceras TSA. Detectamos "TSA <NOMBRE>" seguido
    // (mediante lookahead) de "LIMITES LATERALES" o "LATERAL LIMITS"
    // (los dos formatos publicados). Eso permite separar TSAs aunque el
    // PDF haya colapsado el bloque entero en una sola linea (caso tipico
    // del boletin de ENAIRE: la extraccion via PDF.js junta todo el
    // contenido de cada pagina sin saltos de linea internos).
    const tsaRe = /\bTSA\s+([A-Z][A-Z0-9 \-/]*?)(?=\s+(?:L[ÍI]MITES\s+LATERALES|LATERAL\s+LIMITS|L[ÍI]MITES\s+VERTICALES|VERTICAL\s+LIMITS)\b)/g;
    const positions = [];
    let tm;
    while ((tm = tsaRe.exec(text)) !== null) {
      const name = ('TSA ' + tm[1]).replace(/\s+/g, ' ').trim();
      positions.push({ start: tm.index, end: 0, name });
    }
    for (let i = 0; i < positions.length; i++) {
      positions[i].end = i + 1 < positions.length ? positions[i+1].start : text.length;
    }
    const isInsideTSA = (pos) => positions.some(t => pos >= t.start && pos < t.end);

    // Índices de TODAS las apariciones de DESDE/HASTA, CON PERIODO,
    // LIMITES VERTICALES en el texto. Las separamos en dos listas:
    //   - "section": entradas FUERA de bloques TSA (encabezado de NOTAM)
    //   - "all":     todas (incluyendo dentro de bloques TSA)
    // Para cada TSA buscamos primero DENTRO de su bloque (el TSA suele
    // traer su propio schedule cuando es de la Seccion 5/areas especiales),
    // y si no hay, caemos al section-level mas cercano anterior.
    const allDesde = findDesdeHasta(text);
    // No filtramos por isInsideTSA: entre dos TSAs puede haber un encabezado
    // de NOTAM diferente que aplica a las TSAs siguientes (caso MERIDA
    // NORTH HIGH: su DESDE esta entre MILIS E y ella). lastBefore se basa
    // en proximidad y da la respuesta correcta.
    const desdeEntries = allDesde;

    // CON PERIODO puede ocupar varias lineas (la captura se corta por
    // formateo del PDF dentro de una franja, ej. "1400-\n2300"). Capturamos
    // hasta una linea en blanco o un header conocido y aplanamos newlines.
    const allPeriod = [];
    const periodRe = /CON\s+PERIODO\s+DE\s+ACTIVIDAD\s*:\s*([\s\S]+?)(?=\n\s*(?:L[ÍI]MITES|VERTICAL\s+LIMITS|TSA\b|RMK\b|FECHAS|DATES|AREAS\b|DESDE\b|OBSERV|REMARKS|\n)|$)/gi;
    let pm;
    while ((pm = periodRe.exec(text)) !== null) {
      // Salto de linea PDF puede partir un rango horario "1400-\n2300" en
      // dos. Re-pegamos los hyphen-newline antes de aplanar a una sola linea
      // para no perder la franja.
      const line = pm[1]
        .replace(/(\d)-\s*\n\s*(\d)/g, '$1-$2')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      allPeriod.push({ index: pm.index, line });
    }
    const periodEntries = allPeriod;

    const allVertical = [];
    const vertRe = /(?:L[ÍI]MITES\s+VERTICALES|VERTICAL\s+LIMITS)\s*:\s*([^\n]+)/gi;
    let vm;
    while ((vm = vertRe.exec(text)) !== null) {
      const v = parseVerticalBlock(vm[1]);
      if (v.lowerLabel !== '?') allVertical.push({ index: vm.index, vertical: v });
    }
    const verticalEntries = allVertical;

    // Devuelve la PRIMERA entrada de la lista cuyo index este dentro de
    // [start, end) (la que aparece justo despues del titulo TSA dentro del
    // bloque). null si no hay.
    function firstInside(entries, start, end) {
      for (const e of entries) {
        if (e.index >= start && e.index < end) return e;
      }
      return null;
    }

    // Detecta si un bloque TSA esta en formato "centrado" / Seccion 5: tras
    // el titulo, la primera linea no vacia es un separador "---". En ese
    // caso el TSA trae DESDE/CON PERIODO/LIMITES VERTICALES inline. En el
    // formato AIP normal (LATERAL LIMITS:/RMK:...), el header de seccion
    // esta FUERA del bloque y un DESDE encontrado dentro del rango es de
    // un NOTAM vecino (ej. MURCIA entre dos TSAs distintas).
    function isCenteredBlock(block) {
      const lines = block.split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        return /^-{3,}$/.test(line);
      }
      return false;
    }

    const tsas = [];
    for (let i = 0; i < positions.length; i++) {
      const block = text.slice(positions[i].start, positions[i].end);
      // El nombre lo capturamos con la regex anterior (grupo 1 + prefijo
      // "TSA"). Es robusto tanto al formato con saltos de linea como al
      // formato colapsado donde firstLine seria el bloque entero.
      const name = positions[i].name;

      const section = (from, to) => {
        const re = new RegExp(from + '\\s*:([\\s\\S]*?)(?=' + to + '|$)', 'i');
        const m = block.match(re);
        return m ? m[1] : '';
      };

      // Las secciones aceptan tanto la versión española como la inglesa.
      const KW_LAT  = '(?:L[ÍI]MITES\\s+LATERALES|LATERAL\\s+LIMITS)';
      const KW_VERT = '(?:L[ÍI]MITES\\s+VERTICALES|VERTICAL\\s+LIMITS)';
      const KW_FECH = '(?:FECHAS\\s+Y\\s+HORARIOS|DATES\\s+AND\\s+TIMES)';
      const lateralRaw  = section(KW_LAT,  KW_VERT);
      const verticalRaw = section(KW_VERT, KW_FECH);
      const schedRaw    = section(KW_FECH, 'RMK\\s*:|OBSERV|REMARKS\\s*:');
      const rmkM        = block.match(/RMK\s*:([\s\S]*?)$/i);

      let polygon = parseCoordinates(lateralRaw);
      if (polygon.length < 3) {
        const circle = parseCircleDefinition(lateralRaw);
        if (circle) polygon = geom.circleToPolygon(circle.center, circle.radiusKm, 48);
      }
      // Fallback: algunos boletines (Seccion 5 / "TEMPO SEGREGATED AREA
      // ACTIVATED WI ...") meten las coordenadas en la descripcion sin una
      // cabecera "LATERAL LIMITS:" formal. En ese formato el bloque del TSA
      // queda delimitado por dos lineas de "---". Acotamos el scan entre el
      // primer y el segundo separador para no invadir secciones vecinas
      // no-TSA (p.ej. TUDELA NA, TUREGANO) que aparecen tras la TSA y
      // comparten coordenadas en el mismo formato.
      if (polygon.length < 3) {
        const sepRe = /\n\s*---\s*(?=\n)/g;
        const seps = [];
        let sm;
        while ((sm = sepRe.exec(block)) !== null) seps.push(sm.index);
        const scanText = seps.length >= 2 ? block.slice(seps[0], seps[1]) : block;
        polygon = parseCoordinates(scanText);
        if (polygon.length < 3) {
          const circle = parseCircleDefinition(scanText);
          if (circle) polygon = geom.circleToPolygon(circle.center, circle.radiusKm, 48);
        }
      }

      // Contexto: solo en formato centrado (Seccion 5) priorizamos lo que
      // hay DENTRO del bloque (caso UCEDA). En formato AIP normal el
      // header de seccion esta fuera y un DESDE encontrado dentro del
      // rango es de un NOTAM vecino que NO pertenece a este TSA.
      const blockStart = positions[i].start;
      const blockEnd   = positions[i].end;
      const useInside = isCenteredBlock(block);
      const sectionDesde    = (useInside && firstInside(allDesde,    blockStart, blockEnd)) || lastBefore(desdeEntries, blockStart);
      const sectionPeriod   = (useInside && firstInside(allPeriod,   blockStart, blockEnd)) || lastBefore(periodEntries, blockStart);
      const sectionVertical = (useInside && firstInside(allVertical, blockStart, blockEnd)) || lastBefore(verticalEntries, blockStart);

      let vertical = parseVerticalBlock(verticalRaw);
      let verticalIsFallback = false;
      if (vertical.lowerLabel === '?') {
        // Fallback: a veces la extracción PDF mete las coordenadas dentro de
        // la sección VERTICAL (columnas mal alineadas). Buscamos cualquier
        // par altitud/altitud en el bloque completo.
        const wholeBlock = parseVerticalBlock(text.slice(positions[i].start, positions[i].end));
        if (wholeBlock.lowerLabel !== '?') vertical = wholeBlock;
      }
      if (vertical.lowerLabel === '?' && sectionVertical) {
        vertical = sectionVertical.vertical;
        verticalIsFallback = true;
      }

      let schedules = parseAIPSchedules(schedRaw, defaultYear);
      if (schedules.length === 0 && sectionPeriod && sectionDesde) {
        schedules = expandPeriod(sectionPeriod.line, sectionDesde.validity);
      }
      if (schedules.length === 0 && sectionDesde) {
        // Sin patrón explícito: una única ventana cubriendo toda la validez.
        schedules = [{
          startUTC: sectionDesde.validity.start,
          endUTC:   sectionDesde.validity.end,
          raw:      sectionDesde.validity.raw,
        }];
      }

      if (polygon.length >= 3 && schedules.length > 0) {
        tsas.push({
          id: `tsa-${tsas.length + 1}`,
          name,
          polygon,
          centroid: geom.centroid(polygon),
          vertical,
          verticalIsFallback,
          schedules,
          format: 'AIP',
          remarks: rmkM ? rmkM[1].trim() : '',
          rawBlock: block.slice(0, 2000),
          // Convención boletín ENAIRE: las TSAs SIN bloque RMK son
          // áreas de trabajo militar puro (no aprovechables por otro
          // tráfico). Las que llevan RMK suelen indicar coordinación
          // con APP/TWR/ECAO -> área de tránsito utilizable. Coherente
          // con el flag is_work_area que NotamHub publica para los
          // mismos NOTAMs.
          _isWorkArea: !rmkM,
        });
      }
    }
    return tsas;
  }

  // ── ICAO parser ──────────────────────────────────────────────────────

  // "YYMMDDHHMM" → Date UTC
  function parseICAODate(s) {
    const m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!m) return null;
    const yy = +m[1];
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(year, +m[2] - 1, +m[3], +m[4], +m[5]));
  }

  // Bloques NOTAM ICAO comienzan por un ID tipo "A1234/26" y contienen Q)/A)/B)/C)/E).
  function splitICAONotams(text) {
    const marked = text.replace(/(^|\n)([A-Z]\d{3,5}\/\d{2})(\s|\n)/g, '$1\x00$2$3');
    return marked.split('\x00').filter(b => /Q\)/.test(b) && /E\)/.test(b));
  }

  function sectionICAO(block, letter, nextLetters) {
    const next = nextLetters.map(c => c + '\\)').join('|');
    const re = new RegExp(letter + '\\)\\s*([\\s\\S]*?)(?=\\s(?:' + next + ')|$)', 'i');
    const m = block.match(re);
    return m ? m[1].trim() : '';
  }

  // Q) puede terminar en "coord/radio", p.ej. "4130N00300W005"
  function parseICAOQLine(qLine) {
    const m = qLine.match(/(\d{4}[NS])(\d{5}[EW])(\d{3})\s*$/);
    if (!m) return null;
    const lat = parseLat(m[1].slice(0, 4) + '00' + m[1].slice(4));
    const lon = parseLon(m[2].slice(0, 5) + '00' + m[2].slice(5));
    if (lat === null || lon === null) return null;
    return { center: [lat, lon], radiusNM: +m[3] };
  }

  function parseICAOBlock(block) {
    const q = sectionICAO(block, 'Q', ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    const a = sectionICAO(block, 'A', ['B', 'C', 'D', 'E', 'F', 'G']);
    const b = sectionICAO(block, 'B', ['C', 'D', 'E', 'F', 'G']);
    const c = sectionICAO(block, 'C', ['D', 'E', 'F', 'G']);
    const e = sectionICAO(block, 'E', ['F', 'G']);
    const f = sectionICAO(block, 'F', ['G']);
    const g = sectionICAO(block, 'G', []);

    if (!/^\s*TSA\b/i.test(e)) return null; // debe empezar por TSA

    // Polígono preferente: coordenadas dentro de E); si no hay, círculo de Q.
    let polygon = parseCoordinates(e);
    if (polygon.length < 3) {
      const q2 = parseICAOQLine(q);
      if (q2) polygon = geom.circleToPolygon(q2.center, q2.radiusNM * 1.852, 48);
    }
    if (polygon.length < 3) return null;

    const start = parseICAODate(b.trim().split(/\s+/)[0]);
    const end   = parseICAODate(c.trim().split(/\s+/)[0]);
    if (!start || !end) return null;

    // F)/G) → altitudes; si no hay, intenta detectar en E.
    let lowerLabel = f.trim(), upperLabel = g.trim();
    if (!lowerLabel || !upperLabel) {
      const alt = parseVerticalBlock(e);
      if (alt.lowerLabel !== '?' && alt.upperLabel !== '?') {
        return finalise({ polygon, start, end, vertical: alt, name: extractICAOName(e), remarks: e });
      }
    }
    const lo = parseAltitudeToken(lowerLabel || 'GND');
    const hi = parseAltitudeToken(upperLabel || 'UNL');

    return finalise({
      polygon, start, end,
      vertical: { lowerFt: lo.ft, lowerLabel: lo.label, upperFt: hi.ft, upperLabel: hi.label },
      name: extractICAOName(e) || a.trim(),
      remarks: e,
    });

    function finalise(data) {
      return {
        polygon: data.polygon,
        schedules: [{ startUTC: data.start, endUTC: data.end, raw: `${b.trim()} / ${c.trim()}` }],
        vertical: data.vertical,
        name: data.name,
        remarks: data.remarks,
      };
    }
  }

  function extractICAOName(eText) {
    const first = eText.split('\n', 1)[0].trim();
    const m = first.match(/^TSA\s+([A-Z0-9\-\s]+?)(?:[,:;]|$)/i);
    return m ? `TSA ${m[1].trim()}` : first.slice(0, 60);
  }

  function parseICAO(rawText) {
    const blocks = splitICAONotams(rawText);
    const tsas = [];
    for (const block of blocks) {
      const parsed = parseICAOBlock(block);
      if (!parsed) continue;
      tsas.push({
        id: `tsa-${tsas.length + 1}`,
        name: parsed.name,
        polygon: parsed.polygon,
        centroid: geom.centroid(parsed.polygon),
        vertical: parsed.vertical,
        schedules: parsed.schedules,
        format: 'ICAO',
        remarks: parsed.remarks || '',
        rawBlock: block.slice(0, 2000),
        // Sin RMK -> area de trabajo (verde). Con RMK -> transito (rojo).
        _isWorkArea: !parsed.remarks,
      });
    }
    return tsas;
  }

  // ── RFC parser ───────────────────────────────────────────────────────
  // Formato "Solicitud de Reserva de Espacio Aereo NR 05" emitido por las
  // unidades militares (RFC). Cada bloque empieza por "(N) Se solicita
  // publicacion de RESERVA DE ESPACIO AEREO" y contiene:
  //   2. ZONA: TSA <name>
  //   3. LIMITES VERTICALES: <range>
  //   4. FECHAS: ... <D mes YYYY  HH:MMZ-HH:MMZ [HH:MMZ-HH:MMZ]> ...
  //   Limites laterales. ... [coords | "Circulo de XNM ..."]

  const SPANISH_MONTHS = {
    enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5,
    julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11,
  };

  function parseRFCSchedules(text) {
    // "DD <mes> YYYY  HH:MMZ-HH:MMZ" (puede haber 2 ventanas en la misma linea).
    const out = [];
    const re = /\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s+((?:\d{2}:\d{2}Z\s*-\s*\d{2}:\d{2}Z\s*){1,3})/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const day = +m[1];
      const month = SPANISH_MONTHS[m[2].toLowerCase()];
      const year = +m[3];
      if (month === undefined) continue;
      const winRe = /(\d{2}):(\d{2})Z\s*-\s*(\d{2}):(\d{2})Z/g;
      let w;
      while ((w = winRe.exec(m[4])) !== null) {
        const s = new Date(Date.UTC(year, month, day, +w[1], +w[2]));
        let e = new Date(Date.UTC(year, month, day, +w[3], +w[4]));
        if (e <= s) e = new Date(e.getTime() + 24 * 3600 * 1000);
        out.push({ startUTC: s, endUTC: e, raw: `${day} ${m[2]} ${year} ${w[0]}` });
      }
    }
    return out;
  }

  // Extrae poligono lateral del bloque de "Limites laterales". Soporta:
  //   - Lista de coords (>=3 puntos) -> poligono directo.
  //   - "Circulo de XNM de radio centrado en el punto <coord>" (formato AIP).
  //   - "Radio de XNM desde <coord>" (formato RFC variante).
  //   - "Circulo de XNM de radio. <texto> centrado en el punto <coord>" (varias
  //     secciones "De SFC a Yft" en formato RFC).
  // Estrategia: si hay poligono valido en coords, usarlo. Si no, buscar
  // primer "<num>NM" del texto y combinarlo con el primer coord encontrado.
  function parseRFCLateral(text) {
    if (!text) return [];
    const coords = parseCoordinates(text);
    if (coords.length >= 3) return coords;
    // Buscar radio en cualquiera de los formatos vistos.
    const radiusM = text.match(/([\d.,]+)\s*NM/i);
    if (radiusM && coords.length >= 1) {
      const radiusNM = parseFloat(radiusM[1].replace(',', '.'));
      if (Number.isFinite(radiusNM) && radiusNM > 0 && radiusNM < 100) {
        return geom.circleToPolygon(coords[0], radiusNM * 1.852, 48);
      }
    }
    return coords;
  }

  function parseRFC(rawText, defaultYear) {
    const text = rawText.replace(/\r\n?/g, '\n');
    const out = [];
    // Cada bloque empieza por "(N)" al inicio de linea (con o sin espacios).
    const blockRe = /(?:^|\n)\s*\(\d+\)\s+Se\s+solicita[\s\S]+?(?=\n\s*\(\d+\)\s+Se\s+solicita|$)/gi;
    let bm;
    while ((bm = blockRe.exec(text)) !== null) {
      const block = bm[0];

      // PDF.js extrae todo en una sola "linea" por pagina, asi que no podemos
      // delimitar campos con \n. Usamos el siguiente marcador numerado como
      // terminador (3., 4., "Limites laterales").
      const nameM = block.match(/2\.\s*ZONA\s*:\s*([\s\S]+?)\s+3\.\s*L[ÍI]MITES/i);
      if (!nameM) continue;
      const name = nameM[1].trim().replace(/\s+/g, ' ');

      const vertM = block.match(/3\.\s*L[ÍI]MITES\s+VERTICALES\s*:\s*([\s\S]+?)\s+4\.\s*FECHAS/i);
      let vertical = { lowerFt: 0, lowerLabel: 'GND', upperFt: 0, upperLabel: '?' };
      if (vertM) {
        const vTxt = vertM[1].trim().replace(/\s*[-–]\s*/, '/');
        const v = parseSlashAlt(vTxt) || parseVerticalBlock(vTxt);
        if (v && v.lowerLabel !== '?') vertical = v;
      }

      // FECHAS hasta "Limites laterales".
      const fechaIdx = block.search(/4\.\s*FECHAS/i);
      const latIdx   = block.search(/Limites\s+laterales/i);
      const fechaTxt = (fechaIdx >= 0 && latIdx >= 0)
        ? block.slice(fechaIdx, latIdx)
        : (fechaIdx >= 0 ? block.slice(fechaIdx) : '');
      const schedules = parseRFCSchedules(fechaTxt);

      const latTxt = latIdx >= 0 ? block.slice(latIdx) : '';
      const polygon = parseRFCLateral(latTxt);

      if (polygon.length < 3 || schedules.length === 0) continue;

      // RFC son solicitudes militares directas -> siempre area de trabajo.
      out.push({
        id: `tsa-${out.length + 1}`,
        name,
        polygon,
        centroid: geom.centroid(polygon),
        vertical,
        schedules,
        format: 'RFC',
        remarks: '',
        rawBlock: block.slice(0, 2000),
        _isWorkArea: true,
      });
    }
    return out;
  }

  // ── Detección y entrada pública ──────────────────────────────────────

  function detectFormat(text) {
    const hasAIP  = /L[ÍI]MITES\s+LATERALES/i.test(text) || /FECHAS\s+Y\s+HORARIOS/i.test(text);
    const hasICAO = /Q\)/.test(text) && /E\)/.test(text) && /[A-Z]\d{3,5}\/\d{2}/.test(text);
    const hasRFC  = /Se\s+solicita\s+publicaci/i.test(text) && /ZONA\s*:\s*TSA/i.test(text);
    if (hasRFC) return 'RFC';
    if (hasAIP && !hasICAO) return 'AIP';
    if (hasICAO && !hasAIP) return 'ICAO';
    if (hasAIP && hasICAO) return 'BOTH';
    return 'UNKNOWN';
  }

  function parseText(rawText, opts) {
    const year = (opts && opts.year) || new Date().getUTCFullYear();
    const fmt = detectFormat(rawText);
    let out = [];
    if (fmt === 'RFC') {
      out = out.concat(parseRFC(rawText, year));
    }
    if (fmt === 'AIP' || fmt === 'BOTH' || fmt === 'UNKNOWN') {
      out = out.concat(parseAIP(rawText, year));
    }
    if (fmt === 'ICAO' || fmt === 'BOTH' || fmt === 'UNKNOWN') {
      out = out.concat(parseICAO(rawText));
    }
    out = mergeSameTSA(out);
    out.forEach((t, i) => { t.id = `tsa-${i + 1}`; });
    return out;
  }

  // Fusiona TSAs con la misma identidad (nombre + altitudes) sumando sus
  // ventanas horarias. Útil cuando el boletín repite la misma TSA con
  // distintos periodos en bloques separados.
  function mergeSameTSA(tsas) {
    // Pase 1 — fusión exacta por (nombre, ft inf, ft sup). Conserva etiqueta
    // más descriptiva. Marca la entrada combinada como "fallback" sólo si
    // todas las que la componen lo eran.
    const map = new Map();
    for (const t of tsas) {
      const key = `${t.name}|${t.vertical.lowerFt}|${t.vertical.upperFt}`;
      if (!map.has(key)) {
        map.set(key, { ...t, schedules: [...t.schedules] });
        continue;
      }
      const acc = map.get(key);
      if (t.vertical.lowerLabel.length > acc.vertical.lowerLabel.length) acc.vertical.lowerLabel = t.vertical.lowerLabel;
      if (t.vertical.upperLabel.length > acc.vertical.upperLabel.length) acc.vertical.upperLabel = t.vertical.upperLabel;
      acc.verticalIsFallback = !!(acc.verticalIsFallback && t.verticalIsFallback);
      // _isWorkArea: criterio "any-false wins" igual que en notamHub.
      // Si CUALQUIER bloque del boletin publica esta TSA con RMK
      // (=> _isWorkArea=false, area de transito coordinable), la
      // merged queda marcada como transito. Razon: algunos NOTAMs
      // omiten el bloque RMK aunque la TSA si tenga coordinacion
      // documentada en otro bloque del mismo boletin (visto en TSA
      // PASILLO HUELVA, TSA PASILLO ZAFRA, TSA ESTRECHO 1E/1W,
      // TSA ANDEVALO que aparecen como work sin RMK en algun NOTAM y
      // como transito con RMK ECAO en otro).
      if (t._isWorkArea === false) acc._isWorkArea = false;
      for (const s of t.schedules) acc.schedules.push(s);
    }

    // Pase 2 — para cada nombre con múltiples entradas, si al menos una NO es
    // fallback, fusiona el resto (incluidas las fallback con altitudes "raras"
    // por errores de extracción del PDF) en esa entrada autoritativa.
    const byName = new Map();
    for (const e of map.values()) {
      if (!byName.has(e.name)) byName.set(e.name, []);
      byName.get(e.name).push(e);
    }
    const out = [];
    for (const group of byName.values()) {
      if (group.length === 1) { out.push(group[0]); continue; }
      const proper = group.filter(e => !e.verticalIsFallback);
      const target = proper.length ? proper[0] : group[0];
      for (const e of group) {
        if (e === target) continue;
        for (const s of e.schedules) target.schedules.push(s);
      }
      out.push(target);
    }

    // Dedupe + orden + merge de ventanas solapadas. Una misma TSA puede
    // aparecer en multiples NOTAMs del boletin con DESDE ligeramente
    // distintos (p.ej. 07:51 vs 08:38) que generan ventanas redundantes
    // donde una contiene a la otra. Aqui las fusionamos: si dos ventanas
    // se solapan o se tocan, las unimos en [min(start), max(end)].
    for (const t of out) {
      const sorted = t.schedules.slice().sort((a, b) => a.startUTC - b.startUTC);
      const merged = [];
      for (const s of sorted) {
        const last = merged[merged.length - 1];
        if (last && s.startUTC.getTime() <= last.endUTC.getTime()) {
          // Solapan o se tocan: extiende el final si la nueva acaba mas tarde
          if (s.endUTC.getTime() > last.endUTC.getTime()) {
            last.endUTC = s.endUTC;
          }
        } else {
          merged.push({ startUTC: s.startUTC, endUTC: s.endUTC, raw: s.raw });
        }
      }
      t.schedules = merged;
    }
    return out;
  }

  async function parseFile(file) {
    const lower = (file.name || '').toLowerCase();
    const isPDF = lower.endsWith('.pdf') || file.type === 'application/pdf';
    const text = isPDF
      ? await extractTextFromPDF(await file.arrayBuffer())
      : await file.text();
    // eslint-disable-next-line no-console
    console.debug('[TSAgestor] texto extraído (primeros 1000):', text.slice(0, 1000));
    const tsas = parseText(text);
    console.debug('[TSAgestor] TSAs parseadas:', tsas.length, tsas.map(t => t.name));
    return tsas;
  }

  return { parseFile, parseText, extractTextFromPDF, detectFormat, parseAltitudeToken };
})();
