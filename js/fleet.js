// OLA4: dashboard de flota (?fleet=1).
//
// Lista las sesiones activas que el backend expone (via liveSync stub
// o real). Refresh cada 15 s (configurable en dispatch.autoRefreshSec).
// Read-only: NO se puede tocar la sesion de otro avion.
//
// Estados derivados en cliente segun edad del ultimo push:
//   < 60 s    -> flying (verde)
//   60-600 s  -> stale  (ambar)
//   > 600 s   -> lost   (rojo) — desaparece tras 30 min
//   ts_ended  -> landed (gris)
//
// Esconde el shell B1 — fullscreen tabla. body.b1-fleet aplica CSS.
//
// Seguridad:
//   - dispatch.unitId vacio -> banner CTA, no fetch.
//   - Todo user-content escapado con escapeHTML (FIX-10).
//   - fetch con cache:'no-store' (FIX-7) — el SW bypasea /api/live/* tambien.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.fleet = (function () {
  'use strict';

  let _mounted = false;
  let _shellEl = null;
  let _refreshTimer = null;
  let _backoffSec = 0;
  let _failCount = 0;
  // Audit M2: handlers como variables modulo, registrados UNA SOLA
  // vez en mount() y removidos en unmount(). Antes la arrow anonima
  // pasada a addEventListener('visibilitychange', ...) en cada
  // mount() leakeaba listeners y nunca se podia desuscribir.
  let _onVis = null;
  let _onEscape = null;
  // F1.4 Live monitoring: vista detalle con mapa Leaflet de un vuelo
  // seleccionado. _viewMode='list' (tabla) | 'detail' (mapa+stats).
  let _viewMode = 'list';
  let _detailDeviceId = null;
  let _detailMap = null;
  let _detailLayers = {
    route: null, past: null, future: null, marker: null, halo: null,
    // Workflow fleet-tsa-integration: layer groups por categoria TSA.
    // Permite skip-redraw signature por categoria.
    tsaActive: null, tsaScheduled: null, tsaLateral: null,
  };
  let _tsaSig = ''; // signature ultimo render TSA para skip si no cambio

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }

  function _fmtTime(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + 'Z';
  }
  function _fmtAge(ms) {
    if (!Number.isFinite(ms)) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  }
  function _statusOf(s) {
    if (s.tsEnded) return 'landed';
    const age = Date.now() - (s.tsPushed || 0);
    if (age < 60 * 1000) return 'flying';
    if (age < 10 * 60 * 1000) return 'stale';
    return 'lost';
  }
  const _statusLabel = {
    flying: 'En vuelo',
    stale:  'Datos stale',
    lost:   'Sin contacto',
    landed: 'Aterrizado',
  };

  function _buildShell() {
    const sh = document.createElement('div');
    sh.className = 'b1-fleet-shell';
    sh.innerHTML =
      '<div class="b1-fleet-topbar">' +
        '<button id="btn-fleet-exit" type="button" class="btn" title="Salir de Flota y volver al modo cabina (Esc)">← Volver a cabina</button>' +
        '<button id="btn-fleet-back" type="button" class="btn b1-fleet-back hidden" title="Volver al listado de flota">← Listado</button>' +
        '<h1 id="fleet-title">FLOTA — Dispatch view</h1>' +
      '</div>' +
      '<div class="b1-fleet-meta">' +
        '<span id="fleet-unit-info"></span>' +
        '<span id="fleet-update-info"></span>' +
        '<span id="fleet-error" style="color:#fca5a5;"></span>' +
      '</div>' +
      '<div id="fleet-banner"></div>' +
      '<div id="fleet-body"></div>';
    document.body.appendChild(sh);
    // Audit B3 (blocker): exit affordance — el operador en tablet no
    // podia salir de fleet view sin editar la URL. Boton + tecla
    // Escape. Recarga la pagina con la URL limpia (sin ?fleet=1) para
    // que b1Layout reentre en modo cabina.
    const exitBtn = sh.querySelector('#btn-fleet-exit');
    if (exitBtn) exitBtn.addEventListener('click', _exitFleet);
    const backBtn = sh.querySelector('#btn-fleet-back');
    if (backBtn) backBtn.addEventListener('click', _closeDetail);
    return sh;
  }
  function _exitFleet() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('fleet');
      window.location.href = u.toString();
    } catch (_) { window.location.reload(); }
  }

  function mount() {
    if (_mounted) return;
    _mounted = true;
    _shellEl = _buildShell();
    _render();
    _scheduleRefresh();
    // Audit M2: handler como variable modulo. Pausa refresh cuando
    // el tab no es visible (FIX performance + ahorro de fetches).
    // Guard !_mounted dentro por si llega un evento tras unmount.
    if (typeof document !== 'undefined' && document.addEventListener) {
      _onVis = () => {
        if (!_mounted) return;
        if (document.hidden) {
          _stopRefresh();
        } else {
          _render();
          _scheduleRefresh();
        }
      };
      document.addEventListener('visibilitychange', _onVis);
    }
    // Audit B3: tecla Escape como atajo para salir de fleet view.
    _onEscape = (e) => {
      if (!_mounted) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (confirm('¿Salir de Flota y volver al modo cabina?')) _exitFleet();
      }
    };
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('keydown', _onEscape);
    }
  }
  function unmount() {
    _stopRefresh();
    // Audit M2: removeEventListener simetrico con mount().
    if (_onVis && typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('visibilitychange', _onVis);
      _onVis = null;
    }
    if (_onEscape && typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('keydown', _onEscape);
      _onEscape = null;
    }
    if (_shellEl && _shellEl.parentNode) _shellEl.parentNode.removeChild(_shellEl);
    _shellEl = null;
    _mounted = false;
  }
  function _scheduleRefresh() {
    _stopRefresh();
    if (!_mounted) return; // Audit M2: guard re-entrancia
    const settings = window.TSAgestor && window.TSAgestor.settings;
    // Audit M4: clamp inferior a 1s. Number(-5) || 15 daba -5 (truthy)
    // -> setTimeout con delay 0 -> fetch storm.
    const raw = settings ? Number(settings.get('dispatch.autoRefreshSec')) : NaN;
    const baseSec = (Number.isFinite(raw) && raw >= 1) ? raw : 15;
    const delay = _backoffSec > 0 ? _backoffSec : baseSec;
    _refreshTimer = setTimeout(_tick, Math.max(1, delay) * 1000);
  }
  function _stopRefresh() {
    if (_refreshTimer) { try { clearTimeout(_refreshTimer); } catch (_) {} _refreshTimer = null; }
  }
  async function _tick() {
    _refreshTimer = null;
    if (!_mounted) return; // Audit M2
    await _render();
    _scheduleRefresh();
  }

  async function _render() {
    if (!_shellEl) return;
    // F1.4 Live monitoring: dispatcher por viewMode.
    if (_viewMode === 'detail') {
      await _renderDetail();
      return;
    }
    await _renderList();
  }

  async function _renderList() {
    const settings = window.TSAgestor && window.TSAgestor.settings;
    const ls = window.TSAgestor && window.TSAgestor.liveSync;
    const unitId = (settings && settings.get('dispatch.unitId', '')) || '';
    const unitInfo = _shellEl.querySelector('#fleet-unit-info');
    const updInfo  = _shellEl.querySelector('#fleet-update-info');
    const errEl    = _shellEl.querySelector('#fleet-error');
    const banner   = _shellEl.querySelector('#fleet-banner');
    const body     = _shellEl.querySelector('#fleet-body');
    const title    = _shellEl.querySelector('#fleet-title');
    const backBtn  = _shellEl.querySelector('#btn-fleet-back');

    if (title) title.textContent = 'FLOTA — Dispatch view';
    if (backBtn) backBtn.classList.add('hidden');
    if (unitInfo) unitInfo.textContent = 'Unidad: ' + (unitId || '(no configurada)');
    if (errEl) errEl.textContent = '';

    if (!unitId) {
      banner.innerHTML = '<div class="b1-fleet-banner">Configura tu <b>ID de unidad</b> en Ajustes → Sync con servidor antes de usar Flota. Sin esto no se hace ningun fetch al servidor.</div>';
      body.innerHTML = '';
      return;
    }
    banner.innerHTML = '';

    if (!ls || typeof ls.listActive !== 'function') {
      body.innerHTML = '<div class="b1-fleet-empty">Modulo liveSync no disponible.</div>';
      return;
    }

    try {
      const r = await ls.listActive();
      _failCount = 0;
      _backoffSec = 0;
      const sessions = (r && Array.isArray(r.sessions)) ? r.sessions : [];
      const showLanded = !!(settings && settings.get('dispatch.showLanded', false));
      const filtered = sessions.filter(s => showLanded || !s.tsEnded);
      if (updInfo) updInfo.textContent = 'Actualizado: ' + _fmtTime(Date.now()) + ' · ' + filtered.length + ' aviones';
      if (!filtered.length) {
        body.innerHTML = '<div class="b1-fleet-empty">Sin sesiones activas en tu unidad.</div>';
        return;
      }
      // Ordena: en vuelo primero, luego stale, lost, landed.
      const order = { flying: 0, stale: 1, lost: 2, landed: 3 };
      filtered.sort((a, b) => (order[_statusOf(a)] - order[_statusOf(b)]));
      const rows = filtered.map(s => {
        const st = _statusOf(s);
        // F1.4 Live monitoring: cada row es clickeable para abrir
        // detalle. deviceId es la clave en el backend para getById.
        const did = s.deviceId || '';
        // Test report: WP del fleet ahora coincide con la numeracion
        // del mapa y del log Live. liveSync._buildBody envia ya el
        // real-WP-index (1-based saltando sub-legs) en s.currentIdx
        // (semantica cambiada con el commit de la sesion fix).
        // Backwards: si s.currentIdx llegara como raw-index todavia
        // (cliente viejo o backend antiguo), no hay forma de saberlo
        // sin el coords array; mostramos el valor tal cual + 0 (no +1)
        // si ya es 1-based. Para el caso transicional usamos s.currentIdx
        // directo asumiendo que ya viene 1-based. Si llegan ceros
        // (operador no inicio ruta), mostramos "—".
        const wpN = s.currentIdx | 0;
        const wpLabel = wpN > 0
          ? ('WP ' + wpN + (s.currentWpName ? ' · ' + escapeHTML(s.currentWpName) : ''))
          : '—';
        // F1.5 Dispatch metrics: anyade fuel actual (con unidad si
        // viene), ETA proximo WP y ETA a destino. Si la sesion era
        // pusheada con un cliente viejo sin meta.etaNextWp, los
        // campos caen a "—" graciosamente.
        const fuelStr = Number.isFinite(s.fuelRest)
          ? (Math.round(s.fuelRest) + (s.fuelUnit ? (' ' + escapeHTML(s.fuelUnit)) : ''))
          : '—';
        const fuelCls = s.fuelStatus === 'bingo' ? ' class="b1-fleet-fuel-bingo"'
                      : (s.fuelStatus === 'joker' ? ' class="b1-fleet-fuel-joker"' : '');
        const etaNextStr = Number.isFinite(s.etaNextWp)
          ? (_fmtTime(s.etaNextWp) + (s.nextWpName ? ' · ' + escapeHTML(s.nextWpName) : ''))
          : '—';
        const etaDestStr = Number.isFinite(s.etaDestination)
          ? _fmtTime(s.etaDestination)
          : '—';
        return '<tr class="b1-fleet-row-' + st + ' b1-fleet-row-clickable" data-device-id="' + escapeHTML(did) + '" title="Click para monitorizar en el mapa">' +
          '<td><span class="b1-fleet-chip b1-fleet-chip-' + st + '">' + escapeHTML(_statusLabel[st]) + '</span></td>' +
          '<td><b>' + escapeHTML(s.callsign || '—') + '</b></td>' +
          '<td>' + escapeHTML(s.origin || '?') + ' → ' + escapeHTML(s.destination || '?') + '</td>' +
          '<td>' + wpLabel + '</td>' +
          '<td' + fuelCls + '>' + fuelStr + '</td>' +
          '<td>' + etaNextStr + '</td>' +
          '<td>' + etaDestStr + '</td>' +
          '<td>' + _fmtAge(s.tsPushed) + '</td>' +
        '</tr>';
      }).join('');
      body.innerHTML =
        '<table class="b1-fleet-table">' +
          '<thead><tr>' +
            '<th>Estado</th><th>Indicativo</th><th>Ruta</th><th>WP actual</th>' +
            '<th>Fuel</th><th>ETA próx. WP</th><th>ETA destino</th><th>Último push</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
      // F1.4 Live monitoring: delegacion de click en filas.
      const tbody = body.querySelector('tbody');
      if (tbody) {
        tbody.addEventListener('click', (e) => {
          const tr = e.target.closest && e.target.closest('tr[data-device-id]');
          if (!tr) return;
          const did = tr.getAttribute('data-device-id');
          if (did) _openDetail(did);
        });
      }
    } catch (e) {
      _failCount++;
      _backoffSec = Math.min(120, Math.pow(2, _failCount) * 5);
      if (errEl) errEl.textContent = '⚠ Fallo al actualizar (' + escapeHTML((e && e.message) || 'desconocido') + ') — reintenta en ' + _backoffSec + 's';
    }
  }

  // ── F1.4 Live monitoring ─────────────────────────────────────────
  // Vista de detalle con mapa Leaflet del vuelo seleccionado:
  //   - Ruta plana (polilinea amber)
  //   - Tramo recorrido (polilinea cyan, idx 0..currentRawIdx)
  //   - Tramo pendiente (polilinea amber dashed, currentRawIdx..last)
  //   - Marcador "soy aqui" pulsante en coords[currentRawIdx]
  //   - Card de stats: callsign, ruta, WP, fuel, age, ETA destino
  // Auto-refresh con misma frecuencia que la lista — usa getById.
  function _openDetail(deviceId) {
    if (!deviceId) return;
    _viewMode = 'detail';
    _detailDeviceId = deviceId;
    _stopRefresh();
    _render().then(_scheduleRefresh).catch(() => _scheduleRefresh());
  }
  function _closeDetail() {
    _viewMode = 'list';
    _detailDeviceId = null;
    // Cleanup del mapa Leaflet — important para no fugar listeners ni
    // memory entre transiciones list -> detail -> list -> detail.
    if (_detailMap) {
      try { _detailMap.remove(); } catch (_) {}
      _detailMap = null;
    }
    _detailLayers = {
      route: null, past: null, future: null, marker: null, halo: null,
      tsaActive: null, tsaScheduled: null, tsaLateral: null,
    };
    _tsaSig = '';
    _stopRefresh();
    _render().then(_scheduleRefresh).catch(() => _scheduleRefresh());
  }
  async function _renderDetail() {
    const ls = window.TSAgestor && window.TSAgestor.liveSync;
    const errEl   = _shellEl.querySelector('#fleet-error');
    const updInfo = _shellEl.querySelector('#fleet-update-info');
    const body    = _shellEl.querySelector('#fleet-body');
    const banner  = _shellEl.querySelector('#fleet-banner');
    const title   = _shellEl.querySelector('#fleet-title');
    const backBtn = _shellEl.querySelector('#btn-fleet-back');

    if (banner) banner.innerHTML = '';
    if (backBtn) backBtn.classList.remove('hidden');
    if (errEl) errEl.textContent = '';

    if (!ls || typeof ls.getById !== 'function') {
      body.innerHTML = '<div class="b1-fleet-empty">liveSync.getById no disponible.</div>';
      return;
    }
    // Lazy-init del DOM solo en el primer render del detalle. Si el
    // contenedor ya existe (rerender), preservamos el mapa para
    // evitar reinicializaciones costosas.
    const detailExists = !!body.querySelector('.b1-fleet-detail');
    if (!detailExists) {
      body.innerHTML =
        '<div class="b1-fleet-detail">' +
          '<div class="b1-fleet-detail-stats" id="fleet-detail-stats">Cargando vuelo...</div>' +
          '<div class="b1-fleet-detail-map" id="fleet-detail-map"></div>' +
        '</div>';
    }

    try {
      const r = await ls.getById(_detailDeviceId);
      _failCount = 0;
      _backoffSec = 0;
      const session = (r && r.session) || null;
      const meta    = (r && r.meta) || {};
      if (!session) {
        body.innerHTML = '<div class="b1-fleet-empty">Sesion no encontrada (deviceId=' + escapeHTML(_detailDeviceId) + ').</div>';
        return;
      }
      const callsign = meta.callsign || r.callsign || '—';
      const origin   = meta.origin   || (session.coords && session.coords[0] && session.coords[0].name) || '?';
      const destination = meta.destination || (session.coords && session.coords[session.coords.length - 1] && session.coords[session.coords.length - 1].name) || '?';
      const fuelRest = Number.isFinite(meta.fuelRest) ? meta.fuelRest : (Number.isFinite(r.fuelRest) ? r.fuelRest : null);
      const fuelUnit = meta.fuelUnit || r.fuelUnit || '';
      const fuelStatus = meta.fuelStatus || r.fuelStatus || null;
      const etaNextWp     = Number.isFinite(meta.etaNextWp)     ? meta.etaNextWp     : (Number.isFinite(r.etaNextWp)     ? r.etaNextWp     : null);
      const nextWpName    = meta.nextWpName || r.nextWpName || null;
      const etaDestination = Number.isFinite(meta.etaDestination) ? meta.etaDestination : (Number.isFinite(r.etaDestination) ? r.etaDestination : null);
      const tsPushed = meta.tsPushed || r.tsPushed || null;
      // _rawIdx (raw array index incl. sub-legs) si presente en meta,
      // si no fallback a session.currentIdx (que puede ya ser raw en
      // session_json) o intentar derivarlo del realIdx.
      let rawIdx = Number.isFinite(meta._rawIdx) ? meta._rawIdx : (session.currentIdx | 0);
      const realIdx = Number.isFinite(meta.currentIdx) ? meta.currentIdx : null;
      const wpName = meta.currentWpName || (session.coords && session.coords[rawIdx] && session.coords[rawIdx].name) || '—';

      const st = _statusOf({
        tsEnded:  r.tsEnded || null,
        tsPushed: tsPushed,
      });
      const statsEl = body.querySelector('#fleet-detail-stats');
      if (statsEl) {
        const fuelDisplay = Number.isFinite(fuelRest)
          ? (Math.round(fuelRest) + (fuelUnit ? (' ' + escapeHTML(fuelUnit)) : ''))
          : '—';
        const fuelCls = fuelStatus === 'bingo' ? ' b1-fleet-stat-bingo'
                      : (fuelStatus === 'joker' ? ' b1-fleet-stat-joker' : '');
        const etaNextDisplay = Number.isFinite(etaNextWp)
          ? (_fmtTime(etaNextWp) + (nextWpName ? '<br><span class="dim">→ ' + escapeHTML(nextWpName) + '</span>' : ''))
          : '—';
        const etaDestDisplay = Number.isFinite(etaDestination)
          ? (_fmtTime(etaDestination) + '<br><span class="dim">→ ' + escapeHTML(destination) + '</span>')
          : '—';
        statsEl.innerHTML =
          '<div class="b1-fleet-detail-row1">' +
            '<span class="b1-fleet-chip b1-fleet-chip-' + st + '">' + escapeHTML(_statusLabel[st]) + '</span>' +
            '<h2>' + escapeHTML(callsign) + '</h2>' +
            '<span class="b1-fleet-detail-route">' + escapeHTML(origin) + ' → ' + escapeHTML(destination) + '</span>' +
          '</div>' +
          '<div class="b1-fleet-detail-row2">' +
            _statBox('WP actual', realIdx != null && realIdx > 0 ? ('#' + realIdx + ' · ' + escapeHTML(wpName)) : '—') +
            '<div class="b1-fleet-stat' + fuelCls + '"><span class="dim">Fuel actual</span><b>' + fuelDisplay + '</b></div>' +
            _statBox('ETA prox. WP', etaNextDisplay) +
            _statBox('ETA destino', etaDestDisplay) +
            _statBox('Ultimo push', _fmtAge(tsPushed)) +
            _statBox('RTB', !!meta.rtbEngaged ? 'SI' : 'No') +
          '</div>';
      }

      _renderDetailMap(session, rawIdx);
      if (updInfo) updInfo.textContent = 'Actualizado: ' + _fmtTime(Date.now()) + ' · monitorizando ' + escapeHTML(callsign);
      if (title) title.textContent = 'FLOTA — ' + callsign;
    } catch (e) {
      _failCount++;
      _backoffSec = Math.min(120, Math.pow(2, _failCount) * 5);
      if (errEl) errEl.textContent = '⚠ Fallo al obtener vuelo (' + escapeHTML((e && e.message) || 'desconocido') + ') — reintenta en ' + _backoffSec + 's';
    }
  }
  function _statBox(label, value) {
    return '<div class="b1-fleet-stat"><span class="dim">' + escapeHTML(label) + '</span><b>' + value + '</b></div>';
  }
  function _renderDetailMap(session, rawIdx) {
    if (typeof L === 'undefined' || !L.map) {
      console.warn('[fleet] Leaflet no disponible — no se puede dibujar el mapa.');
      return;
    }
    const coords = Array.isArray(session.coords) ? session.coords : [];
    if (coords.length < 2) return;
    const validIdx = Math.max(0, Math.min(rawIdx | 0, coords.length - 1));
    const allLatLngs = coords
      .filter(c => c && Number.isFinite(c.lat) && Number.isFinite(c.lon))
      .map(c => [c.lat, c.lon]);
    if (!allLatLngs.length) return;
    const pastLatLngs   = allLatLngs.slice(0, validIdx + 1);
    const futureLatLngs = allLatLngs.slice(validIdx);
    const curLatLng     = allLatLngs[validIdx];

    if (!_detailMap) {
      _detailMap = L.map('fleet-detail-map', {
        zoomControl: true,
        attributionControl: false,
      }).setView(curLatLng || allLatLngs[0], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap',
      }).addTo(_detailMap);
      // Workflow fleet-tsa-integration: pane dedicado a TSAs con
      // z-index < ruta/marker para que polygons queden SIEMPRE debajo.
      if (!_detailMap.getPane('fleetTsaPane')) {
        _detailMap.createPane('fleetTsaPane');
        _detailMap.getPane('fleetTsaPane').style.zIndex = 380;
      }
    }
    // Limpia capas previas y redibuja con datos nuevos.
    ['route', 'past', 'future', 'marker', 'halo'].forEach(k => {
      if (_detailLayers[k]) {
        try { _detailMap.removeLayer(_detailLayers[k]); } catch (_) {}
        _detailLayers[k] = null;
      }
    });
    // Workflow fleet-tsa-integration: render TSAs como capas separadas.
    _renderTsaOverlays(session, validIdx);
    // Halo oscuro de legibilidad detras de toda la ruta.
    _detailLayers.route = L.polyline(allLatLngs, {
      color: '#1f2937', weight: 7, opacity: 0.4,
    }).addTo(_detailMap);
    // Tramo recorrido cyan solido.
    if (pastLatLngs.length >= 2) {
      _detailLayers.past = L.polyline(pastLatLngs, {
        color: '#06b6d4', weight: 4, opacity: 0.95,
      }).addTo(_detailMap);
    }
    // Tramo pendiente amber dashed.
    if (futureLatLngs.length >= 2) {
      _detailLayers.future = L.polyline(futureLatLngs, {
        color: '#fbbf24', weight: 4, opacity: 0.8,
        dashArray: '6 6',
      }).addTo(_detailMap);
    }
    // Marker "soy aqui" rojo con halo.
    if (curLatLng) {
      _detailLayers.halo = L.circleMarker(curLatLng, {
        radius: 14, color: '#ef4444', fillColor: '#ef4444',
        fillOpacity: 0.15, weight: 1, className: 'b1-fleet-marker-halo',
      }).addTo(_detailMap);
      _detailLayers.marker = L.circleMarker(curLatLng, {
        radius: 7, color: '#fff', fillColor: '#ef4444',
        fillOpacity: 1, weight: 2,
      }).addTo(_detailMap);
      _detailLayers.marker.bindTooltip(
        'WP actual: ' + (coords[validIdx].name || '?'),
        { direction: 'top', offset: [0, -8] }
      );
    }
    // Fit bounds solo si es la primera vez O si el marcador queda
    // fuera del viewport actual (evita "saltos" de camara en refresh).
    const bounds = L.latLngBounds(allLatLngs);
    if (!_detailMap._initialFit) {
      _detailMap.fitBounds(bounds, { padding: [40, 40] });
      _detailMap._initialFit = true;
    } else if (curLatLng) {
      const vp = _detailMap.getBounds();
      if (!vp.contains(curLatLng)) {
        _detailMap.panTo(curLatLng, { animate: true });
      }
    }
    // invalidateSize por si el contenedor cambio de tamano.
    setTimeout(() => {
      try { _detailMap.invalidateSize(); } catch (_) {}
    }, 100);
  }

  // ── Workflow fleet-tsa-integration ───────────────────────────────
  // _computeTsaOverlays: dado un session.crossingTSAs (del payload del
  // avion), particiona en 3 categorias segun el estado AHORA:
  //   active    = schedule cubre Date.now() Y FL match (rojo solido)
  //   scheduled = conflict pero schedule no activo ahora (rojo dashed)
  //   lateral   = sobrevuelo sin conflict (ambar dashed informativo)
  // Cap a 8 polygons por categoria (los mas cercanos al WP actual).
  function _computeTsaOverlays(session, validIdx) {
    const tsas = Array.isArray(session && session.crossingTSAs)
      ? session.crossingTSAs : null;
    if (!tsas) return { unavailable: 'legacy', active: [], scheduled: [], lateral: [] };
    if (!tsas.length)        return { unavailable: null,     active: [], scheduled: [], lateral: [] };

    const now = Date.now();
    const coords = Array.isArray(session.coords) ? session.coords : [];
    const cur = coords[validIdx] || coords[0] || null;
    const curLat = cur ? cur.lat : null;
    const curLon = cur ? cur.lon : null;

    function tsaCentroid(t) {
      if (!Array.isArray(t.polygon) || !t.polygon.length) return null;
      let slat = 0, slon = 0, n = 0;
      for (const p of t.polygon) {
        if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
          slat += p[0]; slon += p[1]; n++;
        }
      }
      return n ? [slat / n, slon / n] : null;
    }
    function distSq(a, b) {
      const dy = a[0] - b[0], dx = a[1] - b[1];
      return dy * dy + dx * dx;
    }
    function isActiveNow(t) {
      if (!Array.isArray(t.schedules) || !t.schedules.length) return true; // sin horario -> siempre
      return t.schedules.some(s => {
        if (!s) return false;
        const su = s.startUTC instanceof Date ? s.startUTC.getTime() : Date.parse(s.startUTC);
        const eu = s.endUTC   instanceof Date ? s.endUTC.getTime()   : Date.parse(s.endUTC);
        return Number.isFinite(su) && Number.isFinite(eu) && su <= now && now < eu;
      });
    }
    function flMatch(t) {
      // Cualquier WP del plan dentro de la banda vertical -> conflict FL.
      if (!t.vertical || !Number.isFinite(t.vertical.lowerFt) || !Number.isFinite(t.vertical.upperFt)) return false;
      const lo = t.vertical.lowerFt;
      const up = t.vertical.upperFt;
      return coords.some(c => {
        const flFt = Number.isFinite(c.fl) ? c.fl * 100 : null;
        return Number.isFinite(flFt) && flFt >= lo && flFt <= up;
      });
    }

    const active = [], scheduled = [], lateral = [];
    tsas.forEach(t => {
      if (!t || !Array.isArray(t.polygon) || t.polygon.length < 3) return;
      const fl = flMatch(t);
      const live = isActiveNow(t);
      if (fl && live)      active.push(t);
      else if (fl)         scheduled.push(t);
      else                 lateral.push(t);
    });
    function rankByCur(list) {
      if (!cur) return list.slice(0, 8);
      return list
        .map(t => ({ t, d: (function () {
          const c = tsaCentroid(t);
          return c ? distSq(c, [curLat, curLon]) : Infinity;
        })() }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 8)
        .map(o => o.t);
    }
    return {
      unavailable: null,
      active:    rankByCur(active),
      scheduled: rankByCur(scheduled),
      lateral:   rankByCur(lateral),
      totals: { active: active.length, scheduled: scheduled.length, lateral: lateral.length },
    };
  }

  function _tsaSignature(overlays) {
    if (!overlays) return '';
    if (overlays.unavailable) return 'unavail:' + overlays.unavailable;
    const idsOf = arr => arr.map(t => t.id || t.name || '').sort().join(',');
    return idsOf(overlays.active) + '|' + idsOf(overlays.scheduled) + '|' + idsOf(overlays.lateral);
  }

  function _renderTsaOverlays(session, validIdx) {
    const overlays = _computeTsaOverlays(session, validIdx);
    const sig = _tsaSignature(overlays);
    // Skip-redraw si nada cambio. Importante para no flickear cada
    // refresh (15s) cuando las TSAs no han mutado.
    const layersStillThere = !!(_detailLayers.tsaActive || _detailLayers.tsaScheduled || _detailLayers.tsaLateral);
    if (sig === _tsaSig && layersStillThere) {
      _renderTsaLegend(overlays);
      return;
    }
    _tsaSig = sig;
    ['tsaActive', 'tsaScheduled', 'tsaLateral'].forEach(k => {
      if (_detailLayers[k]) {
        try { _detailMap.removeLayer(_detailLayers[k]); } catch (_) {}
        _detailLayers[k] = null;
      }
    });
    if (overlays.unavailable) {
      _renderTsaLegend(overlays);
      return;
    }
    const STYLE = {
      active:    { color:'#dc2626', fillColor:'#dc2626', fillOpacity:0.18, weight:3, dashArray:'6 4',  pane:'fleetTsaPane' },
      scheduled: { color:'#dc2626', fillColor:'#dc2626', fillOpacity:0.10, weight:2, dashArray:'6 6',  pane:'fleetTsaPane' },
      lateral:   { color:'#fbbf24', fillColor:'#fbbf24', fillOpacity:0.06, weight:2, dashArray:'4 8',  pane:'fleetTsaPane' },
    };
    function buildLayer(list, style, state) {
      if (!list.length) return null;
      const g = L.layerGroup();
      list.forEach(t => {
        try {
          const p = L.polygon(t.polygon, style).addTo(g);
          p.bindTooltip(t.name || t.id || 'TSA', { direction: 'center', sticky: false, className: 'tsa-tooltip' });
          p.on('click', (e) => _openTsaPopup(e, list, state));
        } catch (_) {}
      });
      g.addTo(_detailMap);
      return g;
    }
    _detailLayers.tsaActive    = buildLayer(overlays.active,    STYLE.active,    'active');
    _detailLayers.tsaScheduled = buildLayer(overlays.scheduled, STYLE.scheduled, 'scheduled');
    _detailLayers.tsaLateral   = buildLayer(overlays.lateral,   STYLE.lateral,   'lateral');
    _renderTsaLegend(overlays);
  }

  function _openTsaPopup(e, list, state) {
    const lat = e.latlng.lat, lon = e.latlng.lng;
    // Apila TODAS las TSAs cuyo polygon contiene el click — solapes
    // son comunes en zonas con multiples TSAs activas.
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
    const hits = list.filter(t => Array.isArray(t.polygon) && pointInPoly([lat, lon], t.polygon));
    if (!hits.length) return;
    const STATE_LABEL = { active: 'ACTIVO AHORA', scheduled: 'PROGRAMADO', lateral: 'CRUCE LATERAL' };
    const STATE_CLS   = { active: 'badge-active', scheduled: 'badge-scheduled', lateral: 'badge-lateral' };
    function fmtSched(s) {
      if (!s) return '—';
      const fmt = d => {
        if (!d) return '?';
        const dt = (d instanceof Date) ? d : new Date(d);
        if (isNaN(dt.getTime())) return '?';
        const p = n => String(n).padStart(2, '0');
        return p(dt.getUTCDate()) + '/' + p(dt.getUTCMonth() + 1) + ' ' + p(dt.getUTCHours()) + ':' + p(dt.getUTCMinutes()) + 'Z';
      };
      return fmt(s.startUTC) + ' → ' + fmt(s.endUTC);
    }
    const html = hits.map(t => {
      const lo = t.vertical && t.vertical.lowerLabel ? t.vertical.lowerLabel
               : (t.vertical && Number.isFinite(t.vertical.lowerFt) ? ('FL' + Math.round(t.vertical.lowerFt / 100)) : '?');
      const up = t.vertical && t.vertical.upperLabel ? t.vertical.upperLabel
               : (t.vertical && Number.isFinite(t.vertical.upperFt) ? ('FL' + Math.round(t.vertical.upperFt / 100)) : '?');
      const sch = Array.isArray(t.schedules) && t.schedules.length
        ? t.schedules.map(fmtSched).join('<br>')
        : 'Sin horario';
      return '<div class="tsa-pop-item">' +
        '<b>' + escapeHTML(t.name || t.id || 'TSA') + '</b>' +
        '<span class="' + STATE_CLS[state] + '">' + STATE_LABEL[state] + '</span><br>' +
        '<span class="dim">FL ' + escapeHTML(String(lo)) + ' – ' + escapeHTML(String(up)) + '</span><br>' +
        '<span class="dim">' + sch + '</span>' +
      '</div>';
    }).join('<hr>');
    L.popup({ maxWidth: 360, autoPan: true })
      .setLatLng(e.latlng)
      .setContent(html)
      .openOn(_detailMap);
  }

  function _renderTsaLegend(overlays) {
    if (!_shellEl) return;
    const stats = _shellEl.querySelector('#fleet-detail-stats');
    if (!stats) return;
    let row3 = stats.querySelector('.b1-fleet-detail-row3');
    if (!row3) {
      row3 = document.createElement('div');
      row3.className = 'b1-fleet-detail-row3';
      stats.appendChild(row3);
    }
    const chips = [];
    if (overlays.unavailable === 'legacy') {
      chips.push('<span class="b1-fleet-tsa-chip b1-fleet-tsa-chip-dim" title="El cliente piloto no envia TSAs (version anterior)">TSAs no disponibles</span>');
    } else {
      const a = overlays.active || [], s = overlays.scheduled || [], l = overlays.lateral || [];
      const totals = overlays.totals || {};
      function chip(cls, count, total, label) {
        const ext = (total > count) ? (' (+' + (total - count) + ')') : '';
        return '<span class="b1-fleet-tsa-chip ' + cls + '">' + count + ext + ' ' + label + '</span>';
      }
      if (a.length) chips.push(chip('b1-fleet-tsa-chip-active',    a.length, totals.active || a.length,    'conflictos activos'));
      if (s.length) chips.push(chip('b1-fleet-tsa-chip-scheduled', s.length, totals.scheduled || s.length, 'conflictos programados'));
      if (l.length) chips.push(chip('b1-fleet-tsa-chip-lateral',   l.length, totals.lateral || l.length,   'cruces laterales'));
      if (!a.length && !s.length && !l.length) {
        chips.push('<span class="b1-fleet-tsa-chip b1-fleet-tsa-chip-empty">Sin TSAs en ruta</span>');
      }
    }
    row3.innerHTML = chips.join('');
  }

  return { mount, unmount };
})();
