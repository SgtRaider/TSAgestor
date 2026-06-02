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

  // Duracion de la interpolacion suave entre dos snapshots ADS-B.
  // Ligeramente inferior al periodo de refresco (10 s) para que cuando
  // llegue el siguiente tick el avion ya este donde realmente esta,
  // sin "rebote" hacia atras.
  const ANIM_MS = 9500;

  let _map = null;
  let _layer = null;
  let _center = null;     // [lat, lon] del aerodromo seleccionado
  let _icao = null;       // ICAO actualmente activo
  let _timer = null;      // setInterval id del polling
  let _aborter = null;    // AbortController del fetch en curso
  let _markers = new Map();   // hex -> { marker, rotation, altBand, anim }
  let _trails  = new Map();   // hex -> { points: [[lat,lon,tsMs],...], line: L.polyline, altBand }
  let _animFrame = null;      // id de requestAnimationFrame activo (o null)
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
    emitStatus(`Iniciando trafico ${RADIUS_NM} NM alrededor de ${_icao}…`, 'loading');
    // Dibujamos un circulo guia con el radio para que el usuario vea
    // el area cubierta.
    _drawRangeRing(lat, lon, RADIUS_NM);
    // Fetch inmediato y luego cada REFRESH_MS.
    _fetchAndRender();
    _timer = setInterval(_fetchAndRender, REFRESH_MS);
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_aborter) { try { _aborter.abort(); } catch (_) {} _aborter = null; }
    if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
    if (_layer) _layer.clearLayers();
    _markers.clear();
    _trails.clear();
    _icao = null;
    _center = null;
    emitStatus('', null);
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
    if (_aborter) { try { _aborter.abort(); } catch (_) {} }
    _aborter = new AbortController();
    const url = `${API_BASE}/point/${_center[0]}/${_center[1]}/${RADIUS_NM}`;
    let data;
    try {
      const res = await fetch(url, { signal: _aborter.signal });
      if (!res.ok) {
        emitStatus(`Error API ${res.status}`, 'error');
        return;
      }
      data = await res.json();
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('[traffic] fetch fallo:', e);
      emitStatus('Fallo de red al consultar trafico.', 'error');
      return;
    }
    const aircraft = Array.isArray(data && data.ac) ? data.ac : [];
    _renderAircraft(aircraft);
    const tStamp = new Date().toISOString().slice(11, 19) + 'Z';
    emitStatus(`${aircraft.length} aviones a ≤${RADIUS_NM} NM · ult. ${tStamp}`, 'ok');
  }

  // Dibuja o actualiza los markers. La posicion se interpola en
  // requestAnimationFrame durante ~9.5 s desde la ultima conocida
  // hasta la nueva, para que la traza y el icono se muevan suave
  // entre snapshots ADS-B (cada 10 s seria un salto visible).
  function _renderAircraft(list) {
    if (!_layer) return;
    const now = Date.now();
    const seen = new Set();
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
        // Programamos animacion desde la posicion CURRENTLY-DISPLAYED
        // (no la del snapshot anterior) hasta la nueva. Asi si llega
        // un tick antes de que termine la animacion previa, el avion
        // arranca el nuevo tramo donde realmente esta visualmente.
        const curLL = entry.marker.getLatLng();
        entry.anim = {
          fromLat: curLL.lat, fromLon: curLL.lng,
          toLat:   ac.lat,    toLon:   ac.lon,
          t0Ms:    now,
          durMs:   ANIM_MS,
        };
        // Rotacion y color via DOM directo (sin setIcon -> sin rebuild,
        // sin perdida de animaciones CSS internas).
        if (Math.abs((entry.rotation || 0) - track) > 1) {
          _setMarkerRotation(entry.marker, track);
          entry.rotation = track;
        }
        if (entry.altBand !== altBand) {
          _setMarkerColor(entry.marker, altBand);
          entry.altBand = altBand;
        }
        _setTooltipContent(entry.marker, tooltip);
        if (entry.marker._popup) entry.marker._popup.setContent(popup);
      } else {
        const m = L.marker([ac.lat, ac.lon], {
          icon: _planeIcon(track, altBand),
        });
        m.bindTooltip(tooltip, { direction: 'top', offset: [0, -8], className: 'traffic-tt' });
        m.bindPopup(popup, { maxWidth: 280 });
        m.addTo(_layer);
        // No animamos el primer fix (no hay posicion previa); cuando
        // llegue el siguiente, _animLoop tomara esta posicion como
        // origen y la nueva como destino.
        _markers.set(ac.hex, {
          marker: m, rotation: track, altBand,
          anim: null,
        });
      }
      // Actualiza la traza (path de los ultimos 5 min). Usamos la
      // posicion REAL del snapshot, no la interpolada — los puntos
      // de la traza son mediciones ADS-B.
      _updateTrail(ac.hex, ac.lat, ac.lon, now, altBand);
    }
    // Elimina markers y trazas de aviones que ya no estan en el radio.
    for (const [hex, entry] of _markers) {
      if (!seen.has(hex)) {
        _layer.removeLayer(entry.marker);
        _markers.delete(hex);
      }
    }
    for (const [hex, t] of _trails) {
      if (!seen.has(hex)) {
        if (t.line) _layer.removeLayer(t.line);
        _trails.delete(hex);
      }
    }
    // Arranca el loop si hay animaciones pendientes y no esta corriendo.
    if (!_animFrame && _markers.size > 0) {
      _animFrame = requestAnimationFrame(_animTick);
    }
  }

  // Loop de animacion. Cada frame interpola lat/lon de cada marker
  // segun el tiempo transcurrido desde su ultimo snapshot. Para si
  // no hay nada que mover (todos los markers llegaron al destino).
  function _animTick() {
    _animFrame = null;
    const now = Date.now();
    let anyPending = false;
    for (const entry of _markers.values()) {
      const a = entry.anim;
      if (!a) continue;
      const elapsed = now - a.t0Ms;
      const t = Math.min(1, Math.max(0, elapsed / a.durMs));
      // Easing lineal — los aviones siguen rumbos cuasi-rectos a
      // velocidad constante en escalas de 10 s; lineal es lo correcto.
      const lat = a.fromLat + (a.toLat - a.fromLat) * t;
      const lon = a.fromLon + (a.toLon - a.fromLon) * t;
      entry.marker.setLatLng([lat, lon]);
      if (t < 1) anyPending = true;
      else entry.anim = null;
    }
    if (anyPending) {
      _animFrame = requestAnimationFrame(_animTick);
    }
  }

  // Aplica la rotacion sobre el elemento interno del icono via DOM.
  // No usamos setIcon porque eso rebuildea el DOM entero del marker y
  // pierde la animacion / posicion fluida.
  function _setMarkerRotation(marker, track) {
    const el = marker.getElement && marker.getElement();
    if (!el) return;
    const inner = el.querySelector('.traffic-plane');
    if (inner) inner.style.transform = 'rotate(' + track + 'deg)';
  }

  function _setMarkerColor(marker, altBand) {
    const el = marker.getElement && marker.getElement();
    if (!el) return;
    const path = el.querySelector('.traffic-plane svg path');
    if (path) path.setAttribute('fill', _trailColor(altBand));
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
        opacity: 0.65,
        interactive: false,
        dashArray: '4 3',
        className: 'traffic-trail',
      });
      entry.line.addTo(_layer);
      entry.altBand = altBand;
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
