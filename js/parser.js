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
    return pages.join('\n\n');
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

  // "FL150" | "1500FT" | "GND" | "SFC" | "UNL" | "3500 FT AGL" → pies
  function parseAltitudeToken(str) {
    const s = str.trim().toUpperCase();
    if (/^(GND|SFC|MSL)$/.test(s)) return { ft: 0, label: s };
    if (/^UNL(IMITED)?$/.test(s)) return { ft: 99999, label: 'UNL' };
    const fl = s.match(/^FL\s*0*(\d+)\b/);
    if (fl) return { ft: +fl[1] * 100, label: `FL${fl[1]}` };
    const ft = s.match(/^(\d[\d,]*)\s*FT\b/);
    if (ft) return { ft: +ft[1].replace(/,/g, ''), label: s };
    const mt = s.match(/^(\d+)\s*M\b/);
    if (mt) return { ft: Math.round(+mt[1] * 3.28084), label: s };
    const raw = s.match(/^(\d+)$/);
    if (raw) return { ft: +raw[1], label: s };
    return { ft: 0, label: s };
  }

  function parseVerticalBlock(text) {
    // Acepta "GND/FL195", "FL150/FL350", "1500FT AGL / FL245", etc.
    const cleaned = text.replace(/\n+/g, ' ').trim();
    const m = cleaned.match(/([A-Z0-9,.\s]+?)\s*\/\s*([A-Z0-9,.\s]+?)(?=\s{2,}|$|\||;)/i)
            || cleaned.match(/([A-Z0-9,.\s]+?)\s*\/\s*([A-Z0-9,.\s]+)/i);
    if (!m) return { lowerFt: 0, lowerLabel: '?', upperFt: 0, upperLabel: '?' };
    const lo = parseAltitudeToken(m[1]);
    const hi = parseAltitudeToken(m[2]);
    return { lowerFt: lo.ft, lowerLabel: lo.label, upperFt: hi.ft, upperLabel: hi.label };
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

    // 3. Día único: "MMM DD HR HHMM-HHMM" (saltando los ya consumidos).
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
    const m = text.match(/CON\s+PERIODO\s+DE\s+ACTIVIDAD\s*:\s*([^\n]+)/i);
    if (m) {
      const out = parseMixedDaySpec(m[1].trim(), defaultYear);
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
    const re = /C[IÍ]RCULO\s+DE\s+([\d.,]+)\s*NM\s+DE\s+RADIO\s+CENTRADO\s+EN\s+(\d{6}(?:\.\d+)?[NS])\s+(\d{7}(?:\.\d+)?[EW])/i;
    const m = text.match(re);
    if (!m) return null;
    const radiusNM = parseFloat(m[1].replace(',', '.'));
    if (Number.isNaN(radiusNM)) return null;
    const lat = parseLat(m[2]);
    const lon = parseLon(m[3]);
    if (lat === null || lon === null) return null;
    return { center: [lat, lon], radiusKm: radiusNM * 1.852 };
  }

  function parseAIP(rawText, defaultYear) {
    const text = rawText.replace(/\r\n?/g, '\n');
    const docSchedules = parseDocumentLevelSchedules(text, defaultYear);
    // Inserta marcador antes de cada cabecera "TSA <nombre>" que arranca línea.
    const marked = text.replace(/(^|\n)(TSA\b[^\n]*)/g, '$1\x00$2');
    const blocks = marked.split('\x00').filter(b => /^TSA\b/.test(b.trim()));

    const tsas = [];
    for (const block of blocks) {
      const firstLine = block.split('\n', 1)[0].trim();
      const name = firstLine.replace(/\s+/g, ' ');

      const section = (from, to) => {
        const re = new RegExp(from + '\\s*:([\\s\\S]*?)(?=' + to + '|$)', 'i');
        const m = block.match(re);
        return m ? m[1] : '';
      };

      const lateralRaw  = section('L[ÍI]MITES\\s+LATERALES',   'L[ÍI]MITES\\s+VERTICALES');
      const verticalRaw = section('L[ÍI]MITES\\s+VERTICALES',  'FECHAS\\s+Y\\s+HORARIOS');
      const schedRaw    = section('FECHAS\\s+Y\\s+HORARIOS',   'RMK\\s*:|OBSERV');
      const rmkM        = block.match(/RMK\s*:([\s\S]*?)(?=\x00|$)/i);

      let polygon = parseCoordinates(lateralRaw);
      if (polygon.length < 3) {
        const circle = parseCircleDefinition(lateralRaw);
        if (circle) polygon = geom.circleToPolygon(circle.center, circle.radiusKm, 48);
      }
      const vertical = parseVerticalBlock(verticalRaw);
      let schedules = parseAIPSchedules(schedRaw, defaultYear);
      if (schedules.length === 0 && docSchedules.length > 0) {
        // El boletín define el periodo en cabecera; usarlo cuando la TSA no lo repite.
        schedules = docSchedules;
      }

      if (polygon.length >= 3 && schedules.length > 0) {
        tsas.push({
          id: `tsa-${tsas.length + 1}`,
          name,
          polygon,
          centroid: geom.centroid(polygon),
          vertical,
          schedules,
          format: 'AIP',
          remarks: rmkM ? rmkM[1].trim() : '',
          rawBlock: block.slice(0, 2000),
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
      });
    }
    return tsas;
  }

  // ── Detección y entrada pública ──────────────────────────────────────

  function detectFormat(text) {
    const hasAIP  = /L[ÍI]MITES\s+LATERALES/i.test(text) || /FECHAS\s+Y\s+HORARIOS/i.test(text);
    const hasICAO = /Q\)/.test(text) && /E\)/.test(text) && /[A-Z]\d{3,5}\/\d{2}/.test(text);
    if (hasAIP && !hasICAO) return 'AIP';
    if (hasICAO && !hasAIP) return 'ICAO';
    if (hasAIP && hasICAO) return 'BOTH';
    return 'UNKNOWN';
  }

  function parseText(rawText, opts) {
    const year = (opts && opts.year) || new Date().getUTCFullYear();
    const fmt = detectFormat(rawText);
    let out = [];
    if (fmt === 'AIP' || fmt === 'BOTH' || fmt === 'UNKNOWN') {
      out = out.concat(parseAIP(rawText, year));
    }
    if (fmt === 'ICAO' || fmt === 'BOTH' || fmt === 'UNKNOWN') {
      out = out.concat(parseICAO(rawText));
    }
    // Renumerar ids (concat podría duplicarlos)
    out.forEach((t, i) => { t.id = `tsa-${i + 1}`; });
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

  return { parseFile, parseText, extractTextFromPDF, detectFormat };
})();
