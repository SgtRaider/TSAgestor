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
    addAirwayLayers();
    return map;
  }

  function addAirwayLayers() {
    const data = window.TSAgestor.airways;
    if (!data) return;
    const upperLayer = buildAirwaysLayer(data.upper, 'upper');
    const lowerLayer = buildAirwaysLayer(data.lower, 'lower');
    L.control.layers(null, {
      'Aerovías alta cota (demo)': upperLayer,
      'Aerovías baja cota (demo)': lowerLayer,
    }, { position: 'topleft', collapsed: false }).addTo(map);
  }

  function buildAirwaysLayer(airways, type) {
    const group = L.layerGroup();
    if (!airways) return group;
    const isUpper = type === 'upper';
    const color = isUpper ? '#7c3aed' : '#0ea5e9';
    const labelClass = 'airway-label ' + (isUpper ? 'upper' : 'lower');
    for (const aw of airways) {
      const line = L.polyline(aw.points, {
        color, weight: isUpper ? 2.5 : 2, opacity: 0.85,
        dashArray: isUpper ? '8 4' : null,
      });
      line.bindTooltip(aw.name + (isUpper ? ' · alta cota' : ' · baja cota'), { sticky: true });
      line.addTo(group);
      const mid = midpointOf(aw.points);
      L.tooltip({
        permanent: true, direction: 'center', className: labelClass, interactive: false,
      }).setLatLng(mid).setContent(aw.name).addTo(group);
    }
    return group;
  }

  function midpointOf(pts) {
    if (pts.length === 1) return pts[0];
    if (pts.length % 2 === 1) return pts[Math.floor(pts.length / 2)];
    const a = pts[pts.length / 2 - 1], b = pts[pts.length / 2];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  function drawOfflineBackground() {
    const geo = window.TSAgestor.offlineGeo;
    if (!geo || !geo.countries) return;
    L.geoJSON(geo.countries, {
      style: {
        color: LAND_LINE,
        weight: 0.8,
        fillColor: LAND_FILL,
        fillOpacity: 1,
      },
      interactive: false,
    }).addTo(map);
  }

  function drawGraticule() {
    const opts = {
      color: '#94a3b8', weight: 0.5, opacity: 0.45,
      interactive: false, dashArray: '2 4',
    };
    // Mundo entero cada 10°.
    for (let lat = -80; lat <= 80; lat += 10) {
      L.polyline([[lat, -180], [lat, 180]], opts).addTo(map);
    }
    for (let lon = -180; lon <= 180; lon += 10) {
      L.polyline([[-80, lon], [80, lon]], opts).addTo(map);
    }
  }

  function drawCities() {
    const geo = window.TSAgestor.offlineGeo;
    if (!geo || !geo.cities) return;
    for (const city of geo.cities) {
      const isCap = city.capital === true || city.type === 'capital';
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
    const fmt = window.TSAgestor.scheduleFmt;
    const lines = fmt
      ? fmt.listText(tsa.schedules).slice(0, 8).map(l => `• ${escapeHTML(l)}`).join('<br>')
      : tsa.schedules.slice(0, 6).map(s => `• ${formatSchedule(s)}`).join('<br>');
    const totalGroups = fmt ? fmt.listText(tsa.schedules).length : tsa.schedules.length;
    const more = totalGroups > 8 ? `<br><i>…y ${totalGroups - 8} grupos más</i>` : '';
    return `
      <b>${escapeHTML(tsa.name)}</b><br>
      <i>${tsa.format}</i><br>
      Altitud: <b>${escapeHTML(tsa.vertical.lowerLabel)}</b> → <b>${escapeHTML(tsa.vertical.upperLabel)}</b><br>
      Vértices: ${tsa.polygon.length}<br>
      <b>Ventanas (${tsa.schedules.length} días):</b><br>${lines}${more}
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
