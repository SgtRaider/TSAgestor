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
  let routeLayer = null;
  let legend = null;
  let drawState = null;

  // Bounding box que enmarca España peninsular + Baleares + sur de Francia,
  // pensado para ser la vista por defecto cuando no hay TSAs ni ruta.
  const DEFAULT_BOUNDS = [[35.5, -10], [44, 5]];

  function init(elId) {
    if (map) return map;
    map = L.map(elId, {
      zoomControl: true,
      worldCopyJump: false,
      minZoom: 3,
      maxZoom: 11,
      attributionControl: false,
    });
    // Vista mínima: el contenedor todavía puede tener tamaño 0×0 antes
    // del primer layout. El caller (switchTab) llama a fitToDefault()
    // dentro de un setTimeout cuando el browser ya ha medido el div.
    map.setView([40, -4], 5);

    // Fondo "mar" en el contenedor del mapa.
    const container = document.getElementById(elId);
    if (container) container.style.background = SEA_COLOR;

    drawOfflineBackground();
    drawGraticule();
    drawCities();

    layerGroup = L.layerGroup().addTo(map);
    addLegend();
    setupMeteoPane();
    addAirwayLayers();
    return map;
  }

  // Apilamiento de paneles (de abajo arriba):
  //   overlayPane (400)  → fondo de países, retícula
  //   meteoTiles (410)   → tiles RainViewer / EUMETView CTH
  //   tsaPane (440)      → TSAs, aerovías, TMAs/CTRs
  //   routePane (460)    → polilínea del plan + waypoints en círculo
  //   markerPane (600)   → marcadores METAR/TAF y ciudades
  //   tooltipPane (650)
  //   popupPane (700)
  function setupMeteoPane() {
    const ensure = (name, z, transparent) => {
      if (!map.getPane(name)) {
        map.createPane(name);
        map.getPane(name).style.zIndex = String(z);
        if (transparent) map.getPane(name).style.pointerEvents = 'none';
      }
    };
    // Tiles meteo no deben capturar clics (transparentes a eventos).
    ensure('meteoTiles', 410, true);
    // TSAs y ruta sí son clicables (popup, tooltip).
    ensure('tsaPane',    440, false);
    ensure('routePane',  460, false);
  }

  function addAirwayLayers() {
    const overlays = {};
    const aw = window.TSAgestor.airways;
    if (aw) {
      overlays['Aerovías alta cota (demo)'] = buildAirwaysLayer(aw.upper, 'upper');
      overlays['Aerovías baja cota (demo)'] = buildAirwaysLayer(aw.lower, 'lower');
    }
    const sp = window.TSAgestor.airspace;
    if (sp) {
      overlays['TMAs (demo)']  = buildAirspaceLayer(sp.tmas, 'tma');
      overlays['CTRs (demo)']  = buildAirspaceLayer(sp.ctrs, 'ctr');
    }
    // Capas meteorológicas — sólo se añaden si el módulo meteoApi está cargado.
    const mapi = window.TSAgestor.meteoApi;
    if (mapi) {
      overlays['Nubosidad (RainViewer IR)'] = buildRainviewerLayer();
      const cthCfg = mapi.getEumetCthWMS && mapi.getEumetCthWMS();
      const cthTitle = cthCfg && cthCfg.title ? cthCfg.title : 'Cloud Top Height';
      overlays[cthTitle] = buildCthLayer();
      overlays['METAR / TAF'] = buildMetarLayer();
    }
    if (Object.keys(overlays).length === 0) return;
    L.control.layers(null, overlays, { position: 'topleft', collapsed: false }).addTo(map);
  }

  // ── Capas meteorológicas ───────────────────────────────────────────

  let cloudRVTile = null;
  function buildRainviewerLayer() {
    const grp = L.layerGroup();
    grp.on('add', async function () {
      if (cloudRVTile) return;
      try {
        const data = await window.TSAgestor.meteoApi.getRainviewerCloudUrl();
        const attr = data.kind === 'satellite'
          ? '© RainViewer · satélite IR'
          : '© RainViewer · radar (precipitación)';
        cloudRVTile = L.tileLayer(data.url, {
          opacity: 0.6, attribution: attr, maxZoom: 11,
          pane: 'meteoTiles',
        });
        cloudRVTile.on('tileerror', function (ev) {
          console.warn('[meteo] RainViewer tileerror:', ev.tile && ev.tile.src);
        });
        grp.addLayer(cloudRVTile);
      } catch (e) {
        console.warn('[meteo] RainViewer:', e.message);
        alert('RainViewer no se pudo cargar:\n' + e.message);
      }
    });
    grp.on('remove', function () {
      if (cloudRVTile) {
        grp.removeLayer(cloudRVTile);
        cloudRVTile = null;
      }
    });
    return grp;
  }

  let cloudCthTile = null;
  let cloudLegendCtl = null;
  function buildCthLayer() {
    const grp = L.layerGroup();
    grp.on('add', function () {
      if (cloudCthTile) return;
      try {
        const cfg = window.TSAgestor.meteoApi.getEumetCthWMS();
        cloudCthTile = L.tileLayer.wms(cfg.url, Object.assign(
          { opacity: 0.7, maxZoom: 11, pane: 'meteoTiles' },
          cfg.options
        ));
        let firstError = true;
        cloudCthTile.on('tileerror', function (ev) {
          if (firstError) {
            firstError = false;
            console.warn('[meteo] EUMETVIEW CTH tileerror:', ev.tile && ev.tile.src);
          }
        });
        grp.addLayer(cloudCthTile);
        showCloudLegend(cfg);
      } catch (e) {
        console.warn('[meteo] EUMETVIEW CTH:', e.message);
        alert('Cloud Top Height (EUMETSAT) no se pudo cargar:\n' + e.message);
      }
    });
    grp.on('remove', function () {
      if (cloudCthTile) {
        grp.removeLayer(cloudCthTile);
        cloudCthTile = null;
      }
      hideCloudLegend();
    });
    return grp;
  }

  function showCloudLegend(cfg) {
    if (!map) return;
    if (cloudLegendCtl) return;
    cloudLegendCtl = L.control({ position: 'bottomleft' });
    cloudLegendCtl.onAdd = function () {
      const div = L.DomUtil.create('div', 'cloud-legend');
      // La imagen oficial de EUMETSAT etiqueta en metros (320, 4240, 8160,
      // 12080, 16000). Mostramos su gradiente de colores intacto pero
      // tapamos sus etiquetas con un overlay blanco y superponemos las
      // nuestras en FL (mismas posiciones convertidas a niveles de vuelo).
      const legendBlock = cfg.legendUrl
        ? `<div class="cth-legend-stack">
             <img src="${cfg.legendUrl}" alt="Escala de altura"
                  onerror="this.parentNode.outerHTML='<div class=&quot;cloud-legend-bar&quot;></div>'">
             <div class="cth-legend-mask"></div>
             <div class="cth-legend-fl">
               <span style="left:20.4%">FL010</span>
               <span style="left:40.1%">FL140</span>
               <span style="left:59.8%">FL270</span>
               <span style="left:79.5%">FL400</span>
               <span style="left:97%">FL525</span>
             </div>
           </div>`
        : `<div class="cloud-legend-bar"></div>
           <div class="cloud-legend-ticks">
             <span><b>FL030</b><br><i>1 km</i></span>
             <span><b>FL165</b><br><i>5 km</i></span>
             <span><b>FL330</b><br><i>10 km</i></span>
             <span><b>FL490</b><br><i>15 km</i></span>
           </div>`;
      div.innerHTML = `
        <div class="cloud-legend-title">${cfg.title || 'Cloud Top Height'}</div>
        ${legendBlock}
        <div class="cloud-legend-help">altura del tope de nube · niveles de vuelo</div>
        <div class="cloud-legend-attr">${cfg.options.attribution || '© EUMETSAT'}</div>
      `;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    cloudLegendCtl.addTo(map);
  }
  function hideCloudLegend() {
    if (cloudLegendCtl) {
      cloudLegendCtl.remove();
      cloudLegendCtl = null;
    }
  }

  let meteoLayer = null;
  let meteoLoadedAll = false;     // ya se cargaron todos los aeropuertos
  let meteoBoundLoad = false;     // listener add/remove ya enganchado
  function ensureMeteoLayer() {
    if (meteoLayer) return meteoLayer;
    meteoLayer = L.layerGroup();
    return meteoLayer;
  }

  // Capa controlable desde el panel: al activarla, descarga METAR/TAF de
  // todos los aeropuertos del listado y los pinta con popup.
  function buildMetarLayer() {
    const grp = ensureMeteoLayer();
    if (meteoBoundLoad) return grp;
    meteoBoundLoad = true;
    grp.on('add', async function () {
      if (meteoLoadedAll || (grp.getLayers && grp.getLayers().length > 0)) return;
      await loadAllAirportsWeather(grp);
    });
    return grp;
  }

  async function loadAllAirportsWeather(grp) {
    const aw = window.TSAgestor.airways;
    const mapi = window.TSAgestor.meteoApi;
    if (!aw || !mapi) return;
    const icaos = Object.keys(aw.waypoints).filter(k => /^[A-Z]{4}$/.test(k));
    if (!icaos.length) return;

    // Banner provisional para que el usuario sepa que está cargando.
    const loadingMsg = L.control({ position: 'topright' });
    loadingMsg.onAdd = function () {
      const d = L.DomUtil.create('div', 'meteo-loading');
      d.textContent = 'Cargando METAR/TAF de ' + icaos.length + ' aeropuertos…';
      return d;
    };
    if (map) loadingMsg.addTo(map);

    let firstError = null;
    try {
      // Petición en lotes para evitar URLs gigantes.
      const batch = 40;
      const all = {};
      for (let i = 0; i < icaos.length; i += batch) {
        const chunk = icaos.slice(i, i + batch);
        try {
          const res = await mapi.fetchWeatherForAirports(chunk);
          Object.assign(all, res.airports);
          if (res.errors && (res.errors.metar || res.errors.taf) && !firstError) {
            firstError = res.errors.metar || res.errors.taf;
          }
        } catch (e) {
          console.warn('[meteo] lote falló:', e);
          if (!firstError) firstError = e.message || String(e);
        }
      }
      const haveAny = Object.values(all).some(v => v && (v.metar || v.taf));
      if (!haveAny && firstError) {
        alert('No se pudo descargar METAR/TAF:\n' + firstError);
        return;
      }
      const names = aw.waypointNames || {};
      const items = icaos.map(icao => ({
        icao,
        lat: aw.waypoints[icao][0],
        lon: aw.waypoints[icao][1],
        name: names[icao] || null,
        metar: all[icao] && all[icao].metar,
        taf:   all[icao] && all[icao].taf,
      }));
      grp.clearLayers();
      addWeatherMarkersTo(grp, items);
      meteoLoadedAll = true;
    } finally {
      if (map) loadingMsg.remove();
    }
  }

  function addWeatherMarkersTo(layer, items) {
    if (!items || !items.length) return;
    for (const it of items) {
      const cat = (it.metar && it.metar.category) || 'UNK';
      const hasData = !!(it.metar || it.taf);
      const color = hasData ? metarFlightCatColor(cat) : '#6b7280';
      const marker = L.circleMarker([it.lat, it.lon], {
        radius: hasData ? 8 : 4,
        weight: 1.5,
        color: '#0f172a',
        fillColor: color,
        fillOpacity: hasData ? 0.9 : 0.4,
        pane: 'markerPane',
      });
      const metarRaw = it.metar && it.metar.raw ? it.metar.raw : '— sin METAR —';
      const tafRaw   = it.taf   && it.taf.raw   ? it.taf.raw   : '— sin TAF —';
      const dec = window.TSAgestor.metarDecode;
      const metarHTML = dec && it.metar && it.metar.raw
        ? dec.toHtmlList(dec.decodeMETAR(it.metar.raw))
        : '';
      const tafHTML = dec && it.taf && it.taf.raw
        ? dec.toHtmlList(dec.decodeTAF(it.taf.raw))
        : '';
      const html = `
        <div class="meteo-popup">
          <div class="meteo-popup-head">
            <b>${it.icao}</b>${it.name ? ` · ${escapeHTMLLocal(it.name)}` : ''}
            <span class="meteo-cat cat-${cat}">${cat}</span>
          </div>
          <div class="meteo-section">
            <b>METAR</b><pre>${escapeHTMLLocal(metarRaw)}</pre>
            ${metarHTML}
          </div>
          <div class="meteo-section">
            <b>TAF</b><pre>${escapeHTMLLocal(tafRaw)}</pre>
            ${tafHTML}
          </div>
        </div>`;
      marker.bindPopup(html, { maxWidth: 520 });
      marker.bindTooltip(`${it.icao}${hasData ? ' · ' + cat : ''}`, { direction: 'top' });
      layer.addLayer(marker);
    }
  }

  function metarFlightCatColor(cat) {
    switch ((cat || '').toUpperCase()) {
      case 'VFR':  return '#22c55e';
      case 'MVFR': return '#3b82f6';
      case 'IFR':  return '#ef4444';
      case 'LIFR': return '#a855f7';
      default:     return '#9ca3af';
    }
  }

  // Reemplaza los marcadores con un subconjunto concreto (botón del plan).
  function setWeatherMarkers(items) {
    if (!map) return;
    const layer = ensureMeteoLayer();
    layer.clearLayers();
    addWeatherMarkersTo(layer, items);
    meteoLoadedAll = false;     // ya no es la lista completa
    if (!map.hasLayer(layer)) layer.addTo(map);
  }

  function clearWeatherMarkers() {
    if (meteoLayer) meteoLayer.clearLayers();
    meteoLoadedAll = false;
  }

  function escapeHTMLLocal(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function buildAirspaceLayer(items, type) {
    const group = L.layerGroup();
    if (!items) return group;
    const isTMA = type === 'tma';
    const color = isTMA ? '#0369a1' : '#dc2626';
    const labelClass = 'airspace-label ' + type;
    for (const a of items) {
      const poly = L.polygon(a.coords, {
        color, weight: isTMA ? 1.5 : 1.2,
        fillColor: color, fillOpacity: isTMA ? 0.06 : 0.10,
        dashArray: isTMA ? null : '4 3',
        pane: 'tsaPane',
      });
      const altText = `${formatAlt(a.lower)} – ${formatAlt(a.upper)}`;
      poly.bindTooltip(`<b>${a.name}</b><br>${altText}`, { sticky: true });
      poly.addTo(group);
      L.tooltip({
        permanent: true, direction: 'center', className: labelClass, interactive: false,
      }).setLatLng([a.lat, a.lon]).setContent(a.name).addTo(group);
    }
    return group;
  }

  function formatAlt(ft) {
    if (ft <= 0) return 'GND';
    if (ft >= 10000) return 'FL' + Math.round(ft / 100);
    return ft + 'FT';
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
        pane: 'tsaPane',
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
        pane: 'markerPane',
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
        pane: 'tsaPane',
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
    if (!map) return;
    // 1) TSAs visibles
    if (layerGroup) {
      const pts = [];
      layerGroup.eachLayer(l => {
        if (l.getLatLngs) {
          const arr = l.getLatLngs()[0] || [];
          arr.forEach(p => pts.push(p));
        }
      });
      if (pts.length) {
        map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
        return;
      }
    }
    // 2) Ruta del plan dibujada
    if (routeLayer) {
      const pts = [];
      routeLayer.eachLayer(l => {
        if (l.getLatLngs) {
          const arr = l.getLatLngs();
          if (Array.isArray(arr)) arr.forEach(p => p && pts.push(p));
        } else if (l.getLatLng) {
          pts.push(l.getLatLng());
        }
      });
      if (pts.length) {
        map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
        return;
      }
    }
    // 3) Vista por defecto: Iberia + Baleares
    map.fitBounds(DEFAULT_BOUNDS, { padding: [10, 10] });
  }

  function invalidateSize() { if (map) map.invalidateSize(); }

  function fitToDefault() {
    if (!map) return;
    map.fitBounds(DEFAULT_BOUNDS, { padding: [10, 10] });
  }

  function ensureRouteLayer() {
    if (!map) return null;
    if (!routeLayer) routeLayer = L.layerGroup().addTo(map);
    return routeLayer;
  }

  function renderFlightPlan(plan) {
    if (!map) return;
    const grp = ensureRouteLayer();
    grp.clearLayers();
    if (!plan || !plan.coords || plan.coords.length < 2) return;

    const pts = plan.coords.map(c => [c.lat, c.lon]);

    // Halo oscuro (legibilidad sobre cualquier fondo) + línea principal
    L.polyline(pts, { color: '#1f2937', weight: 7, opacity: 0.35, pane: 'routePane' }).addTo(grp);
    L.polyline(pts, { color: '#fbbf24', weight: 4, opacity: 0.95, pane: 'routePane' }).addTo(grp);

    plan.coords.forEach((c, i) => {
      const isExtreme = i === 0 || i === plan.coords.length - 1;
      const m = L.circleMarker([c.lat, c.lon], {
        radius: isExtreme ? 6 : 4,
        color: '#1f2937',
        fillColor: isExtreme ? '#fbbf24' : '#fde68a',
        fillOpacity: 1, weight: 1.5,
        pane: 'routePane',
      }).addTo(grp);
      const tip = c.name + (c.airway && c.airway !== '—' ? ' · ' + c.airway : '');
      m.bindTooltip(tip, { direction: 'top', offset: [0, -4] });
      L.tooltip({
        permanent: true, direction: 'right', offset: [6, 0],
        className: 'route-label' + (isExtreme ? ' extreme' : ''),
        interactive: false,
      }).setLatLng([c.lat, c.lon]).setContent(c.name).addTo(grp);
    });

    if (plan.conflicts && plan.conflicts.length) {
      for (const cf of plan.conflicts) {
        L.polygon(cf.tsa.polygon, {
          color: '#dc2626', weight: 3, fillOpacity: 0, dashArray: '6 4',
          pane: 'routePane',
        }).bindTooltip('CONFLICTO: ' + cf.tsa.name, { sticky: true }).addTo(grp);
      }
    }

    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }

  function clearFlightPlan() {
    if (routeLayer) routeLayer.clearLayers();
  }

  // ── Modo dibujo de ruta ─────────────────────────────────────────────
  // opts: { origin, destination, snapKm, onUpdate, onFinish, onCancel }

  function startDrawingRoute(opts) {
    if (!map) return;
    cancelDrawingRoute(true);
    drawState = {
      origin: opts.origin,
      destination: opts.destination,
      snapKm: opts.snapKm != null ? opts.snapKm : 30,
      tsas: opts.tsas || [],
      initialFL: opts.flightLevel || 350,
      points: [],          // intermedios (objetos {name,lat,lon,tsa?,fl?})
      onUpdate: opts.onUpdate,
      onFinish: opts.onFinish,
      onCancel: opts.onCancel,
      layer: L.layerGroup().addTo(map),
    };
    map.getContainer().classList.add('drawing-route');
    // Interceptamos los clics en FASE DE CAPTURA en el contenedor del mapa.
    // Así llegan a nuestro handler antes de que cualquier polígono Leaflet
    // (TSA / TMA / aerovía) los consuma para abrir su popup.
    drawState.clickCapture = function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.leaflet-control')) return;
      ev.stopPropagation();
      ev.preventDefault();
      if (!drawState) return;
      handleDrawClick({ latlng: map.mouseEventToLatLng(ev) });
    };
    drawState.dblCapture = function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.leaflet-control')) return;
      ev.stopPropagation();
      ev.preventDefault();
      finishDrawingRoute();
    };
    map.getContainer().addEventListener('click', drawState.clickCapture, true);
    map.getContainer().addEventListener('dblclick', drawState.dblCapture, true);
    map.doubleClickZoom.disable();
    redrawDrawing();
    const fitPts = [[opts.origin.lat, opts.origin.lon], [opts.destination.lat, opts.destination.lon]];
    map.fitBounds(L.latLngBounds(fitPts), { padding: [60, 60] });
  }

  function finishDrawingRoute() {
    if (!drawState) return;
    const pts = drawState.points.slice();
    const cb = drawState.onFinish;
    teardownDrawing();
    if (cb) cb(pts);
  }

  function cancelDrawingRoute(silent) {
    if (!drawState) return;
    const cb = drawState.onCancel;
    teardownDrawing();
    if (!silent && cb) cb();
  }

  function undoDrawingPoint() {
    if (!drawState || !drawState.points.length) return;
    drawState.points.pop();
    redrawDrawing();
    if (drawState.onUpdate) drawState.onUpdate(drawState.points.slice());
  }

  function teardownDrawing() {
    if (!drawState) return;
    if (drawState.clickCapture) {
      map.getContainer().removeEventListener('click', drawState.clickCapture, true);
    }
    if (drawState.dblCapture) {
      map.getContainer().removeEventListener('dblclick', drawState.dblCapture, true);
    }
    map.doubleClickZoom.enable();
    map.getContainer().classList.remove('drawing-route');
    if (drawState.layer) drawState.layer.remove();
    drawState = null;
  }

  function handleDrawClick(e) {
    if (!drawState) return;
    const lat = e.latlng.lat, lon = e.latlng.lng;
    // Detección de TSA (prioritaria sobre snap a waypoint).
    const tsa = findTSAAt([lat, lon], drawState.tsas);
    let pt;
    if (tsa) {
      pt = {
        name: tsa.name,
        lat, lon,
        tsa,
        fl: adjustFLForTSA(drawState.initialFL, tsa),
      };
    } else if (drawState.snapKm > 0) {
      const snap = nearestWaypoint([lat, lon], drawState.snapKm);
      pt = snap
        ? { name: snap.name, lat: snap.lat, lon: snap.lon, tsa: null, fl: drawState.initialFL }
        : { name: null, lat, lon, tsa: null, fl: drawState.initialFL };
    } else {
      pt = { name: null, lat, lon, tsa: null, fl: drawState.initialFL };
    }
    drawState.points.push(pt);
    redrawDrawing();
    if (drawState.onUpdate) drawState.onUpdate(drawState.points.slice());
  }

  function findTSAAt(latlon, tsas) {
    if (!tsas) return null;
    for (const tsa of tsas) {
      if (pointInPoly(latlon, tsa.polygon)) return tsa;
    }
    return null;
  }

  function pointInPoly(pt, poly) {
    let inside = false;
    const x = pt[1], y = pt[0];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][1], yi = poly[i][0];
      const xj = poly[j][1], yj = poly[j][0];
      const cond = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (cond) inside = !inside;
    }
    return inside;
  }

  // El vuelo cruza la TSA manteniéndose dentro de su banda vertical con
  // 500 ft de margen respecto al techo y al suelo. Conserva el FL inicial
  // si ya está dentro; si no, lo recorta al extremo más cercano.
  function adjustFLForTSA(initialFL, tsa) {
    if (!tsa || !tsa.vertical) return initialFL;
    const lowerFt = tsa.vertical.lowerFt;
    const upperFt = tsa.vertical.upperFt;
    let flMin = Math.ceil((lowerFt + 500) / 500) * 5;
    let flMax = Math.floor((upperFt - 500) / 500) * 5;
    if (flMax < flMin) {
      flMin = Math.ceil(lowerFt / 500) * 5;
      flMax = Math.floor(upperFt / 500) * 5;
      if (flMax < flMin) return Math.round((lowerFt + upperFt) / 1000) * 5;
    }
    if (initialFL < flMin) return flMin;
    if (initialFL > flMax) return flMax;
    return initialFL;
  }

  function redrawDrawing() {
    if (!drawState) return;
    drawState.layer.clearLayers();
    const seq = [drawState.origin].concat(drawState.points).concat([drawState.destination]);
    const ll = seq.map(p => [p.lat, p.lon]);
    L.polyline(ll, { color: '#1f2937', weight: 7, opacity: 0.30, pane: 'routePane' }).addTo(drawState.layer);
    L.polyline(ll, { color: '#fbbf24', weight: 3, opacity: 0.95, dashArray: '5 4', pane: 'routePane' }).addTo(drawState.layer);
    seq.forEach((p, i) => {
      const isExtreme = i === 0 || i === seq.length - 1;
      const isTSA = !!p.tsa;
      const m = L.circleMarker([p.lat, p.lon], {
        radius: isExtreme ? 6 : 5,
        color: isTSA ? '#dc2626' : '#1f2937',
        fillColor: isTSA ? '#dc2626' : (isExtreme ? '#fbbf24' : '#fde68a'),
        fillOpacity: 1, weight: 1.5,
        pane: 'routePane',
      }).addTo(drawState.layer);
      const baseName = p.name || (p.lat.toFixed(3) + ',' + p.lon.toFixed(3));
      const label = p.fl ? baseName + ' · F' + p.fl : baseName;
      m.bindTooltip(label, { direction: 'top', offset: [0, -4] });
      L.tooltip({
        permanent: true, direction: 'right', offset: [6, 0],
        className: 'route-label' + (isExtreme ? ' extreme' : '') + (isTSA ? ' tsa' : ''),
        interactive: false,
      }).setLatLng([p.lat, p.lon]).setContent(label).addTo(drawState.layer);
    });
  }

  function nearestWaypoint(latlon, maxKm) {
    const aw = window.TSAgestor.airways;
    if (!aw || !aw.waypoints) return null;
    let best = null, bestD = Infinity;
    for (const [name, pt] of Object.entries(aw.waypoints)) {
      const d = window.TSAgestor.geom.greatCircleDistance(latlon, pt);
      if (d < bestD) { bestD = d; best = { name, lat: pt[0], lon: pt[1] }; }
    }
    return best && bestD <= maxKm ? best : null;
  }

  return {
    init, render, fitBounds, invalidateSize, fitToDefault,
    renderFlightPlan, clearFlightPlan,
    startDrawingRoute, finishDrawingRoute, cancelDrawingRoute, undoDrawingPoint,
    setWeatherMarkers, clearWeatherMarkers,
  };
})();
