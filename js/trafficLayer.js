// Capa de trafico aereo en tiempo real sobre el mapa.
//
// Fuente: airplanes.live REST API (https://airplanes.live/api-guide/).
// Endpoint usado: GET /v2/point/{lat}/{lon}/{radiusNM}
// Limites: radio <=250 NM, 1 req/s. Refrescamos cada 10 s asi entramos
// muy holgados. La API tiene CORS abierto (Access-Control-Allow-Origin
// *) asi que no hace falta proxy.
//
// La capa NO es persistente: solo vive mientras el usuario tenga la
// caja activa con un ICAO valido. Se para al desactivarla o al cambiar
// de pestania (no aplicable por simple ahora — el polling sigue).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.trafficLayer = (function () {
  'use strict';

  const API_BASE = 'https://api.airplanes.live/v2';
  const REFRESH_MS = 10000;
  const RADIUS_NM = 100;
  // Ventana de traza por avion: conservamos los puntos de posicion de
  // los ultimos 5 min para dibujar el path detras del marker.
  const TRAIL_MS = 5 * 60 * 1000;

  let _map = null;
  let _layer = null;
  let _center = null;     // [lat, lon] del aerodromo seleccionado
  let _icao = null;       // ICAO actualmente activo
  let _timer = null;      // setInterval id del polling
  let _markers = new Map();   // hex -> { marker, rotation, altBand }
  let _trails  = new Map();   // hex -> { points: [[lat,lon,tsMs],...], line: L.polyline, altBand }
  let _statusEl = null;
  let _onStateChange = null;  // callback(state) -> emite al UI

  function init(map) {
    _map = map;
    if (_map && !_layer) {
      _layer = L.layerGroup().addTo(_map);
    }
  }

  function isRunning() { return !!_timer; }

  function getStatus() {
    return {
      running: isRunning(),
      icao: _icao,
      center: _center,
      count: _markers.size,
    };
  }

  function setStatusElement(el) { _statusEl = el; }
  function setOnStateChange(fn) { _onStateChange = fn; }

  function emitStatus(msg, kind) {
    if (_statusEl) {
      _statusEl.textContent = msg || '';
      _statusEl.className = 'traffic-status' + (kind ? ' traffic-status-' + kind : '');
    }
    if (_onStateChange) {
      try { _onStateChange(getStatus()); } catch (_) {}
    }
  }

  // Inicia el polling para un ICAO + coords centro. Si ya hay otro
  // activo, lo para primero. El ICAO se acepta tal cual del input;
  // las coords se resuelven en el caller (app.js usa airways.waypoints).
  function start(icao, lat, lon) {
    stop();
    if (!_layer) {
      console.warn('[traffic] init() no llamado antes de start()');
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      emitStatus('Coordenadas invalidas para ' + icao, 'error');
      return;
    }
    _icao = String(icao || '').trim().toUpperCase();
    _center = [lat, lon];
    console.info('[traffic] start', { icao: _icao, lat, lon, radiusNM: RADIUS_NM });
    emitStatus(`Iniciando trafico ${RADIUS_NM} NM alrededor de ${_icao}…`, 'loading');
    // Dibujamos un circulo guia con el radio para que el usuario vea
    // el area cubierta.
    _drawRangeRing(lat, lon, RADIUS_NM);
    // Fetch inmediato y luego cada REFRESH_MS.
    _fetchAndRender();
    _timer = setInterval(_fetchAndRender, REFRESH_MS);
    console.info('[traffic] polling iniciado, intervalo ' + REFRESH_MS + ' ms');
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_layer) _layer.clearLayers();
    _markers.clear();
    _trails.clear();
    _icao = null;
    _center = null;
    emitStatus('', null);
    console.info('[traffic] stop()');
  }

  function _drawRangeRing(lat, lon, radiusNM) {
    if (!_layer) return;
    // Conversion grados-NM aproximada para la lat de Iberia/Canarias.
    const radiusKm = radiusNM * 1.852;
    const ring = L.circle([lat, lon], {
      radius: radiusKm * 1000,
      color: '#fac200',
      weight: 1.5,
      dashArray: '6 4',
      fill: false,
      interactive: false,
    });
    ring.addTo(_layer);
    // Marca del aerodromo en el centro.
    const adIcon = L.divIcon({
      className: 'traffic-ad-marker',
      html: `<div class="ad-pin"><span>${_icao}</span></div>`,
      iconSize: [44, 22],
      iconAnchor: [22, 11],
    });
    L.marker([lat, lon], { icon: adIcon, interactive: false }).addTo(_layer);
  }

  async function _fetchAndRender() {
    if (!_center) return;
    // No abortamos en cada tick: dejamos que un fetch lento termine,
    // setInterval seguira disparando el siguiente. Solo abortamos en
    // stop(). Asi evitamos el caso "todos los fetch quedan abortados
    // por el siguiente tick" que producia silencios sin datos.
    const url = `${API_BASE}/point/${_center[0]}/${_center[1]}/${RADIUS_NM}`;
    console.info('[traffic] fetch', url);
    let data;
    try {
      // cache:'no-store' impide que la HTTP cache del navegador devuelva
      // una respuesta vieja. La invalidacion del SW se hace via
      // NETWORK_FIRST_HOSTS en sw.js — esto es belt-and-suspenders.
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        console.warn('[traffic] HTTP', res.status);
        emitStatus(`Error API ${res.status}`, 'error');
        return;
      }
      data = await res.json();
    } catch (e) {
      console.warn('[traffic] fetch fallo:', e);
      emitStatus('Fallo de red al consultar trafico.', 'error');
      return;
    }
    const raw = Array.isArray(data && data.ac) ? data.ac : [];
    // Filtro arrival/departure del aerodromo seleccionado. airplanes.live
    // solo entrega telemetria ADS-B (posicion/altitud/track), no el plan
    // de vuelo, asi que inferimos por rumbo + tasa baro + distancia. Los
    // overflights en crucero se descartan; quedan los que estan
    // interactuando con el aeropuerto.
    const aircraft = raw.filter(ac => _isArrivalOrDeparture(ac, _center[0], _center[1]));
    console.info('[traffic] respuesta:', raw.length, 'aviones (radius 100 NM), filtrados arr/dep:', aircraft.length);
    _renderAircraft(aircraft);
    const tStamp = new Date().toISOString().slice(11, 19) + 'Z';
    emitStatus(`${aircraft.length} arr/dep · ${raw.length} en ${RADIUS_NM} NM · ult. ${tStamp}`, 'ok');
  }

  // Decide si un avion ADS-B es arrival/departure del aerodromo
  // centro. Heuristica (sin flight plan disponible en airplanes.live):
  //
  //  1) Dentro de 20 NM y bajo FL200 -> SI (zona TMA tipica).
  //  2) Crucero (>=FL250 con baro_rate plano) -> NO (overflight).
  //  3) Descendiendo y rumbo hacia el aerodromo (<60° de diff) -> SI (arrival).
  //  4) Ascendiendo y rumbo desde el aerodromo (<60° de diff) -> SI (departure).
  //  5) Resto -> NO.
  //
  // Sin track o sin distancia no podemos clasificar; fallback a SI dentro
  // de 30 NM (probable trafico local) y NO fuera.
  function _isArrivalOrDeparture(ac, centerLat, centerLon) {
    if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return false;
    const geom = window.TSAgestor && window.TSAgestor.geom;
    if (!geom) return true;  // sin geom modulo: no podemos filtrar, no excluyas
    const distKm = geom.greatCircleDistance([ac.lat, ac.lon], [centerLat, centerLon]);
    const distNM = distKm / 1.852;
    const altFt = Number.isFinite(ac.alt_baro) ? ac.alt_baro : null;
    const climbing   = Number.isFinite(ac.baro_rate) && ac.baro_rate >  300;
    const descending = Number.isFinite(ac.baro_rate) && ac.baro_rate < -300;
    const cruising   = !climbing && !descending;

    // 1) Muy cerca + bajo: trafico de aerodromo. Incluye GA, helos, etc.
    if (distNM < 20 && (altFt == null || altFt < 20000)) return true;
    // 2) Crucero alto pasando por encima -> overflight, no es para nosotros.
    if (altFt != null && altFt >= 25000 && cruising) return false;

    if (!Number.isFinite(ac.track)) {
      // Sin rumbo: aproximacion conservadora por distancia.
      return distNM < 30;
    }
    // Rumbo del segmento aerodromo -> avion (hacia donde "esta" el avion).
    const bearingFromAirport = geom.bearing([centerLat, centerLon], [ac.lat, ac.lon]);
    const diffAway   = _absAngleDiff(ac.track, bearingFromAirport);                  // arrumbado hacia fuera
    const diffToward = _absAngleDiff(ac.track, (bearingFromAirport + 180) % 360);    // arrumbado hacia dentro

    // 3) Descendiendo y arrumbado al aerodromo -> arrival.
    if (descending && diffToward < 60) return true;
    // 4) Ascendiendo y alejandose -> departure.
    if (climbing && diffAway < 60) return true;
    // 5) Si esta a media altitud cerca y arrumbado al aerodromo, lo
    //    aceptamos como vector de aproximacion (controlador podria
    //    estarlo guiando).
    if (distNM < 40 && altFt != null && altFt < 15000 && diffToward < 70) return true;
    return false;
  }

  function _absAngleDiff(a, b) {
    let d = ((a - b) % 360 + 540) % 360 - 180;
    return Math.abs(d);
  }

  // Dibuja o actualiza los markers. setLatLng() directo en cada
  // snapshot (sin interpolacion). El icono se REGENERA con setIcon
  // cuando cambia track o altBand, asi aseguramos que la rotacion
  // se aplica via Leaflet (en vez de manipular el DOM, que rompia en
  // algunos casos al re-renderizar el marker).
  function _renderAircraft(list) {
    if (!_layer) return;
    const now = Date.now();
    const seen = new Set();
    let added = 0, updated = 0, removed = 0;
    for (const ac of list) {
      // El hex es la clave; sin el se mezclan aviones distintos.
      if (!ac.hex) continue;
      if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) continue;
      seen.add(ac.hex);
      const entry = _markers.get(ac.hex);
      const track = Number.isFinite(ac.track) ? ac.track : 0;
      const altFt = Number.isFinite(ac.alt_baro) ? ac.alt_baro : null;
      const altBand = _altitudeBand(altFt);
      const tooltip = _buildTooltip(ac);
      const popup = _buildPopup(ac);
      if (entry) {
        entry.marker.setLatLng([ac.lat, ac.lon]);
        if (Math.abs((entry.rotation || 0) - track) > 1 || entry.altBand !== altBand) {
          entry.marker.setIcon(_planeIcon(track, altBand));
          entry.rotation = track;
          entry.altBand = altBand;
        }
        _setTooltipContent(entry.marker, tooltip);
        if (entry.marker._popup) entry.marker._popup.setContent(popup);
        updated++;
      } else {
        const m = L.marker([ac.lat, ac.lon], {
          icon: _planeIcon(track, altBand),
        });
        m.bindTooltip(tooltip, { direction: 'top', offset: [0, -8], className: 'traffic-tt' });
        m.bindPopup(popup, { maxWidth: 280 });
        m.addTo(_layer);
        _markers.set(ac.hex, { marker: m, rotation: track, altBand });
        added++;
      }
      // Actualiza la traza (path de los ultimos 5 min).
      _updateTrail(ac.hex, ac.lat, ac.lon, now, altBand);
    }
    // Elimina markers y trazas de aviones que ya no estan en el radio.
    for (const [hex, entry] of _markers) {
      if (!seen.has(hex)) {
        _layer.removeLayer(entry.marker);
        _markers.delete(hex);
        removed++;
      }
    }
    for (const [hex, t] of _trails) {
      if (!seen.has(hex)) {
        if (t.line) _layer.removeLayer(t.line);
        _trails.delete(hex);
      }
    }
    console.info('[traffic] render: +' + added + ' / =' + updated + ' / -' + removed +
      ' (markers ' + _markers.size + ', trails ' + _trails.size + ')');
  }

  // Acumula los puntos de posicion de cada avion en los ultimos 5 min
  // y mantiene un polyline tras el marker mostrando la traza recorrida.
  // Se omite el punto si esta a < ~10m del anterior (jitter de la
  // fuente ADS-B) para no inflar el array. Se quitan los puntos
  // anteriores al cutoff antes de re-pintar.
  function _updateTrail(hex, lat, lon, nowMs, altBand) {
    let entry = _trails.get(hex);
    if (!entry) {
      entry = { points: [], line: null, altBand };
      _trails.set(hex, entry);
    }
    const cutoff = nowMs - TRAIL_MS;
    // Filtra los puntos viejos (> 5 min).
    if (entry.points.length && entry.points[0][2] < cutoff) {
      entry.points = entry.points.filter(p => p[2] >= cutoff);
    }
    const last = entry.points[entry.points.length - 1];
    const closeEnough = last
      && Math.abs(last[0] - lat) < 0.0001
      && Math.abs(last[1] - lon) < 0.0001;
    if (!closeEnough) entry.points.push([lat, lon, nowMs]);

    // Re-pinta la polilinea. La capa Leaflet acepta setLatLngs sin
    // recrear el objeto, evitando flicker.
    const latlngs = entry.points.map(p => [p[0], p[1]]);
    if (latlngs.length < 2) {
      // Aun no hay traza visible (primer fix); nada que pintar.
      if (entry.line) { _layer.removeLayer(entry.line); entry.line = null; }
      return;
    }
    const color = _trailColor(altBand);
    if (entry.line) {
      entry.line.setLatLngs(latlngs);
      if (entry.altBand !== altBand) {
        entry.line.setStyle({ color });
        entry.altBand = altBand;
      }
    } else {
      entry.line = L.polyline(latlngs, {
        color,
        weight: 2,
        opacity: 0.85,
        interactive: false,
        className: 'traffic-trail',
      });
      entry.line.addTo(_layer);
      entry.altBand = altBand;
      console.info('[traffic] trail nuevo para', hex, 'puntos=', entry.points.length);
    }
  }

  function _trailColor(altBand) {
    // Mismo codigo de color que el icono del avion para que el ojo
    // empareje traza y banda de altitud.
    const map = {
      low:     '#22c55e',
      mid:     '#fac200',
      high:    '#ef4444',
      unknown: '#94a3b8',
    };
    return map[altBand] || map.unknown;
  }

  function _setTooltipContent(marker, html) {
    const tt = marker.getTooltip && marker.getTooltip();
    if (tt && tt.setContent) tt.setContent(html);
  }

  // Banda de altitud para colorear: low <FL100, mid <FL245, high resto.
  function _altitudeBand(alt) {
    if (alt == null) return 'unknown';
    if (alt < 10000) return 'low';
    if (alt < 24500) return 'mid';
    return 'high';
  }

  function _planeIcon(track, altBand) {
    // SVG triangulo apuntando al norte. Rotamos via inline transform.
    // Color por banda de altitud.
    const colorMap = {
      low:     '#22c55e',
      mid:     '#fac200',
      high:    '#ef4444',
      unknown: '#94a3b8',
    };
    const fill = colorMap[altBand] || colorMap.unknown;
    const html = `
      <div class="traffic-plane" style="transform: rotate(${track}deg);">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M12 2 L18 20 L12 16 L6 20 Z"
                fill="${fill}" stroke="#0f172a" stroke-width="1.2"
                stroke-linejoin="round"/>
        </svg>
      </div>`;
    return L.divIcon({
      className: 'traffic-plane-icon',
      html,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  function _buildTooltip(ac) {
    const cs = (ac.flight || '').trim() || ac.hex || '?';
    const alt = Number.isFinite(ac.alt_baro)
      ? (ac.alt_baro >= 18000 ? 'FL' + Math.round(ac.alt_baro / 100) : ac.alt_baro + ' ft')
      : '—';
    const t = ac.t || '';
    return `<b>${cs}</b>${t ? ' · ' + t : ''} · ${alt}`;
  }

  function _buildPopup(ac) {
    const cs = (ac.flight || '').trim() || '—';
    const esc = s => String(s == null ? '—' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const alt = Number.isFinite(ac.alt_baro)
      ? (ac.alt_baro >= 18000 ? 'FL' + Math.round(ac.alt_baro / 100) : ac.alt_baro + ' ft')
      : '—';
    const gs = Number.isFinite(ac.gs) ? Math.round(ac.gs) + ' kt' : '—';
    const track = Number.isFinite(ac.track) ? String(Math.round(ac.track)).padStart(3, '0') + '°' : '—';
    const climb = Number.isFinite(ac.baro_rate)
      ? (ac.baro_rate > 0 ? '↑ ' : '↓ ') + Math.abs(ac.baro_rate) + ' fpm'
      : '—';
    const squawk = ac.squawk ? esc(ac.squawk) : '—';
    return `
      <div class="traffic-popup">
        <div class="traffic-popup-head">
          <b>${esc(cs)}</b>
          ${ac.t ? `<span class="traffic-popup-type">${esc(ac.t)}</span>` : ''}
        </div>
        <div class="traffic-popup-row"><span>Reg:</span> ${esc(ac.r || '—')}</div>
        ${ac.desc ? `<div class="traffic-popup-row"><span>Modelo:</span> ${esc(ac.desc)}</div>` : ''}
        <div class="traffic-popup-row"><span>Altitud:</span> <b>${alt}</b></div>
        <div class="traffic-popup-row"><span>Velocidad:</span> ${gs}</div>
        <div class="traffic-popup-row"><span>Rumbo:</span> ${track}</div>
        <div class="traffic-popup-row"><span>VS:</span> ${climb}</div>
        <div class="traffic-popup-row"><span>Squawk:</span> ${squawk}</div>
        <div class="traffic-popup-row dim">${esc(ac.hex)}</div>
      </div>`;
  }

  return {
    init,
    start,
    stop,
    isRunning,
    getStatus,
    setStatusElement,
    setOnStateChange,
  };
})();
