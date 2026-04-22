// Parses TSA bulletin PDFs/text into structured TSA objects.
// Format expected:
//   TSA <NAME>
//   LIMITES LATERALES: <coords>
//   LIMITES VERTICALES: <lower>/<upper>
//   FECHAS Y HORARIOS: <MONTH DD> HR <HHMM>-<HHMM> [...]
//   RMK: <text>

const PDF_WORKER_SRC =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// PDF.js 3.x CDN build exposes itself as window.pdfjsLib
function getPdfjsLib() {
  const lib = window.pdfjsLib ?? window['pdfjs-dist/build/pdf'];
  if (!lib) throw new Error(
    'PDF.js no está disponible. Comprueba la conexión a internet (CDN).'
  );
  return lib;
}

// ── PDF text extraction ──────────────────────────────────────────────────────

export async function extractTextFromPDF(arrayBuffer) {
  const pdfjsLib = getPdfjsLib();
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();

    // Group text items by row (same Y coordinate, ±4px tolerance)
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str.trim()) continue;
      const y      = Math.round(item.transform[5]);
      const bucket = [...rows.keys()].find(k => Math.abs(k - y) <= 4);
      const key    = bucket !== undefined ? bucket : y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(item);
    }

    // Sort rows top-to-bottom (descending Y), items left-to-right within row
    const sortedYs = [...rows.keys()].sort((a, b) => b - a);
    const lines    = sortedYs.map(y => {
      const items = rows.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
      return items.map(i => i.str).join(' ');
    });

    pages.push(lines.join('\n'));
  }

  return pages.join('\n');
}

// ── Coordinate parsing ───────────────────────────────────────────────────────

function parseLat(str) {
  // "381410N"  →  38°14'10" N
  const m = str.match(/^(\d{2})(\d{2})(\d{2})([NS])$/i);
  if (!m) return null;
  const v = +m[1] + +m[2] / 60 + +m[3] / 3600;
  return m[4].toUpperCase() === 'S' ? -v : v;
}

function parseLon(str) {
  // "0065147W"  →  006°51'47" W
  const m = str.match(/^(\d{3})(\d{2})(\d{2})([EW])$/i);
  if (!m) return null;
  const v = +m[1] + +m[2] / 60 + +m[3] / 3600;
  return m[4].toUpperCase() === 'W' ? -v : v;
}

function parseCoordinates(text) {
  const coords = [];
  const re = /(\d{6}[NS])\s+(\d{7}[EW])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lat = parseLat(m[1]);
    const lon = parseLon(m[2]);
    if (lat !== null && lon !== null) coords.push({ lat, lon });
  }
  return coords;
}

// ── Altitude parsing ─────────────────────────────────────────────────────────

function parseAlt(str) {
  const s = str.trim().toUpperCase();
  if (s === 'GND' || s === 'SFC') return { label: s, ft: 0 };
  const fl = s.match(/^FL\s*(\d+)$/);
  if (fl) return { label: `FL${fl[1]}`, ft: +fl[1] * 100 };
  const ft = s.match(/^(\d[\d,]*)\s*FT$/);
  if (ft) return { label: s, ft: +ft[1].replace(',', '') };
  const mt = s.match(/^(\d+)\s*M$/);
  if (mt) return { label: s, ft: Math.round(+mt[1] * 3.28084) };
  return { label: s, ft: 0 };
}

function parseVerticalLimits(text) {
  const m = text.match(/([A-Z0-9,]+(?:\s*FT|\s*M)?)\s*\/\s*([A-Z0-9,]+(?:\s*FT|\s*M)?)/i);
  if (!m) return { lower: '?', lowerFt: 0, upper: '?', upperFt: 0 };
  const lo = parseAlt(m[1]);
  const hi = parseAlt(m[2]);
  return { lower: lo.label, lowerFt: lo.ft, upper: hi.label, upperFt: hi.ft };
}

// ── Schedule parsing ─────────────────────────────────────────────────────────

function parseSchedules(text) {
  const schedules = [];
  // e.g. "APR 27 HR 1830-2359"
  const re = /([A-Z]{3})\s+(\d{1,2})\s+HR\s+(\d{4})\s*-\s*(\d{4})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    schedules.push({
      month: m[1].toUpperCase(),
      day:   +m[2],
      date:  `${m[1].toUpperCase()} ${+m[2]}`,
      start: m[3],
      end:   m[4],
    });
  }
  return schedules;
}

// ── Main document parser ─────────────────────────────────────────────────────

export function parseTSAText(rawText) {
  const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Insert a null-byte marker before every "TSA " that starts a line,
  // then split on those markers — this correctly handles the first entry too.
  const marked  = text.replace(/(^|\n)(TSA\s)/gm, '$1\x00$2');
  const entries = marked.split('\x00');

  const tsas = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith('TSA ')) continue;

    // Name = first line
    const nlIdx = trimmed.indexOf('\n');
    const name  = (nlIdx > -1 ? trimmed.slice(0, nlIdx) : trimmed).trim();

    const section = (from, to) => {
      const re = new RegExp(from + '\\s*:([\\s\\S]*?)(?=' + to + '|$)', 'i');
      const m  = trimmed.match(re);
      return m ? m[1] : '';
    };

    const lateralRaw  = section('LIMITES\\s+LATERALES',   'LIMITES\\s+VERTICALES');
    const verticalRaw = section('LIMITES\\s+VERTICALES',  'FECHAS\\s+Y\\s+HORARIOS');
    const schedRaw    = section('FECHAS\\s+Y\\s+HORARIOS', 'RMK\\s*:');
    const rmkRaw      = (() => {
      const m = trimmed.match(/RMK\s*:([\s\S]*?)(?=\x00|$)/i);
      return m ? m[1].trim() : '';
    })();

    const coordinates    = parseCoordinates(lateralRaw);
    const verticalLimits = parseVerticalLimits(verticalRaw.trim());
    const schedules      = parseSchedules(schedRaw);

    if (coordinates.length >= 3) {
      tsas.push({
        id: `tsa-${Date.now()}-${tsas.length}`,
        name,
        coordinates,
        verticalLimits,
        schedules,
        remarks: rmkRaw,
      });
    }
  }

  return tsas;
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function parseDocument(file) {
  if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
    const buf  = await file.arrayBuffer();
    const text = await extractTextFromPDF(buf);
    console.debug('[TSAgestor] Texto extraído del PDF:\n', text.slice(0, 2000));
    const tsas = parseTSAText(text);
    console.debug('[TSAgestor] TSAs parseadas:', tsas.length, tsas.map(t => t.name));
    return tsas;
  }
  const text = await file.text();
  return parseTSAText(text);
}
