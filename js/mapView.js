// Vista de mapa Leaflet OFFLINE: usa el dataset bundled en offlineGeo.js
// (Iberia + islas + costas + ciudades + retícula lat/lon) en lugar de tiles
// OSM. Los polígonos TSA se siguen pintando encima en render(tsas).

console.warn('%c[mapView] v87 cargado — filtrado JS por zoom (tier-2≥6, tier-3≥8, NAVAID≥7, RNAV≥8). Llama window.TSAgestor_zoomDebug() para diagnostico.', 'background:#0ea5e9;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold');

// Diagnostico global: imprime estado actual del filtrado por zoom.
window.TSAgestor_zoomDebug = function () {
  const mv = window.TSAgestor && window.TSAgestor.mapView;
  if (!mv) { console.log('mapView no cargado'); return; }
  if (typeof mv._debugZoom === 'function') return mv._debugZoom();
  console.log('Funcion de debug no expuesta');
};

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
  let grametLayer = null;
  let _layersControl = null;
  let legend = null;
  let drawState = null;
  let countryLayer = null;
  // Capas de aerovías y airspace creadas bajo demanda; las guardamos para
  // poder actualizarles la opacidad cuando cambian los ajustes.
  const _vectorLayerGroups = {
    // 4 zonas x 2 cotas = 8 grupos. Las claves siguen el patron `${cota}_${zona}`.
    upper_NE: null, upper_NW: null, upper_SE: null, upper_SW: null,
    lower_NE: null, lower_NW: null, lower_SE: null, lower_SW: null,
    tmas: null, ctrs: null,
  };
  const ZONES = ['NE', 'NW', 'SE', 'SW'];
  let waypointClickHandler = null;

  function setWaypointClickHandler(cb) { waypointClickHandler = cb; }

  function settingsGet(path, fallback) {
    const s = window.TSAgestor && window.TSAgestor.settings;
    return s ? s.get(path, fallback) : fallback;
  }

  // Bounding box que enmarca España peninsular + Baleares + sur de Francia,
  // pensado para ser la vista por defecto cuando no hay TSAs ni ruta.
  const DEFAULT_BOUNDS = [[35.5, -10], [44, 5]];

  // Países colindantes con España (a efectos del mapa). Marruecos esta al
  // otro lado del Estrecho pero comparte espacio aereo cercano (Gibraltar).
  // Argelia se incluye por proximidad a Baleares aunque no sea fronterizo
  // terrestre. Sus capitales se muestran siempre; el resto del mundo solo
  // aparece al hacer zoom.
  const BORDERING_COUNTRIES = new Set([
    'Spain', 'Portugal', 'France', 'Andorra', 'Morocco',
    'United Kingdom', // Gibraltar aparece bajo UK en el dataset.
    'Algeria',
  ]);

  // Filtrado por zoom basado en JS (mas robusto que CSS: anyade/quita el
  // marcador del mapa o de su grupo segun el zoom actual).
  //
  // _cityItems: [{marker, tooltip, tier}]  - tier 1=siempre, 2=zoom>=6, 3=zoom>=8
  // _wpItems:   [{marker, tooltip, type, group}]
  //               type='NAVAID' -> zoom>=7
  //               type='RNAV'   -> zoom>=8
  const _cityItems = [];
  const _wpItems   = [];
  const ZOOM_TIER_2_CITY = 6;
  const ZOOM_TIER_3_CITY = 8;
  const ZOOM_NAVAID      = 7;
  const ZOOM_RNAV        = 8;

  function _applyZoomVisibility() {
    if (!map) return;
    const z = map.getZoom();
    // Ciudades: anyadir/quitar directamente del mapa.
    for (const it of _cityItems) {
      const thresh = it.tier === 1 ? 0
                   : it.tier === 2 ? ZOOM_TIER_2_CITY
                   : ZOOM_TIER_3_CITY;
      const show = z >= thresh;
      if (show) {
        if (!map.hasLayer(it.marker))  it.marker.addTo(map);
        if (!map.hasLayer(it.tooltip)) it.tooltip.addTo(map);
      } else {
        if (map.hasLayer(it.marker))  map.removeLayer(it.marker);
        if (map.hasLayer(it.tooltip)) map.removeLayer(it.tooltip);
      }
    }
    // Waypoints: anyadir/quitar del grupo (el grupo lo controla el toggle
    // de capas. Si el grupo esta en el mapa, anyadir al grupo lo muestra).
    for (const it of _wpItems) {
      const thresh = it.type === 'NAVAID' ? ZOOM_NAVAID : ZOOM_RNAV;
      const show = z >= thresh;
      if (show) {
        if (!it.group.hasLayer(it.marker))  it.group.addLayer(it.marker);
        if (!it.group.hasLayer(it.tooltip)) it.group.addLayer(it.tooltip);
      } else {
        if (it.group.hasLayer(it.marker))  it.group.removeLayer(it.marker);
        if (it.group.hasLayer(it.tooltip)) it.group.removeLayer(it.tooltip);
      }
    }
    console.info('[mapView] zoom=' + z + ' visibles -> ciudades:'
      + _cityItems.filter(i => map.hasLayer(i.marker)).length + '/' + _cityItems.length
      + ' waypoints:' + _wpItems.filter(i => i.group.hasLayer(i.marker)).length + '/' + _wpItems.length);
  }

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
    _initSettingsHook();
    _applyZoomVisibility();
    map.on('zoomend', _applyZoomVisibility);
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
    if (aw && aw.airwayZones && aw.waypointZones) {
      // Una capa por (cota, zona). Cada capa contiene sus aerovias + sus
      // waypoints. Click en un waypoint anyade su codigo al campo Via del
      // plan de vuelo (via callback inyectado desde app.js).
      const cotaLabel = (cota) => (cota === 'upper') ? 'alta' : 'baja';
      for (const cota of ['upper', 'lower']) {
        for (const z of ZONES) {
          const ways = (aw.airwayZones[z] || []).filter(a => a.name !== 'DCT');
          const wps  = (aw.waypointZones[z] || []);
          const label = `Aerovías ${cotaLabel(cota)} ${z} (AIP)`;
          const grp = buildZoneAirwayLayer(ways, wps, cota, z);
          overlays[label] = grp;
          _vectorLayerGroups[`${cota}_${z}`] = grp;
        }
      }
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
    _vectorLayerGroups.tmas = overlays['TMAs (demo)'] || null;
    _vectorLayerGroups.ctrs = overlays['CTRs (demo)'] || null;
    if (Object.keys(overlays).length === 0) return;
    // Por defecto NO activamos ninguna zona: el mapa queda limpio. El
    // planificador interpreta "ninguna zona activa" como "usa toda la red"
    // (ver getAirwayLayerState abajo) para no romper el routing.
    _layersControl = L.control.layers(null, overlays, { position: 'topleft', collapsed: false }).addTo(map);
  }

  // Toggle del control de capas (boton "Capas" en la toolbar del mapa).
  // Al ocultar, conserva el control con sus checkboxes para no perder el
  // estado seleccionado por el usuario.
  function setLayersControlVisible(visible) {
    if (!_layersControl || !_layersControl.getContainer) return;
    const el = _layersControl.getContainer();
    if (!el) return;
    el.style.display = visible ? '' : 'none';
  }
  function isLayersControlVisible() {
    if (!_layersControl || !_layersControl.getContainer) return false;
    const el = _layersControl.getContainer();
    return !!el && el.style.display !== 'none';
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
          opacity: settingsGet('opacity.cloudRV', 0.6),
          attribution: attr, maxZoom: 11,
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
          { opacity: settingsGet('opacity.cloudCTH', 0.7), maxZoom: 11, pane: 'meteoTiles' },
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

  // ── Leyenda flotante de TSAs activas ───────────────────────────────
  // Panel scrollable en la esquina top-right del mapa con la lista de
  // TSAs visibles (selección ∩ filtro), su rango vertical y el resumen
  // de horario. Es un toggle: al activar se anyade el control, al
  // desactivar se elimina. updateLegend() refresca el contenido sin
  // tocar el estado de visibilidad (lo llama app.js cuando cambia la
  // seleccion o el filtro).
  let tsaLegendCtl = null;
  let tsaLegendTSAs = [];

  // Ventana [hoy 00:00 UTC, pasado-manyana 00:00 UTC) = 48h de calendario.
  function todayPlusTomorrowUTC() {
    const now = new Date();
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return { startMs, endMs: startMs + 2 * 86400000 };
  }

  // Filtra TSAs y sus schedules para mostrar solo lo que cae en hoy+manyana.
  function filterForTodayAndTomorrow(tsas) {
    const { startMs, endMs } = todayPlusTomorrowUTC();
    const out = [];
    for (const t of tsas) {
      const inWindow = (t.schedules || []).filter(s =>
        s.startUTC.getTime() < endMs && s.endUTC.getTime() > startMs
      );
      if (inWindow.length) out.push(Object.assign({}, t, { schedules: inWindow }));
    }
    return out;
  }

  function buildTSALegendHTML(tsas) {
    const filtered = filterForTodayAndTomorrow(tsas);
    const win = todayPlusTomorrowUTC();
    const winLabel = (() => {
      const a = new Date(win.startMs);
      const b = new Date(win.endMs - 86400000);  // ultimo dia inclusivo
      const fmtDate = d => `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
      return `${fmtDate(a)} – ${fmtDate(b)} UTC`;
    })();
    if (!filtered.length) {
      return `
        <div class="tsa-legend-head">TSAs activas hoy &amp; mañana <span class="tsa-legend-count">0</span></div>
        <div class="tsa-legend-empty"><i>Ninguna TSA activa hoy o mañana</i><br><span class="tsa-legend-window">${winLabel}</span></div>`;
    }
    const fmt = window.TSAgestor.scheduleFmt;
    // Agrupamiento visual por prefijo de nombre + misma banda vertical +
    // mismo schedule (TSA CORREDOR SUR 4/5/6 -> "TSA CORREDOR SUR 4-6").
    const groups = groupTSAsForLegend(filtered);
    const groupCount = groups.length;
    const tsaCount = filtered.length;
    const rows = groups.map(g => {
      const t = g.tsas[0]; // representante (misma vertical y schedule)
      const band = geom.altitudeBand(t.vertical.upperFt);
      const color = BAND_COLORS[band];
      const schedTxt = fmt ? fmt.listText(t.schedules).join(' · ') : '';
      const name = formatGroupNameLocal(g);
      const countBadge = g.tsas.length > 1
        ? `<span class="tsa-legend-group-count" title="${g.tsas.length} TSAs agrupadas">${g.tsas.length}</span>`
        : '';
      return `
        <div class="tsa-legend-row">
          <span class="tsa-legend-swatch" style="background:${color}"></span>
          <div class="tsa-legend-text">
            <div class="tsa-legend-name">${escapeHTMLLocal(name)} ${countBadge}</div>
            <div class="tsa-legend-alt">${escapeHTMLLocal(t.vertical.lowerLabel)} – ${escapeHTMLLocal(t.vertical.upperLabel)}</div>
            <div class="tsa-legend-sched">${escapeHTMLLocal(schedTxt)}</div>
          </div>
        </div>`;
    }).join('');
    const countTxt = (groupCount === tsaCount)
      ? `${tsaCount}`
      : `${tsaCount} TSAs · ${groupCount} grupos`;
    return `
      <div class="tsa-legend-head">TSAs activas hoy &amp; mañana <span class="tsa-legend-count">${countTxt}</span></div>
      <div class="tsa-legend-window-bar">${winLabel}</div>
      <div class="tsa-legend-body">${rows}</div>`;
  }

  // Helpers de agrupamiento local (mismos criterios que app.js):
  //   - mismo prefijo de nombre (sin el ultimo token)
  //   - misma banda vertical (lower/upper labels)
  //   - mismo schedule
  function groupTSAsForLegend(tsas) {
    const buckets = new Map();
    const order = [];
    for (const t of tsas) {
      const ls = t.name.lastIndexOf(' ');
      let prefix, suffix;
      if (ls < 0 || ls === t.name.length - 1) { prefix = t.name; suffix = null; }
      else { prefix = t.name.slice(0, ls); suffix = t.name.slice(ls + 1); }
      // Solo agrupamos si el prefijo tiene >=2 tokens (al menos "TSA NOMBRE").
      // Asi evitamos agrupar TSAs sin relacion que solo comparten "TSA".
      const prefixTokens = prefix.split(/\s+/).filter(Boolean);
      const canGroup = suffix != null && prefixTokens.length >= 2;
      const schedSig = (t.schedules || []).map(s =>
        (s.startUTC && s.startUTC.getTime ? s.startUTC.getTime() : 0) + '-' +
        (s.endUTC   && s.endUTC.getTime   ? s.endUTC.getTime()   : 0)
      ).join(',');
      const key = !canGroup
        ? '__single__|' + (t.id || t.name)
        : prefix + '||' + (t.vertical.lowerLabel || '') + '||' + (t.vertical.upperLabel || '') + '||' + schedSig;
      if (!buckets.has(key)) { buckets.set(key, { prefix, suffixes: [], tsas: [] }); order.push(key); }
      const g = buckets.get(key);
      g.tsas.push(t);
      if (canGroup) g.suffixes.push(suffix);
    }
    return order.map(k => buckets.get(k));
  }
  function formatGroupNameLocal(g) {
    if (g.tsas.length === 1) return g.tsas[0].name;
    if (!g.suffixes.length) return g.prefix;
    const sorted = g.suffixes.slice().sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
    const allNum = sorted.every(s => /^\d+$/.test(s));
    const allLet = sorted.every(s => /^[A-Z]$/.test(s));
    let consecutive = false;
    if (allNum && sorted.length >= 2) {
      consecutive = sorted.every((s, i) => i === 0 || Number(s) === Number(sorted[i - 1]) + 1);
    } else if (allLet && sorted.length >= 2) {
      consecutive = sorted.every((s, i) => i === 0 || s.charCodeAt(0) === sorted[i - 1].charCodeAt(0) + 1);
    }
    if (consecutive) return `${g.prefix} ${sorted[0]}–${sorted[sorted.length - 1]}`;
    return `${g.prefix} ${sorted.join(', ')}`;
  }

  // Ajusta dinamicamente max-height del panel a la PORCION VISIBLE del
  // mapa dentro del viewport (no a map.getSize().y, que devuelve la altura
  // del div del mapa: si el #map tiene min-height fijo y el viewport es
  // pequenyo, el div se sale del viewport y la leyenda lo seguia, dejando
  // filas inferiores inalcanzables). Restamos margen para la attribution
  // de Leaflet y aire visual.
  function fitLegendToMap() {
    if (!tsaLegendCtl || !map) return;
    const cont = tsaLegendCtl.getContainer();
    if (!cont) return;
    const r = map.getContainer().getBoundingClientRect();
    const top = Math.max(0, r.top);
    const bottom = Math.min(window.innerHeight, r.bottom);
    const visible = Math.max(0, bottom - top);
    const margin = 30;
    cont.style.maxHeight = Math.max(120, visible - margin) + 'px';
  }

  // Calcula el ancho inicial del panel de leyenda en funcion del numero de
  // grupos visibles: pocas TSAs -> menos columnas -> panel mas estrecho,
  // dejando mas mapa visible. El usuario puede ampliar/reducir despues
  // arrastrando la esquina inferior derecha (CSS resize:both).
  // 240 px aproxima una celda; cada nueva columna anyade ese ancho.
  function pickInitialLegendWidth(groupCount) {
    if (groupCount <= 5)  return 240;   // 1 col
    if (groupCount <= 12) return 480;   // 2 cols
    return 720;                          // 3 cols (limite)
  }

  function setLegendVisible(visible, tsas) {
    tsaLegendTSAs = tsas || [];
    if (!visible) {
      if (tsaLegendCtl && map) tsaLegendCtl.remove();
      tsaLegendCtl = null;
      if (map) map.off('resize', fitLegendToMap);
      window.removeEventListener('resize', fitLegendToMap);
      return;
    }
    if (!map) return;
    if (tsaLegendCtl) {
      // Refresh contenido. NO tocamos el width: respetamos el resize que
      // el usuario haya podido aplicar manualmente.
      const cont = tsaLegendCtl.getContainer();
      if (cont) cont.innerHTML = buildTSALegendHTML(tsaLegendTSAs);
      fitLegendToMap();
      return;
    }
    tsaLegendCtl = L.control({ position: 'topright' });
    tsaLegendCtl.onAdd = function () {
      const div = L.DomUtil.create('div', 'tsa-legend');
      div.innerHTML = buildTSALegendHTML(tsaLegendTSAs);
      // Ancho inicial proporcional al numero de grupos (1/2/3 cols).
      const groupCount = groupTSAsForLegend(filterForTodayAndTomorrow(tsaLegendTSAs)).length;
      div.style.width = pickInitialLegendWidth(groupCount) + 'px';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    tsaLegendCtl.addTo(map);
    fitLegendToMap();
    // Si el usuario redimensiona la ventana o cambia de pestana, recalc.
    map.on('resize', fitLegendToMap);
    window.addEventListener('resize', fitLegendToMap);
  }

  function updateLegend(tsas) {
    if (!tsaLegendCtl) { tsaLegendTSAs = tsas || []; return; }
    setLegendVisible(true, tsas);
  }

  function isLegendVisible() { return !!tsaLegendCtl; }

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

  // ── Capa de waypoints usados por GRAMET ──────────────────────────────
  // Despues de que Autorouter genera la carta, mostramos en el mapa la
  // ruta efectiva que ha usado (que puede diferir del plan tras decimar
  // a 15 puntos / sustituir TSAs por aeropuertos cercanos / inyectar
  // midpoint en circuitos). Asi el usuario ve QUE puntos se han enviado
  // al servicio y entiende la geometria del chart.
  function ensureGrametLayer() {
    if (!grametLayer) grametLayer = L.layerGroup().addTo(map);
    return grametLayer;
  }
  function setGrametWaypoints(items, opts) {
    if (!map) return;
    const layer = ensureGrametLayer();
    layer.clearLayers();
    if (!items || !items.length) return;
    opts = opts || {};
    const strategy = opts.strategy || '';
    const pts = items.map(it => [it.lat, it.lon]);
    // Polilinea conectora (segmentos de la ruta enviada al servicio).
    if (pts.length >= 2) {
      L.polyline(pts, {
        color: '#7c3aed', weight: 2.5, opacity: 0.85,
        dashArray: '6 4',
      }).bindTooltip('Ruta enviada a GRAMET' + (strategy ? ` (${strategy})` : ''),
        { sticky: true }).addTo(layer);
    }
    // Marcadores numerados.
    items.forEach((it, idx) => {
      const isOriginOrDest = idx === 0 || idx === items.length - 1;
      const marker = L.circleMarker([it.lat, it.lon], {
        radius: isOriginOrDest ? 7 : 5,
        weight: 1.5,
        color: '#4c1d95',
        fillColor: '#a78bfa',
        fillOpacity: 0.95,
        pane: 'markerPane',
      });
      marker.bindTooltip(`${idx + 1}. ${it.name}`, {
        direction: 'top', permanent: true, className: 'gramet-wp-tip', offset: [0, -6],
      });
      marker.bindPopup(
        `<b>GRAMET waypoint #${idx + 1}</b><br>${escapeHTMLLocal(it.name)}` +
        (it.sourceName && it.sourceName !== it.name
          ? `<br><span class="dim">Origen plan: ${escapeHTMLLocal(it.sourceName)}</span>` : '') +
        (strategy ? `<br><span class="dim">Estrategia: ${escapeHTMLLocal(strategy)}</span>` : '')
      );
      layer.addLayer(marker);
    });
    if (!map.hasLayer(layer)) layer.addTo(map);
  }
  function clearGrametWaypoints() {
    if (grametLayer) grametLayer.clearLayers();
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

  // Capa zonal: una de las 8 (cota x zona). Combina aerovias y waypoints
  // de la zona; el click en un waypoint dispara el callback global de plan
  // (anyade el codigo a #plan-via).
  function buildZoneAirwayLayer(airways, waypoints, cota, zone) {
    const group = L.layerGroup();
    const isUpper = cota === 'upper';
    const color = isUpper ? '#7c3aed' : '#0ea5e9';
    const labelClass = 'airway-label ' + (isUpper ? 'upper' : 'lower');
    const cotaTxt = isUpper ? 'alta' : 'baja';
    for (const aw of (airways || [])) {
      const line = L.polyline(aw.points, {
        color, weight: isUpper ? 2.5 : 2, opacity: 0.85,
        dashArray: isUpper ? '8 4' : null,
        pane: 'tsaPane',
      });
      line.bindTooltip(`${aw.name} · ${cotaTxt} · ${zone}`, { sticky: true });
      line.addTo(group);
      const mid = midpointOf(aw.points);
      L.tooltip({
        permanent: true, direction: 'center', className: labelClass, interactive: false,
      }).setLatLng(mid).setContent(aw.name).addTo(group);
    }
    for (const wp of (waypoints || [])) {
      const isNav = wp.type === 'NAVAID';
      const marker = L.circleMarker([wp.lat, wp.lon], {
        radius:       isNav ? 4 : 2.5,
        color:        isNav ? '#a16207' : '#475569',
        weight:       isNav ? 1.5 : 1,
        fillColor:    isNav ? '#facc15' : '#cbd5e1',
        fillOpacity:  0.95,
        pane:         'tsaPane',
      });
      marker.bindTooltip(
        `<b>${wp.id}</b> · ${isNav ? 'NAVAID' : 'RNAV'}<br>${escapeHTMLLocal(wp.name || wp.id)}` +
        `<br><i>Click para añadir al plan</i>`,
        { sticky: true }
      );
      marker.on('click', (ev) => {
        if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
        if (typeof waypointClickHandler === 'function') waypointClickHandler(wp.id);
      });
      const tooltip = L.tooltip({
        permanent: true, direction: 'right', offset: [5, 0],
        className: 'wp-label ' + (isNav ? 'navaid' : 'rnav'),
        interactive: false,
      }).setLatLng([wp.lat, wp.lon]).setContent(wp.id);
      // NO los anyadimos al grupo aqui. _applyZoomVisibility decide en
      // funcion del zoom actual si entran al grupo (y por tanto al mapa
      // cuando el grupo este activo).
      _wpItems.push({ marker, tooltip, type: wp.type, group });
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
    countryLayer = L.geoJSON(geo.countries, {
      style: {
        color: LAND_LINE,
        weight: 0.8,
        fillColor: LAND_FILL,
        fillOpacity: settingsGet('opacity.country', 1.0),
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
      // tier-1 = capital de pais limitrofe (siempre visible)
      // tier-2 = capital de pais lejano (visible desde zoom 6)
      // tier-3 = ciudad no capital, cualquier pais (visible desde zoom 8)
      let tier;
      if (!isCap) tier = 3;
      else if (BORDERING_COUNTRIES.has(city.country)) tier = 1;
      else tier = 2;
      const marker = L.circleMarker([city.lat, city.lon], {
        radius: isCap ? 4 : 2.5,
        color: '#1f2937',
        fillColor: isCap ? '#dc2626' : '#374151',
        fillOpacity: 1,
        weight: 1,
        interactive: false,
        pane: 'markerPane',
      });
      const tooltip = L.tooltip({
        permanent: true,
        direction: 'right',
        offset: [4, 0],
        className: 'city-label' + (isCap ? ' capital' : ''),
      }).setLatLng([city.lat, city.lon]).setContent(city.name);
      _cityItems.push({ marker, tooltip, tier });
    }
    console.info('[mapView] drawCities: ' + _cityItems.length + ' ciudades registradas (filtrado por zoom).');
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

  // Cuando varias TSAs solapan en un punto, Leaflet solo dispara el click
  // en una (la de encima). Aqui combinamos todas las TSAs cuyo poligono
  // contiene la coordenada del click para mostrarlas en un solo popup.
  function buildCombinedPopup(tsas) {
    if (tsas.length === 1) return buildPopup(tsas[0]);
    const head = `<div class="tsa-popup-head"><b>${tsas.length} TSAs en este punto</b></div>`;
    // Ordena por banda altitudinal (lower asc) para que se lean apiladas.
    const sorted = tsas.slice().sort((a, b) => {
      if (a.vertical.lowerFt !== b.vertical.lowerFt) return a.vertical.lowerFt - b.vertical.lowerFt;
      return a.name.localeCompare(b.name);
    });
    const blocks = sorted.map(buildPopup).join(
      '<hr style="margin:6px 0;border:0;border-top:1px dashed #94a3b8">'
    );
    return `<div class="tsa-popup-multi">${head}${blocks}</div>`;
  }

  function render(tsas) {
    if (!map) return;
    layerGroup.clearLayers();
    if (!tsas || tsas.length === 0) return;

    const allLatLngs = [];
    const tsaOpacity = settingsGet('opacity.tsaFill', 0.30);
    // Snapshot del listado para el handler de click (cierra sobre tsas).
    const tsaList = tsas.slice();
    for (const tsa of tsas) {
      const band = geom.altitudeBand(tsa.vertical.upperFt);
      const color = BAND_COLORS[band];
      const poly = L.polygon(tsa.polygon, {
        color, weight: 2, fillColor: color, fillOpacity: tsaOpacity,
        pane: 'tsaPane',
      });
      // En lugar de un popup por poligono (que esconde los solapados),
      // al click recopilamos TODAS las TSAs cuyo poligono contiene el
      // punto y abrimos un popup combinado.
      poly.on('click', e => {
        const latlon = [e.latlng.lat, e.latlng.lng];
        const containing = tsaList.filter(t => pointInPoly(latlon, t.polygon));
        if (!containing.length) return;
        L.popup({ maxWidth: 520, minWidth: 280, autoPan: true })
          .setLatLng(e.latlng)
          .setContent(buildCombinedPopup(containing))
          .openOn(map);
      });
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

  // Aplica las opacidades actuales de settings a TODAS las capas vivas.
  // Llamada al cambiar cualquier ajuste de opacidad.
  function applyOpacities() {
    if (!map) return;
    if (countryLayer) {
      countryLayer.setStyle({ fillOpacity: settingsGet('opacity.country', 1.0) });
    }
    const tsaOp = settingsGet('opacity.tsaFill', 0.30);
    if (layerGroup) {
      layerGroup.eachLayer(l => { if (l.setStyle) l.setStyle({ fillOpacity: tsaOp }); });
    }
    const awOp = settingsGet('opacity.airway', 0.85);
    for (const cota of ['upper', 'lower']) {
      for (const z of ZONES) {
        const grp = _vectorLayerGroups[`${cota}_${z}`];
        if (grp && grp.eachLayer) grp.eachLayer(l => { if (l.setStyle) l.setStyle({ opacity: awOp }); });
      }
    }
    const tmaOp = settingsGet('opacity.tma', 0.06);
    const ctrOp = settingsGet('opacity.ctr', 0.10);
    if (_vectorLayerGroups.tmas) _vectorLayerGroups.tmas.eachLayer(l => { if (l.setStyle) l.setStyle({ fillOpacity: tmaOp }); });
    if (_vectorLayerGroups.ctrs) _vectorLayerGroups.ctrs.eachLayer(l => { if (l.setStyle) l.setStyle({ fillOpacity: ctrOp }); });
    if (cloudRVTile && cloudRVTile.setOpacity) cloudRVTile.setOpacity(settingsGet('opacity.cloudRV', 0.6));
    if (cloudCthTile && cloudCthTile.setOpacity) cloudCthTile.setOpacity(settingsGet('opacity.cloudCTH', 0.7));
    if (routeLayer) {
      const rOp = settingsGet('opacity.route', 0.95);
      routeLayer.eachLayer(l => {
        if (l.setStyle) {
          // Polilíneas amarillas y halos: usamos opacity general; los halos
          // mantienen su opacidad propia más baja.
          if (l.options && l.options.color === '#fbbf24') l.setStyle({ opacity: rOp });
        }
      });
    }
  }

  function _initSettingsHook() {
    const s = window.TSAgestor && window.TSAgestor.settings;
    if (s && s.onChange) {
      s.onChange((path) => {
        if (typeof path === 'string' && (path.startsWith('opacity.') || path === '*')) {
          applyOpacities();
        }
      });
    }
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
      const isSub = !!c.isClimbDescentSub;
      const m = L.circleMarker([c.lat, c.lon], {
        radius: isExtreme ? 6 : (isSub ? 3 : 4),
        color: isSub ? '#7c3aed' : '#1f2937',
        fillColor: isExtreme ? '#fbbf24' : (isSub ? '#c4b5fd' : '#fde68a'),
        fillOpacity: 1, weight: isSub ? 1 : 1.5,
        pane: 'routePane',
      }).addTo(grp);
      const flLabel = Number.isFinite(c.fl) ? ` · FL${String(c.fl).padStart(3, '0')}` : '';
      const tip = c.name + (c.airway && c.airway !== '—' ? ' · ' + c.airway : '') + flLabel;
      m.bindTooltip(tip, { direction: 'top', offset: [0, -4] });
      // Etiqueta permanente solo en waypoints "reales"; los sub-legs de
      // ascenso/descenso saturarian el mapa. Su nombre sale en el tooltip
      // (hover) y en la fila del log.
      if (!isSub) {
        L.tooltip({
          permanent: true, direction: 'right', offset: [6, 0],
          className: 'route-label' + (isExtreme ? ' extreme' : ''),
          interactive: false,
        }).setLatLng([c.lat, c.lon]).setContent(c.name).addTo(grp);
      }
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

  // Anade los waypoints intermedios en orden INVERSO (excepto el ultimo,
  // para no duplicarlo) -> circuito de ida y vuelta. Si el plan es
  // origen->A->B->C->destino, tras "Vuelta" queda
  // origen->A->B->C->B->A->destino. Util cuando origen == destino.
  function addReturnLeg() {
    if (!drawState || drawState.points.length < 1) return 0;
    const reversed = drawState.points.slice().reverse().slice(1); // sin duplicar el actual ultimo
    if (!reversed.length) {
      // Solo hay 1 punto: la "vuelta" trivial seria pasar por el origen
      // de nuevo. Anadimos un waypoint con las coords del origen.
      const o = drawState.origin;
      drawState.points.push({ name: o.name || null, lat: o.lat, lon: o.lon, tsa: null, fl: drawState.initialFL });
    } else {
      for (const p of reversed) {
        // Clonamos para no compartir referencias entre ida y vuelta.
        drawState.points.push({
          name: p.name, lat: p.lat, lon: p.lon, tsa: p.tsa || null, fl: p.fl,
        });
      }
    }
    redrawDrawing();
    if (drawState.onUpdate) drawState.onUpdate(drawState.points.slice());
    return drawState.points.length;
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
    } else {
      // Snap a waypoint solo si al menos uno de los overlays de aerovias
      // esta activado en el control de capas. Asi el usuario controla via
      // checkbox si los clics se imantan a fixes o usan coords exactas.
      const layerState = getAirwayLayerState();
      const snapAllowed = drawState.snapKm > 0 && (layerState.upper || layerState.lower);
      const snap = snapAllowed
        ? nearestWaypoint([lat, lon], drawState.snapKm)
        : null;
      pt = snap
        ? { name: snap.name, lat: snap.lat, lon: snap.lon, tsa: null, fl: drawState.initialFL }
        : { name: null, lat, lon, tsa: null, fl: drawState.initialFL };
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

  // Devuelve el estado REAL de las capas zonales: si al menos una de las 4
  // zonas de cada cota esta activa. El snap del modo dibujo lee esto y solo
  // se imanta a waypoints si el usuario tiene alguna capa visible. El
  // planificador aplica su propio fallback (si todo viene a false, asume
  // toda la red disponible) en flightPlan.js.
  function getAirwayLayerState() {
    if (!map) return { upper: false, lower: false };
    const anyOn = (cota) => ZONES.some(z => {
      const g = _vectorLayerGroups[`${cota}_${z}`];
      return g && map.hasLayer(g);
    });
    return { upper: anyOn('upper'), lower: anyOn('lower') };
  }

  return {
    init, render, fitBounds, invalidateSize, fitToDefault,
    renderFlightPlan, clearFlightPlan,
    startDrawingRoute, finishDrawingRoute, cancelDrawingRoute, undoDrawingPoint, addReturnLeg,
    setWeatherMarkers, clearWeatherMarkers,
    setGrametWaypoints, clearGrametWaypoints,
    applyOpacities,
    getAirwayLayerState,
    setWaypointClickHandler,
    setLegendVisible, updateLegend, isLegendVisible,
    setLayersControlVisible, isLayersControlVisible,
    _debugZoom: function () {
      if (!map) { console.log('mapa no inicializado'); return; }
      const z = map.getZoom();
      const onMap = _cityItems.filter(i => map.hasLayer(i.marker));
      const byTier = [1, 2, 3].map(t => ({
        tier: t,
        total: _cityItems.filter(i => i.tier === t).length,
        visibles: _cityItems.filter(i => i.tier === t && map.hasLayer(i.marker)).length,
      }));
      const wpByType = ['NAVAID', 'RNAV'].map(t => ({
        type: t,
        total: _wpItems.filter(i => i.type === t).length,
        enGrupo: _wpItems.filter(i => i.type === t && i.group.hasLayer(i.marker)).length,
      }));
      console.log('=== TSAgestor zoom debug ===');
      console.log('Zoom actual:', z);
      console.log('Ciudades por tier:', byTier);
      console.log('Waypoints por tipo:', wpByType);
      console.log('Total ciudades en mapa:', onMap.length, '/', _cityItems.length);
      console.log('Umbrales: tier-2 ≥', ZOOM_TIER_2_CITY, '· tier-3 ≥', ZOOM_TIER_3_CITY,
                  '· NAVAID ≥', ZOOM_NAVAID, '· RNAV ≥', ZOOM_RNAV);
    },
  };
})();
