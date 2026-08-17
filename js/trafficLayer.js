// Capa de trafico aereo en tiempo real sobre el mapa.
//
// Fuente: airplanes.live REST API (https://airplanes.live/api-guide/).
// Endpoint usado: GET /v2/point/{lat}/{lon}/{radiusNM}
// Limites: radio <=250 NM, 1 req/s. Refrescamos cada 10 s asi entramos
// muy holgados. En despliegue (*.pages.dev) api.airplanes.live NO envia
// Access-Control-Allow-Origin, asi que pasamos via Cloudflare Pages
// Function /api/airplanes/point/<lat>/<lon>/<radius>. En local sigue
// directo a la API.
//
// La capa NO es persistente: solo vive mientras el usuario tenga la
// caja activa con un ICAO valido. Se para al desactivarla o al cambiar
// de pestania (no aplicable por simple ahora — el polling sigue).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.trafficLayer = (function () {
  'use strict';

  // En produccion (Pages) api.airplanes.live NO envia Access-Control-Allow-Origin
  // para el dominio *.pages.dev, y globe.airplanes.live tambien bloquea CORS,
  // asi que ambos endpoints pasan por Cloudflare Pages Functions server-side
  // que devuelven con CORS abierto. En local (file:// / localhost) pegamos
  // directo (no hay Pages Function disponible, y desde curl / localhost la
  // API responde sin las restricciones de origen).
  const ON_REMOTE = !/^(?:localhost|127\.0\.0\.1)$/i.test(location.hostname) &&
                    location.protocol !== 'file:';
  const API_BASE = ON_REMOTE
    ? '/api/airplanes/point'
    : 'https://api.airplanes.live/v2/point';
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
  let _visibilityHook = null;      // listener para pausar polling en tab inactivo
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
    // Pausa el polling cuando la pestana esta oculta para ahorrar
    // red/cuota de API (airplanes.live tiene rate limit). Al volver
    // a la pestana, hace un fetch inmediato y reanuda el intervalo.
    if (!_visibilityHook) {
      _visibilityHook = () => {
        if (!_center) return;  // stop() ya quito el center
        // !== 'visible' cubre 'hidden', 'prerender' y 'unloaded'. Solo
        // reanudamos cuando el doc esta plenamente visible al usuario.
        if (document.visibilityState !== 'visible') {
          if (_timer) { clearInterval(_timer); _timer = null; }
        } else if (!_timer) {
          _fetchAndRender();
          _timer = setInterval(_fetchAndRender, REFRESH_MS);
        }
      };
      document.addEventListener('visibilitychange', _visibilityHook);
    }
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_visibilityHook) {
      document.removeEventListener('visibilitychange', _visibilityHook);
      _visibilityHook = null;
    }
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
    // Direcciones TIS-B no-ICAO (prefijo '~') no tienen archivo trace
    // en tar1090; pedirlo siempre devuelve 404 y gasta cuota.
    if (!hex || hex.charAt(0) === '~') return;
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
    // El avion puede haber salido del radio entre _enqueueTrace y el
    // resolve del fetch -> _trails ya no tiene su entry. O la entry
    // puede haber sido reseteada y carecer de .points. Guard completo.
    // Si no hay entry, limpiamos _tracesFetched para que si el avion
    // vuelve a entrar mas adelante, reintentemos el fetch (sin esto,
    // un fly-by rapido bloquea para siempre el trace de ese hex).
    if (!entry || !Array.isArray(entry.points)) {
      _tracesFetched.delete(hex);
      return;
    }
    if (!traceData || !Array.isArray(traceData.trace)) return;
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
      // p[3] del trace tar1090 = alt_baro_ft (number o null).
      const altFt = Number.isFinite(Number(p[3])) ? Number(p[3]) : null;
      const altBand = _altitudeBand(altFt);
      hist.push([lat, lon, ts, altBand]);
    }
    if (!hist.length) {
      console.info('[traffic] trace para', hex, ': 0 puntos dentro del radio (' + outsideRadius + ' fuera)');
      return;
    }
    entry.points = hist.concat(entry.points);
    console.info('[traffic] trace cargada para', hex, ':+', hist.length,
      'puntos historicos dentro del radio (' + outsideRadius + ' fuera descartados)');
    _redrawTrailLine(entry, hex);
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
    const url = `${API_BASE}/${_center[0]}/${_center[1]}/${RADIUS_NM}`;
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
    let hidden50 = 0;
    for (const ac of list) {
      if (!ac.hex) continue;
      if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) continue;
      // Filtro de zona interior (<50 NM): solo FL250- o FL300- descendiendo.
      if (!_shouldShow(ac, _center[0], _center[1])) { hidden50++; continue; }
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
      // Actualiza la traza con el color actual. El altFt del avion
      // (ya calculado arriba para el icono) se pasa para guardar la
      // banda de altitud con cada punto y permitir coloreo por
      // segmento cuando colorKey != 'transit'.
      _updateTrail(ac.hex, ac.lat, ac.lon, altFt, now, colorKey);
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
        if (t.lines) for (const l of t.lines) _layer.removeLayer(l);
        _trails.delete(hex);
      }
    }
    console.info('[traffic] render: +' + added + ' / =' + updated + ' / -' + removed +
      ' (markers ' + _markers.size + ', trails ' + _trails.size +
      (hidden50 ? ', ocultos<50NM ' + hidden50 : '') + ')');
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

  // Filtro de zona interior (< 50 NM): solo aviones a baja altitud o
  // descendiendo se muestran. Aviones a FL300+ se descartan siempre;
  // a FL250-FL300 solo si estan bajando. Asi se evita ruido por
  // sobrevuelos altos justo encima del aerodromo. Fuera de 50 NM, todo
  // pasa por aqui sin filtrar (la heuristica arr/dep ya separa los
  // visibles entre coloreados y gris).
  function _shouldShow(ac, centerLat, centerLon) {
    const geom = window.TSAgestor && window.TSAgestor.geom;
    if (!geom) return true;
    const distKm = geom.greatCircleDistance([ac.lat, ac.lon], [centerLat, centerLon]);
    const distNM = distKm / 1.852;
    if (distNM >= 50) return true;
    const altFt = Number.isFinite(ac.alt_baro) ? ac.alt_baro : null;
    if (altFt == null) return true;             // en pista / sin altitud: no filtra
    if (altFt < 25000) return true;             // <FL250 -> SI
    if (altFt >= 30000) return false;           // >=FL300 -> NO siempre
    // FL250..FL300 -> solo si esta descendiendo (intencion clara).
    const selectedAlt = Number.isFinite(ac.nav_altitude_mcp) ? ac.nav_altitude_mcp
                      : Number.isFinite(ac.nav_altitude_fms) ? ac.nav_altitude_fms
                      : null;
    if (selectedAlt != null && selectedAlt - altFt <= -2000) return true;
    if (Number.isFinite(ac.baro_rate) && ac.baro_rate < -300) return true;
    return false;
  }

  // Cada punto se guarda como [lat, lon, tsMs, altBand]. altBand
  // permite colorear cada segmento de la traza por banda de altitud
  // (low/mid/high/unknown) cuando el avion es arr/dep. Para transito
  // se ignora y se pinta toda la traza en gris.
  function _updateTrail(hex, lat, lon, altFt, nowMs, colorKey) {
    let entry = _trails.get(hex);
    if (!entry) {
      entry = { points: [], lines: [], colorKey };
      _trails.set(hex, entry);
    }
    if (!_withinRadius(lat, lon)) return;
    const altBand = _altitudeBand(altFt);
    const last = entry.points[entry.points.length - 1];
    const closeEnough = last
      && Math.abs(last[0] - lat) < 0.0001
      && Math.abs(last[1] - lon) < 0.0001;
    if (!closeEnough) entry.points.push([lat, lon, nowMs, altBand]);

    if (entry.points.length < 2) return;
    // Re-pinta si la geometria crecio o si el colorKey global cambio
    // (transito <-> arr/dep). _redrawTrailLine maneja ambos casos.
    entry.colorKey = colorKey;
    _redrawTrailLine(entry, hex);
  }

  // (Re)pinta la polilinea del trail.
  //   colorKey 'transit'  -> una sola polilinea gris.
  //   colorKey != 'transit' (arr/dep) -> una polilinea por cada run
  //     consecutivo de puntos con la misma banda de altitud. Cada
  //     polilinea solapa 1 punto con la siguiente para evitar gaps
  //     visuales en los limites entre bandas.
  function _redrawTrailLine(entry, hex) {
    // Limpia cualquier polilinea previa (line legacy + lines array).
    if (entry.line) { _layer.removeLayer(entry.line); entry.line = null; }
    if (entry.lines) { for (const l of entry.lines) _layer.removeLayer(l); }
    entry.lines = [];
    if (!entry.points || entry.points.length < 2) return;

    if (entry.colorKey === 'transit') {
      const latlngs = entry.points.map(p => [p[0], p[1]]);
      const line = L.polyline(latlngs, {
        color: _colorFor('transit'),
        weight: 2, opacity: 0.45,
        interactive: false, className: 'traffic-trail',
      });
      line.addTo(_layer);
      entry.lines.push(line);
      return;
    }

    // Multi-color por banda de altitud para arr/dep.
    let runStart = 0;
    let runBand = entry.points[0][3] || 'unknown';
    for (let i = 1; i < entry.points.length; i++) {
      const band = entry.points[i][3] || 'unknown';
      if (band !== runBand) {
        // Cierra el run actual incluyendo el punto del cambio para
        // que las polilineas se toquen sin gap visual.
        const slice = entry.points.slice(runStart, i + 1);
        entry.lines.push(_makeTrailSegment(slice, runBand));
        runStart = i;
        runBand = band;
      }
    }
    // Run final.
    const tail = entry.points.slice(runStart);
    if (tail.length >= 2) entry.lines.push(_makeTrailSegment(tail, runBand));
    if (hex !== undefined && entry.lines.length === 1 && !entry._announced) {
      entry._announced = true;
      console.info('[traffic] trail nuevo para', hex, 'puntos=', entry.points.length, 'color=', entry.colorKey);
    }
  }

  function _makeTrailSegment(pointsSlice, band) {
    const latlngs = pointsSlice.map(p => [p[0], p[1]]);
    const line = L.polyline(latlngs, {
      color: _colorFor(band),
      weight: 2, opacity: 0.85,
      interactive: false, className: 'traffic-trail',
    });
    line.addTo(_layer);
    return line;
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
    // Leaflet bindTooltip(string) lo parsea como HTML, asi que callsign
    // y tipo (de la API publica airplanes.live) podrian inyectar JS si
    // no se escapan. _esc cubre &, <, > que son los unicos significativos
    // en este contexto (no hay atributos con interpolacion).
    const cs = _esc((ac.flight || '').trim() || ac.hex || '?');
    const alt = Number.isFinite(ac.alt_baro)
      ? (ac.alt_baro >= 18000 ? 'FL' + Math.round(ac.alt_baro / 100) : ac.alt_baro + ' ft')
      : '—';
    const t = _esc(ac.t || '');
    return `<b>${cs}</b>${t ? ' · ' + t : ''} · ${alt}`;
  }

  // Escape minimo para strings de la API antes de meterlos en HTML.
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
