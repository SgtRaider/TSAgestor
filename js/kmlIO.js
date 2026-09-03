// Import / export de TSAs en formato KML.
//
// KML usa coordenadas lon,lat,alt separadas por comas y los puntos
// separados por espacios o saltos de linea. Internamente usamos
// poligonos [lat, lon].
//
// La extension ExtendedData permite guardar metadatos extra (altitudes
// como labels, schedules en JSON) que el visor estandar de KML ignora
// pero que TSAgestor recupera al re-importar.
//
// Limitaciones aceptadas:
//   - Solo poligonos exteriores (sin agujeros / inner boundary).
//   - Lee Placemarks con <Polygon> o <MultiGeometry><Polygon> (toma
//     el primero del MultiGeometry).
//   - No procesa <Folder> anidados profundamente (toma todos los
//     <Placemark> del Document).
window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.kmlIO = (function () {
  'use strict';

  // ── Parser ──────────────────────────────────────────────────────────

  function parseKML(text, opts) {
    opts = opts || {};
    const defaultPrefix = opts.namePrefix || '';
    if (!text || typeof text !== 'string') return [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, 'application/xml');
    } catch (e) {
      console.warn('[kml] DOMParser fallo:', e);
      return [];
    }
    // Si el parse XML falla, el doc tiene un <parsererror>.
    const errEl = doc.getElementsByTagName('parsererror')[0];
    if (errEl) {
      console.warn('[kml] XML no valido:', errEl.textContent && errEl.textContent.slice(0, 200));
      return [];
    }
    const placemarks = doc.getElementsByTagName('Placemark');
    const out = [];
    for (let i = 0; i < placemarks.length; i++) {
      const t = placemarkToTSA(placemarks[i], i, defaultPrefix);
      if (t) out.push(t);
    }
    return out;
  }

  function placemarkToTSA(pm, idx, namePrefix) {
    const name = textOf(pm.getElementsByTagName('name')[0])
              || `KML TSA ${idx + 1}`;
    const description = textOf(pm.getElementsByTagName('description')[0]) || '';
    // Toma el primer <Polygon> que encuentre (ignora MultiGeometry rings).
    const poly = pm.getElementsByTagName('Polygon')[0];
    if (!poly) return null;
    const outer = poly.getElementsByTagName('outerBoundaryIs')[0];
    if (!outer) return null;
    const ring = outer.getElementsByTagName('LinearRing')[0];
    if (!ring) return null;
    const coordsEl = ring.getElementsByTagName('coordinates')[0];
    if (!coordsEl) return null;
    const polygon = parseCoordinates(textOf(coordsEl));
    if (polygon.length < 3) return null;

    // ExtendedData: nuestras altitudes/schedules custom si las hay.
    const ext = readExtendedData(pm);
    const lowerLabel = ext.lowerLabel || 'GND';
    const upperLabel = ext.upperLabel || 'UNL';
    const lowerFt    = parseAltLabel(lowerLabel, 0);
    const upperFt    = parseAltLabel(upperLabel, 99999);

    // Schedules: si hay ExtendedData de schedules (JSON), parseamos.
    // Si no, sintetizamos una ventana de "hoy 00z -> +30 dias" como
    // placeholder; el usuario puede editarla luego.
    let schedules = [];
    if (ext.schedulesJSON) {
      try {
        const arr = JSON.parse(ext.schedulesJSON);
        if (Array.isArray(arr)) {
          schedules = arr.map(s => ({
            startUTC: new Date(s.start || s.startUTC),
            endUTC:   new Date(s.end   || s.endUTC),
            raw:      s.raw || '',
          })).filter(s => !isNaN(s.startUTC.getTime()) && !isNaN(s.endUTC.getTime()));
        }
      } catch (e) {
        console.warn('[kml] schedules JSON invalido:', e);
      }
    }
    if (!schedules.length) {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const end   = new Date(start.getTime() + 30 * 86400000);
      schedules = [{ startUTC: start, endUTC: end, raw: 'KML import · sin horario, edita el TSA' }];
    }

    const geomMod = window.TSAgestor && window.TSAgestor.geom;
    const centroid = (geomMod && geomMod.centroid) ? geomMod.centroid(polygon) : avgCentroid(polygon);
    const fullName = namePrefix ? `${namePrefix} ${name}` : name;
    return {
      id: 'KML_' + idx + '_' + Math.random().toString(36).slice(2, 8),
      name: fullName,
      format: 'KML',
      vertical: { lowerFt, upperFt, lowerLabel, upperLabel },
      polygon,
      centroid,
      schedules,
      rawBlock: description || `KML import: ${fullName}\n${polygon.length} vertices`,
      _source: 'kml',
      _kmlImported: true,
      _kmlOriginalName: name,
      _description: description,
    };
  }

  function parseCoordinates(txt) {
    if (!txt) return [];
    // KML: "lon,lat[,alt] lon,lat[,alt] ..." separados por whitespace.
    const tokens = txt.trim().split(/\s+/);
    const out = [];
    for (const tok of tokens) {
      const parts = tok.split(',');
      if (parts.length < 2) continue;
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push([lat, lon]);
    }
    return out;
  }

  function readExtendedData(pm) {
    const out = {};
    const ed = pm.getElementsByTagName('ExtendedData')[0];
    if (!ed) return out;
    const datas = ed.getElementsByTagName('Data');
    for (let i = 0; i < datas.length; i++) {
      const d = datas[i];
      const name = d.getAttribute('name');
      const val = textOf(d.getElementsByTagName('value')[0]);
      if (!name) continue;
      if (name === 'lowerLabel')   out.lowerLabel = val;
      else if (name === 'upperLabel') out.upperLabel = val;
      else if (name === 'schedules')  out.schedulesJSON = val;
    }
    return out;
  }

  function parseAltLabel(label, fallbackFt) {
    const parser = window.TSAgestor && window.TSAgestor.parser;
    if (parser && parser.parseAltitudeToken) {
      const p = parser.parseAltitudeToken(label);
      if (p && Number.isFinite(p.ft)) return p.ft;
    }
    return fallbackFt;
  }

  function avgCentroid(polygon) {
    if (!polygon.length) return [0, 0];
    let lat = 0, lon = 0;
    for (const [a, b] of polygon) { lat += a; lon += b; }
    return [lat / polygon.length, lon / polygon.length];
  }

  function textOf(el) {
    if (!el) return '';
    // <coordinates> puede traer CDATA con saltos de linea, etc.
    return (el.textContent || '').trim();
  }

  // ── Exporter ────────────────────────────────────────────────────────

  // Exporta un array de TSAs como string KML. Solo exporta TSAs con
  // poligono valido. Si onlyKmlSourced=true, exporta solo las marcadas
  // con _source='kml' (las que el usuario importo previamente).
  function exportKML(tsas, opts) {
    opts = opts || {};
    const onlyKml = !!opts.onlyKmlSourced;
    const docName = opts.documentName || 'TSAgestor export';
    const list = (tsas || []).filter(t => {
      if (!t || !t.polygon || t.polygon.length < 3) return false;
      if (onlyKml && t._source !== 'kml') return false;
      return true;
    });
    const placemarks = list.map(buildPlacemark).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(docName)}</name>
    <description>Exportado desde TSAgestor — ${list.length} TSAs · ${new Date().toISOString()}</description>
${placemarks}
  </Document>
</kml>
`;
  }

  function buildPlacemark(t) {
    const coords = (t.polygon || []).map(p => `${p[1]},${p[0]},0`).join(' ');
    const schedulesJSON = JSON.stringify((t.schedules || []).map(s => ({
      start: s.startUTC instanceof Date ? s.startUTC.toISOString() : s.startUTC,
      end:   s.endUTC   instanceof Date ? s.endUTC.toISOString()   : s.endUTC,
      raw:   s.raw || '',
    })));
    const lowerLabel = (t.vertical && t.vertical.lowerLabel) || 'GND';
    const upperLabel = (t.vertical && t.vertical.upperLabel) || 'UNL';
    const description = `${xmlEscape(lowerLabel)} – ${xmlEscape(upperLabel)} · ${(t.schedules || []).length} ventana(s)`;
    return `    <Placemark>
      <name>${xmlEscape(t.name || t.id || '?')}</name>
      <description>${description}</description>
      <ExtendedData>
        <Data name="lowerLabel"><value>${xmlEscape(lowerLabel)}</value></Data>
        <Data name="upperLabel"><value>${xmlEscape(upperLabel)}</value></Data>
        <Data name="schedules"><value>${xmlEscape(schedulesJSON)}</value></Data>
      </ExtendedData>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
  }

  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // Dispara la descarga de un texto como archivo. Usado por exportKML
  // desde la UI.
  function downloadAsFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'tsa-export.kml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { parseKML, exportKML, downloadAsFile };
})();
