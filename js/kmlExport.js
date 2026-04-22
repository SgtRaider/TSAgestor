// Builds KML strings and triggers browser downloads.
// KML coordinate order: lon,lat,alt

function closeRing(coords) {
  if (!coords.length) return coords;
  const first = coords[0], last = coords[coords.length - 1];
  if (first.lat === last.lat && first.lon === last.lon) return coords;
  return [...coords, first];
}

function coordsKML(coords) {
  return closeRing(coords)
    .map(c => `${c.lon.toFixed(6)},${c.lat.toFixed(6)},0`)
    .join('\n              ');
}

function schedText(tsa) {
  return tsa.schedules.map(s => `${s.date} ${s.start}-${s.end}`).join('; ');
}

function altColor(upperFt) {
  if (upperFt <= 5000)  return { line: 'ff44cc00', poly: '4444cc00' };
  if (upperFt <= 15000) return { line: 'ffff9900', poly: '44ff9900' };
  if (upperFt <= 25000) return { line: 'ff0099ff', poly: '440099ff' };
  if (upperFt <= 35000) return { line: 'ff4444ff', poly: '444444ff' };
  return                       { line: 'ffcc00ff', poly: '44cc00ff' };
}

function placemark(tsa) {
  const col = altColor(tsa.verticalLimits.upperFt);
  return `  <Style id="${tsa.id}">
    <LineStyle><color>${col.line}</color><width>2</width></LineStyle>
    <PolyStyle><color>${col.poly}</color></PolyStyle>
  </Style>
  <Placemark>
    <name>${escXML(tsa.name)}</name>
    <description><![CDATA[
      <b>Límites verticales:</b> ${tsa.verticalLimits.lower} / ${tsa.verticalLimits.upper}<br>
      <b>Horarios:</b> ${schedText(tsa)}<br>
      <b>Observaciones:</b> ${tsa.remarks}
    ]]></description>
    <styleUrl>#${tsa.id}</styleUrl>
    <Polygon>
      <extrude>0</extrude>
      <altitudeMode>clampToGround</altitudeMode>
      <outerBoundaryIs>
        <LinearRing>
          <coordinates>
              ${coordsKML(tsa.coordinates)}
          </coordinates>
        </LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>`;
}

function escXML(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export function buildKMLForTSA(tsa) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escXML(tsa.name)}</name>
${placemark(tsa)}
</Document>
</kml>`;
}

export function buildKMLForAll(tsas, label = 'TSAs') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escXML(label)}</name>
${tsas.map(placemark).join('\n')}
</Document>
</kml>`;
}

export function downloadKML(content, filename) {
  const blob = new Blob([content], { type: 'application/vnd.google-earth.kml+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
