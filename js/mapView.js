// Vista de mapa Leaflet: dibuja los polígonos TSA y gestiona leyenda/popups.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.mapView = (function () {
  'use strict';

  const geom = window.TSAgestor.geom;

  const BAND_COLORS = {
    low:  '#22c55e', // <= FL100
    mid:  '#f59e0b', // hasta FL245
    high: '#ef4444', // por encima
  };

  let map = null;
  let layerGroup = null;
  let legend = null;

  function init(elId) {
    if (map) return map;
    map = L.map(elId, { zoomControl: true }).setView([40.4, -3.7], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    layerGroup = L.layerGroup().addTo(map);
    addLegend();
    return map;
  }

  function addLegend() {
    if (legend) return;
    legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'map-legend');
      div.innerHTML =
        '<b>Banda de altitud</b><br>' +
        `<span class="swatch" style="background:${BAND_COLORS.low}"></span>≤ FL100<br>` +
        `<span class="swatch" style="background:${BAND_COLORS.mid}"></span>FL100 – FL245<br>` +
        `<span class="swatch" style="background:${BAND_COLORS.high}"></span>&gt; FL245`;
      return div;
    };
    legend.addTo(map);
  }

  function formatSchedule(sch) {
    const fmt = d => d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    return `${fmt(sch.startUTC)} → ${fmt(sch.endUTC)}`;
  }

  function buildPopup(tsa) {
    const schedLines = tsa.schedules.slice(0, 6).map(s => `• ${formatSchedule(s)}`).join('<br>');
    const more = tsa.schedules.length > 6 ? `<br><i>…y ${tsa.schedules.length - 6} más</i>` : '';
    return `
      <b>${escapeHTML(tsa.name)}</b><br>
      <i>${tsa.format}</i><br>
      Altitud: <b>${escapeHTML(tsa.vertical.lowerLabel)}</b> → <b>${escapeHTML(tsa.vertical.upperLabel)}</b><br>
      Vértices: ${tsa.polygon.length}<br>
      <b>Ventanas:</b><br>${schedLines}${more}
    `;
  }

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function render(tsas) {
    if (!map) return;
    layerGroup.clearLayers();
    if (!tsas || tsas.length === 0) return;

    const allLatLngs = [];
    for (const tsa of tsas) {
      const band = geom.altitudeBand(tsa.vertical.upperFt);
      const color = BAND_COLORS[band];
      const poly = L.polygon(tsa.polygon, {
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.22,
      });
      poly.bindPopup(buildPopup(tsa));
      poly.bindTooltip(tsa.name, { permanent: false, direction: 'center', className: 'tsa-tooltip' });
      poly.addTo(layerGroup);
      for (const pt of tsa.polygon) allLatLngs.push(pt);
    }
    if (allLatLngs.length) {
      map.fitBounds(L.latLngBounds(allLatLngs), { padding: [30, 30] });
    }
  }

  function fitBounds() {
    if (!map || !layerGroup) return;
    const pts = [];
    layerGroup.eachLayer(l => {
      if (l.getLatLngs) {
        const arr = l.getLatLngs()[0] || [];
        arr.forEach(p => pts.push(p));
      }
    });
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  }

  function invalidateSize() { if (map) map.invalidateSize(); }

  return { init, render, fitBounds, invalidateSize };
})();
