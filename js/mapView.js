// Leaflet map: initialise, render TSA polygons, altitude legend.
import { buildKMLForTSA, buildKMLForAll, downloadKML } from './kmlExport.js';

let map     = null;
let layers  = [];
let legend  = null;

// Altitude bands → colour (fill, stroke)
const BANDS = [
  { maxFt:  5000, fill: '#44cc00', stroke: '#33aa00', label: '< FL050'       },
  { maxFt: 15000, fill: '#ffaa00', stroke: '#cc8800', label: 'FL050 – FL150' },
  { maxFt: 25000, fill: '#0099ff', stroke: '#0077cc', label: 'FL150 – FL250' },
  { maxFt: 35000, fill: '#ff4444', stroke: '#cc2222', label: 'FL250 – FL350' },
  { maxFt: Infinity, fill: '#cc00ff', stroke: '#9900cc', label: '> FL350'    },
];

function band(upperFt) {
  return BANDS.find(b => upperFt <= b.maxFt) ?? BANDS[BANDS.length - 1];
}

function schedText(tsa) {
  return tsa.schedules.map(s => `${s.date} ${s.start}–${s.end}`).join('<br>');
}

export function initMap() {
  if (map) return;
  map = L.map('map', { center: [39.5, -4.0], zoom: 6 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

export function renderTSAs(tsas) {
  if (!map) initMap();

  layers.forEach(l => map.removeLayer(l));
  layers = [];

  for (const tsa of tsas) {
    if (tsa.coordinates.length < 3) continue;
    const latlngs = tsa.coordinates.map(c => [c.lat, c.lon]);
    const b = band(tsa.verticalLimits.upperFt);

    const poly = L.polygon(latlngs, {
      color:       b.stroke,
      fillColor:   b.fill,
      fillOpacity: 0.25,
      weight:      2,
    });

    poly.bindPopup(() => {
      const div = document.createElement('div');
      div.className = 'tsa-popup';
      div.innerHTML = `
        <h3>${tsa.name}</h3>
        <div class="info-row">Altitud: <span class="alt-chip">${tsa.verticalLimits.lower}</span> / <span class="alt-chip">${tsa.verticalLimits.upper}</span></div>
        <div class="info-row"><strong>Horarios:</strong><br>${schedText(tsa)}</div>
        ${tsa.remarks ? `<div class="info-row" style="font-size:0.75rem;color:var(--muted)">${tsa.remarks.slice(0, 120)}…</div>` : ''}
        <button class="popup-kml-btn" data-id="${tsa.id}">⬇ Descargar KML</button>
      `;
      div.querySelector('.popup-kml-btn').addEventListener('click', () => {
        downloadKML(buildKMLForTSA(tsa), `${tsa.name.replace(/\s+/g, '_')}.kml`);
      });
      return div;
    }, { maxWidth: 280 });

    poly.bindTooltip(tsa.name, { sticky: true, className: 'leaflet-tooltip' });
    poly.addTo(map);
    layers.push(poly);
  }

  if (layers.length > 0) {
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds(), { padding: [40, 40] });
  }

  updateMapStatus(tsas.length);
}

export function setupMapToolbar(allTSAs, getFiltered) {
  document.getElementById('btn-download-kml-all').onclick = () => {
    const tsas = getFiltered();
    if (!tsas.length) return;
    downloadKML(buildKMLForAll(tsas), 'TSAs_activas.kml');
  };
}

export function addLegend() {
  if (!map || legend) return;
  legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `<strong>Límite superior</strong>` +
      BANDS.map(b =>
        `<div class="legend-item">
          <div class="legend-swatch" style="background:${b.fill}"></div>
          <span>${b.label}</span>
        </div>`
      ).join('');
    return div;
  };
  legend.addTo(map);
}

function updateMapStatus(n) {
  const el = document.getElementById('map-status');
  if (el) el.textContent = n ? `${n} TSA${n > 1 ? 's' : ''} mostradas` : 'Sin TSAs para el filtro seleccionado';
}

export { map };
