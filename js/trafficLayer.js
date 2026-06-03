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
  // Endpoint historico de tar1090 (~10-15 min de traza). En produccion
  // (Pages) globe.airplanes.live bloquea CORS al browser, asi que vamos
  // via Cloudflare Pages Function en /api/airplanes/trace/<hex> que
  // proxy-fetcha el JSON real con el User-Agent y Referer adecuados.
  // En local (file:// / localhost) pegamos directo (curl con UA decente
  // ya pasa, y no hay funcion Pages disponible).
  const ON_REMOTE = !/^(?:localhost|127\.0\.0\.1)$/i.test(location.hostname) &&
                    location.protocol !== 'file:';
  const TRACE_BASE = ON_REMOTE
    ? '/api/airplanes/trace'
    : 'https://globe.airplanes.live/data/traces';
  const REFRESH_MS = 10000;
  const RADIUS_NM = 100;
  // La traza acumulada por avion: cuando un avion es detectado por
  // primera vez en el polling, se hace fetch de su trace historica
  // (~10-15 min) y se prepende al trail. A partir de ahi, los puntos
  // van entrando en cada refresco. Al salir del radio se borra junto
  // con el marker.

  let _map = null;
  let _layer = null;
  let _center = null;     // [lat, lon] del aerodromo seleccionado
  let _icao = null;       // ICAO actualmente activo
  let _timer = null;      // setInterval id del polling
  let _markers = new Map();   // hex -> { marker, rotation, colorKey }
  let _trails  = new Map();   // hex -> { points: [[lat,lon,tsMs],...], line: L.polyline, colorKey }
  let _tracesFetched = new Set();  // hex de aviones cuya traza ya pedimos
  let _traceQueue = [];            // hex pendientes de fetch (throttle)
  let _traceBusy = false;
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
    _tracesFetched.clear();
    _traceQueue.length = 0;
    _traceBusy = false;
    _icao = null;
    _center = null;
    emitStatus('', null);
    console.info('[traffic] stop()');
  }

  // Encola un hex para fetch de su trace historica. Throttle para no
  // saturar globe.airplanes.live al arrancar (cuando aparecen 16 aviones
  // a la vez): un fetch cada 150 ms = max ~6 req/s. Soft cap, basta
  // para 16 aviones en ~2.4 s.
  function _enqueueTrace(hex) {
    if (_tracesFetched.has(hex)) return;
    _tracesFetched.add(hex);
    _traceQueue.push(hex);
    _drainTraceQueue();
  }
  async function _drainTraceQueue() {
    if (_traceBusy) return;
    _traceBusy = true;
    while (_traceQueue.length) {
      const hex = _traceQueue.shift();
      try { await _fetchTraceFor(hex); } catch (_) {}
      await new Promise(r => setTimeout(r, 150));
    }
    _traceBusy = false;
  }

  async function _fetchTraceFor(hex) {
    if (!hex) return;
    // En remoto: /api/airplanes/trace/<hex> (Pages Function).
    // En local: /<last2>/trace_recent_<hex>.json directo a globe.
    const last2 = hex.slice(-2);
    const url = ON_REMOTE
      ? `${TRACE_BASE}/${hex}`
      : `${TRACE_BASE}/${last2}/trace_recent_${hex}.json`;
    let data;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        console.info('[traffic] trace no disponible para', hex, 'HTTP', res.status);
        return;
      }
      data = await res.json();
    } catch (e) {
      console.warn('[traffic] trace fetch fallo para', hex, ':', e.message);
      return;
    }
    if (!data || !Array.isArray(data.trace) || !data.trace.length) return;
    _prependTraceToTrail(hex, data);
  }

  // Anade los puntos historicos del trace al trail existente.
  // Filtra dos cosas:
  //   1) Tiempo: solo puntos ANTERIORES al primer fix por polling
  //      (para no duplicar lo que ya tenemos).
  //   2) Distancia: solo puntos DENTRO del radio RADIUS_NM del aerodromo.
  //      Asi la traza visible empieza justo cuando el avion entro al
  //      circulo, no desde el aeropuerto de origen real (que puede
  //      estar a cientos de NM).
  function _prependTraceToTrail(hex, traceData) {
    const entry = _trails.get(hex);
    if (!entry) return;
    const baseTsMs = Number(traceData.timestamp || 0) * 1000;
    if (!Number.isFinite(baseTsMs) || baseTsMs <= 0) return;
    const cutoffMs = entry.points.length ? entry.points[0][2] : Infinity;
    const hist = [];
    let outsideRadius = 0;
    for (const p of traceData.trace) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const offsetSec = Number(p[0]);
      const lat = Number(p[1]);
      const lon = Number(p[2]);
      if (!Number.isFinite(offsetSec) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const ts = baseTsMs + offsetSec * 1000;
      if (ts >= cutoffMs) continue;          // ya cubierto por polling
      if (!_withinRadius(lat, lon)) {        // fuera de 100 NM
        outsideRadius++;
        continue;
      }
      hist.push([lat, lon, ts]);
    }
    if (!hist.length) {
      console.info('[traffic] trace para', hex, ': 0 puntos dentro del radio (' + outsideRadius + ' fuera)');
      return;
    }
    entry.points = hist.concat(entry.points);
    console.info('[traffic] trace cargada para', hex, ':+', hist.length,
      'puntos historicos dentro del radio (' + outsideRadius + ' fuera descartados)');
    _redrawTrailLine(entry);
  }

  // Repinta la polilinea del trail tras un cambio (prepend trace).
  // Reutiliza el L.polyline existente si esta o lo crea si hace falta.
  function _redrawTrailLine(entry) {
    const latlngs = entry.points.map(p => [p[0], p[1]]);
    if (latlngs.length < 2) return;
    const color = _colorFor(entry.colorKey || 'unknown');
    if (entry.line) {
      entry.line.setLatLngs(latlngs);
    } else {
      entry.line = L.polyline(latlngs, {
        color,
        weight: 2,
        opacity: entry.colorKey === 'transit' ? 0.45 : 0.85,
        interactive: false,
        className: 'traffic-trail',
      });
      entry.line.addTo(_layer);
    }
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
    // Renderiza TODOS los aviones del radio. La heuristica decide solo
    // el COLOR: los arr/dep van con su banda de altitud (verde/amarillo
    // /rojo), los transitos (overflights, no relacionados con el aero-
    // dromo) van en gris. Si un avion cambia de rumbo y empieza a
    // dirigirse al aerodromo, el siguiente tick lo recolorea solo.
    const arrDepCount = raw.reduce((acc, ac) =>
      acc + (_isArrivalOrDeparture(ac, _center[0], _center[1]) ? 1 : 0), 0);
    console.info('[traffic] respuesta:', raw.length, 'aviones · arr/dep:', arrDepCount);
    _renderAircraft(raw);
    const tStamp = new Date().toISOString().slice(11, 19) + 'Z';
    emitStatus(`${arrDepCount} arr/dep · ${raw.length} total en ${RADIUS_NM} NM · ult. ${tStamp}`, 'ok');
  }

  // Decide si un avion ADS-B esta entrando o saliendo del aerodromo
  // centro. airplanes.live NO entrega origen ni destino del plan de
  // vuelo, asi que combinamos las senales mas fiables:
  //
  //  A) En pista (alt_baro === 'ground') a <5 NM -> SI.
  //  B) category C* o B6 (vehiculo tierra, obstaculo, UAV) -> NO.
  //  C) nav_modes contiene 'approach' y dist<60 NM -> SI (arrival).
  //  D) Intencion del piloto via nav_altitude_mcp/fms (mas fiable
  //     que baro_rate, que oscila): si la altitud seleccionada es
  //     >=2000 ft por DEBAJO de la actual -> descenso. Si >=2000 ft
  //     por ENCIMA -> ascenso. Si plano y FL>=250 -> overflight.
  //  E) Dentro de 20 NM y bajo FL200 -> SI (zona TMA tipica).
  //  F) Descendiendo + rumbo al aerodromo (<60 deg diff) -> SI (arrival).
  //  G) Ascendiendo + alejandose (<60 deg diff) -> SI (departure).
  //  H) <40 NM, <15000 ft y rumbo al aerodromo (<70 deg) -> SI
  //     (vector de aproximacion guiado por ATC).
  //  Resto -> NO.
  function _isArrivalOrDeparture(ac, centerLat, centerLon) {
    if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return false;
    const geom = window.TSAgestor && window.TSAgestor.geom;
    if (!geom) return true;
    const distKm = geom.greatCircleDistance([ac.lat, ac.lon], [centerLat, centerLon]);
    const distNM = distKm / 1.852;

    // B) Filtra vehiculos de tierra, obstaculos y UAV por ADS-B
    // category code. Solo nos interesan aviones de verdad (A* y B1/B2
    // glider/balloon que tambien hacen vuelos).
    if (typeof ac.category === 'string') {
      if (/^C[0-7]$/.test(ac.category)) return false;   // surface vehicles + obstacles
      if (ac.category === 'B6') return false;           // UAV
    }

    // A) Avion en tierra a <5 NM = en pista del aerodromo.
    if (ac.alt_baro === 'ground' && distNM < 5) return true;
    // Avion en tierra fuera del aerodromo: lo descartamos (estara en otro).
    if (ac.alt_baro === 'ground') return false;

    const altFt = Number.isFinite(ac.alt_baro) ? ac.alt_baro : null;
    // nav_modes: lista de modos de automatismo activos.
    const modes = Array.isArray(ac.nav_modes) ? ac.nav_modes : [];

    // C) Senal mas fuerte: aproximacion engaged. Si esta cerca, casi
    //    seguro arrival del aerodromo seleccionado.
    if (modes.indexOf('approach') >= 0 && distNM < 60) return true;

    // D) Intencion del piloto via MCP/FMS. La altitud seleccionada
    //    refleja el target real, no oscila como baro_rate.
    const selectedAlt = Number.isFinite(ac.nav_altitude_mcp) ? ac.nav_altitude_mcp
                      : Number.isFinite(ac.nav_altitude_fms) ? ac.nav_altitude_fms
                      : null;
    let intent = null;  // 'descent' | 'climb' | 'level'
    if (selectedAlt != null && altFt != null) {
      const diff = selectedAlt - altFt;
      if (diff <= -2000) intent = 'descent';
      else if (diff >= 2000) intent = 'climb';
      else intent = 'level';
    }
    // Fallback: baro_rate.
    if (!intent) {
      if (Number.isFinite(ac.baro_rate)) {
        if (ac.baro_rate >  300) intent = 'climb';
        else if (ac.baro_rate < -300) intent = 'descent';
        else intent = 'level';
      } else {
        intent = 'unknown';
      }
    }

    // Overflight en crucero: alta altitud, intent=level -> descarta.
    if (altFt != null && altFt >= 25000 && intent === 'level') return false;

    // E) Muy cerca + bajo: trafico de aerodromo (GA, IFR aproximando).
    if (distNM < 20 && (altFt == null || altFt < 20000)) return true;

    if (!Number.isFinite(ac.track)) {
      // Sin rumbo usable: conservador por distancia.
      return distNM < 30;
    }
    const bearingFromAirport = geom.bearing([centerLat, centerLon], [ac.lat, ac.lon]);
    const diffAway   = _absAngleDiff(ac.track, bearingFromAirport);
    const diffToward = _absAngleDiff(ac.track, (bearingFromAirport + 180) % 360);

    // F) Descendiendo y arrumbado al aerodromo -> arrival.
    if (intent === 'descent' && diffToward < 60) return true;
    // G) Ascendiendo y alejandose -> departure.
    if (intent === 'climb' && diffAway < 60) return true;
    // H) Vector ATC: medio nivel, cerca, rumbo entrante.
    if (distNM < 40 && altFt != null && altFt < 15000 && diffToward < 70) return true;
    return false;
  }

  function _absAngleDiff(a, b) {
    let d = ((a - b) % 360 + 540) % 360 - 180;
    return Math.abs(d);
  }

  // Dibuja o actualiza los markers. El COLOR depende de si el avion
  // se considera arrival/departure del aerodromo seleccionado:
  //   arr/dep -> color por banda de altitud (verde/amarillo/rojo).
  //   transito -> gris.
  // Asi un avion que cambia de rumbo y empieza a dirigirse al aero-
  // dromo se recolorea automaticamente al siguiente tick.
  function _renderAircraft(list) {
    if (!_layer) return;
    const now = Date.now();
    const seen = new Set();
    let added = 0, updated = 0, removed = 0;
    for (const ac of list) {
      if (!ac.hex) continue;
      if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) continue;
      seen.add(ac.hex);
      const entry = _markers.get(ac.hex);
      const track = Number.isFinite(ac.track) ? ac.track : 0;
      const altFt = Number.isFinite(ac.alt_baro) ? ac.alt_baro : null;
      const altBand = _altitudeBand(altFt);
      const isArrDep = _isArrivalOrDeparture(ac, _center[0], _center[1]);
      const colorKey = isArrDep ? altBand : 'transit';
      const tooltip = _buildTooltip(ac);
      const popup = _buildPopup(ac);
      if (entry) {
        entry.marker.setLatLng([ac.lat, ac.lon]);
        // Regenera icono si cambia track, banda altitud, o estado
        // arr/dep (esto ultimo es lo que cambia el color cuando el
        // avion gira y empieza a dirigirse al aerodromo).
        if (Math.abs((entry.rotation || 0) - track) > 1 ||
            entry.colorKey !== colorKey) {
          entry.marker.setIcon(_planeIcon(track, colorKey));
          entry.rotation = track;
          entry.colorKey = colorKey;
        }
        _setTooltipContent(entry.marker, tooltip);
        if (entry.marker._popup) entry.marker._popup.setContent(popup);
        updated++;
      } else {
        const m = L.marker([ac.lat, ac.lon], {
          icon: _planeIcon(track, colorKey),
        });
        m.bindTooltip(tooltip, { direction: 'top', offset: [0, -8], className: 'traffic-tt' });
        m.bindPopup(popup, { maxWidth: 280 });
        m.addTo(_layer);
        _markers.set(ac.hex, { marker: m, rotation: track, colorKey });
        added++;
        // Avion nuevo: encola fetch de su trace historica (~10-15 min)
        // para prepender al trail y mostrar de donde viene.
        _enqueueTrace(ac.hex);
      }
      // Actualiza la traza (path de los ultimos 5 min) con el color
      // actual. Si el avion pasa de transito a arr/dep, la traza se
      // recolorea entera (la historia previa tambien).
      _updateTrail(ac.hex, ac.lat, ac.lon, now, colorKey);
    }
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
  // Comprueba si un punto cae dentro del radio RADIUS_NM del centro
  // (el aerodromo seleccionado). Se usa para recortar la traza
  // historica de cada avion al area visible: los segmentos previos a
  // entrar en el circulo se descartan (el usuario solo ve lo que pasa
  // dentro de "su" zona).
  function _withinRadius(lat, lon) {
    if (!_center) return true;
    const geom = window.TSAgestor && window.TSAgestor.geom;
    if (!geom) return true;
    const distKm = geom.greatCircleDistance([lat, lon], _center);
    return distKm <= RADIUS_NM * 1.852;
  }

  function _updateTrail(hex, lat, lon, nowMs, colorKey) {
    let entry = _trails.get(hex);
    if (!entry) {
      entry = { points: [], line: null, colorKey };
      _trails.set(hex, entry);
    }
    // Solo guardamos puntos dentro del radio (por si el API devuelve
    // un avion cuyo fix actual ha salido ligeramente del circulo).
    if (!_withinRadius(lat, lon)) return;
    const last = entry.points[entry.points.length - 1];
    const closeEnough = last
      && Math.abs(last[0] - lat) < 0.0001
      && Math.abs(last[1] - lon) < 0.0001;
    if (!closeEnough) entry.points.push([lat, lon, nowMs]);

    const latlngs = entry.points.map(p => [p[0], p[1]]);
    if (latlngs.length < 2) {
      if (entry.line) { _layer.removeLayer(entry.line); entry.line = null; }
      return;
    }
    const color = _colorFor(colorKey);
    if (entry.line) {
      entry.line.setLatLngs(latlngs);
      // Recolorea TODA la traza si el avion cambia de transito a arr/dep
      // (o viceversa). Pintar segmentos historicos con el color actual
      // hace mas obvio el cambio de intencion para el ojo.
      if (entry.colorKey !== colorKey) {
        entry.line.setStyle({ color });
        entry.colorKey = colorKey;
      }
    } else {
      entry.line = L.polyline(latlngs, {
        color,
        weight: 2,
        opacity: colorKey === 'transit' ? 0.45 : 0.85,
        interactive: false,
        className: 'traffic-trail',
      });
      entry.line.addTo(_layer);
      entry.colorKey = colorKey;
      console.info('[traffic] trail nuevo para', hex, 'puntos=', entry.points.length, 'color=', colorKey);
    }
  }

  // Paleta unica: bandas de altitud para arr/dep, gris para transito.
  function _colorFor(colorKey) {
    const map = {
      low:     '#22c55e',
      mid:     '#fac200',
      high:    '#ef4444',
      unknown: '#94a3b8',
      transit: '#64748b',
    };
    return map[colorKey] || map.unknown;
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

  function _planeIcon(track, colorKey) {
    const fill = _colorFor(colorKey);
    // Los aviones de transito (gris) se dibujan con opacidad reducida
    // para que las arr/dep destaquen visualmente.
    const opacity = colorKey === 'transit' ? 0.55 : 1;
    const html = `
      <div class="traffic-plane" style="transform: rotate(${track}deg); opacity: ${opacity};">
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
