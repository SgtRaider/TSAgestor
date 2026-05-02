// Vista de mapa Leaflet OFFLINE: usa el dataset bundled en offlineGeo.js
// (Iberia + islas + costas + ciudades + retícula lat/lon) en lugar de tiles
// OSM. Los polígonos TSA se siguen pintando encima en render(tsas).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.mapView = (function () {
  'use strict';

  const geom = window.TSAgestor.geom;

  const BAND_COLORS = {
    low:  '#22c55e',
    mid:  '#f59e0b',
    high: '#ef4444',
  };

  const SEA_COLOR  = '#cce4f6';
  const LAND_FILL  = '#f3e6c4';
  const LAND_LINE  = '#7d6843';

  let map = null;
  let layerGroup = null;
  let legend = null;

  function init(elId) {
    if (map) return map;
    map = L.map(elId, {
      zoomControl: true,
      worldCopyJump: false,
      minZoom: 3,
      maxZoom: 11,
      attributionControl: false,
    }).setView([40.4, -3.7], 6);

    // Fondo "mar" en el contenedor del mapa.
    const container = document.getElementById(elId);
    if (container) container.style.background = SEA_COLOR;

    drawOfflineBackground();
    drawGraticule();
    drawCities();

    layerGroup = L.layerGroup().addTo(map);
    addLegend();
    return map;
  }

  function drawOfflineBackground() {
    const geo = window.TSAgestor.offlineGeo;
    if (!geo) return;
    const landStyle = {
      color: LAND_LINE, weight: 1.2,
      fillColor: LAND_FILL, fillOpacity: 1,
      interactive: false,
    };
    const lineStyle = {
      color: LAND_LINE, weight: 1.2, opacity: 0.85,
      interactive: false, fill: false,
    };

    L.polygon(geo.iberia, landStyle).addTo(map);
    for (const isl of geo.islands) {
      L.polygon(isl.coords, landStyle).addTo(map);
    }
    for (const c of geo.coastlines) {
      L.polyline(c.coords, lineStyle).addTo(map);
    }
  }

  function drawGraticule() {
    const opts = {
      color: '#94a3b8', weight: 0.5, opacity: 0.5,
      interactive: false, dashArray: '2 4',
    };
    for (let lat = 20; lat <= 60; lat += 5) {
      L.polyline([[lat, -25], [lat, 35]], opts).addTo(map);
    }
    for (let lon = -25; lon <= 35; lon += 5) {
      L.polyline([[20, lon], [60, lon]], opts).addTo(map);
    }
  }

  function drawCities() {
    const geo = window.TSAgestor.offlineGeo;
    if (!geo || !geo.cities) return;
    for (const city of geo.cities) {
      const isCap = city.type === 'capital';
      L.circleMarker([city.lat, city.lon], {
        radius: isCap ? 4 : 2.5,
        color: '#1f2937',
        fillColor: isCap ? '#dc2626' : '#374151',
        fillOpacity: 1,
        weight: 1,
        interactive: false,
      }).addTo(map);
      L.tooltip({
        permanent: true,
        direction: 'right',
        offset: [4, 0],
        className: 'city-label' + (isCap ? ' capital' : ''),
      }).setLatLng([city.lat, city.lon]).setContent(city.name).addTo(map);
    }
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

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function buildPopup(tsa) {
    const lines = tsa.schedules.slice(0, 6).map(s => `• ${formatSchedule(s)}`).join('<br>');
    const more = tsa.schedules.length > 6 ? `<br><i>…y ${tsa.schedules.length - 6} más</i>` : '';
    return `
      <b>${escapeHTML(tsa.name)}</b><br>
      <i>${tsa.format}</i><br>
      Altitud: <b>${escapeHTML(tsa.vertical.lowerLabel)}</b> → <b>${escapeHTML(tsa.vertical.upperLabel)}</b><br>
      Vértices: ${tsa.polygon.length}<br>
      <b>Ventanas:</b><br>${lines}${more}
    `;
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
        color, weight: 2, fillColor: color, fillOpacity: 0.30,
      });
      poly.bindPopup(buildPopup(tsa));
      poly.bindTooltip(tsa.name, { direction: 'center', className: 'tsa-tooltip' });
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
