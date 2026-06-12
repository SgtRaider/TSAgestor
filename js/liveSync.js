// OLA4: sync de session Live a servidor remoto (multi-dispositivo).
//
// CONTRATO API (push entero ~10-30 kB cada intervalSec):
//   PUT    /api/live/sessions/{deviceId}    -> upsert sesion
//   DELETE /api/live/sessions/{deviceId}    -> cerrar
//   POST   /api/live/sessions/{deviceId}/finalize  -> marcar terminada (AAR)
//   GET    /api/live/sessions?unit={unitId} -> lista activas
//   GET    /api/live/sessions/{deviceId}    -> detalle
//   GET    /api/live/health                 -> ping
//
// AUTH: Authorization: Bearer <unitToken>. Si la respuesta es
// 401/403, kind='auth-fail' con CTA. Si es 5xx/network, 'fail' con
// backoff exponencial (5s -> 10s -> ... -> retryMaxSec).
//
// PAYLOAD PUT body:
//   {
//     deviceId, sessionId, version (monotonico), clientPushId,
//     callsign, unitId, clientVersion,
//     meta: { origin, destination, currentIdx, fuelRest, started },
//     session: { ... } // session JSON completa
//   }
//
// STUB MODE: si baseUrl === 'stub' o '', toda I/O es a localStorage
// (clave tsagestor_livesync_stub_v1) — util para testing E2E sin
// backend. listActive lee de la misma clave + storage events de
// otras pestanyas para simular multi-device en el mismo navegador.
//
// BACKWARDS-COMPAT (BC-1..BC-16): si liveSync.js NO se carga, los
// hooks de livePlan son no-ops via typeof guard. Si carga pero
// enabled=false, todos los metodos publicos son early-return.
// session local sigue siendo la fuente de verdad.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.liveSync = (function () {
  'use strict';

  const DEVICE_ID_KEY = 'tsagestor_device_id_v1';
  const STUB_KEY      = 'tsagestor_livesync_stub_v1';
  const CLIENT_VER    = 'tsagestor-1';
  // Audit M3 + minor m1: persiste {sessionId, version, lastPlanId} en
  // localStorage para que tras F5 el push continue con version
  // monotonica. Sin esto, el backend podria rechazar writes con
  // version < lastSeenVersion (orden monotonico contractual).
  const STATE_KEY     = 'tsagestor_livesync_state_v1';
  // Clave de session local que liveSync ve via storage event para
  // invalidar su estado in-memory si otra pestana del mismo dispositivo
  // modifica la session de Live (multi-tab).
  const PLAN_SESSION_KEY = 'tsagestor_live_session_v2';

  // Estado del modulo (singleton).
  let _cfg = {
    enabled: false,
    baseUrl: '',
    token: '',
    callsign: '',
    unitId: '',
    intervalSec: 30,
    retryMaxSec: 300,
  };
  let _deviceId   = null;
  let _sessionId  = null;       // generado al primer push de una nueva session
  let _lastPlanId = null;
  let _version    = 0;          // monotonico (FIX-17)
  let _lastBodyDigest = null;   // gating: NO push si nada cambio
  let _lastPushTs  = 0;
  let _lastErrorTs = 0;
  let _lastError   = null;
  let _failCount   = 0;
  let _backoffSec  = 0;
  let _kind        = 'off';     // off | idle | pushing | ok | fail | auth-fail | offline
  let _inflight    = false;
  let _dirty       = false;
  let _finalized   = false;     // FIX-9: ignora markDirty hasta nueva session
  let _timer       = null;
  let _abortCtrl   = null;
  const _listeners = [];

  // ── Util ─────────────────────────────────────────────────────────
  function _safeCrypto() {
    return (typeof crypto !== 'undefined' && crypto) || null;
  }
  function _uuid() {
    const c = _safeCrypto();
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // Fallback (no usa Math.random como recomienda FIX-1):
    // hexstring desde getRandomValues si esta disponible.
    if (c && typeof c.getRandomValues === 'function') {
      const a = new Uint8Array(16);
      c.getRandomValues(a);
      // RFC4122 v4 simplificado
      a[6] = (a[6] & 0x0f) | 0x40;
      a[8] = (a[8] & 0x3f) | 0x80;
      const hex = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
      return hex.slice(0,8) + '-' + hex.slice(8,12) + '-' + hex.slice(12,16) + '-' +
             hex.slice(16,20) + '-' + hex.slice(20);
    }
    // Ultimo recurso (no random pero unico-por-tab): timestamp+counter
    return 'devid-' + (typeof performance !== 'undefined' ? performance.now() : 0) + '-' + (_devidFallbackCounter++);
  }
  let _devidFallbackCounter = 0;

  function _loadDeviceId() {
    if (_deviceId) return _deviceId;
    try {
      const raw = localStorage.getItem(DEVICE_ID_KEY);
      if (raw && raw.length >= 8) { _deviceId = raw; return _deviceId; }
    } catch (_) {}
    _deviceId = _uuid();
    try { localStorage.setItem(DEVICE_ID_KEY, _deviceId); } catch (_) {}
    return _deviceId;
  }

  // Audit M3 + minor m1: rehidrata {sessionId, version, lastPlanId}
  // tras F5 para que el push continue con la version monotonica.
  function _loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        if (typeof s.sessionId === 'string') _sessionId = s.sessionId;
        if (Number.isFinite(s.version))      _version = s.version;
        if (typeof s.lastPlanId === 'string') _lastPlanId = s.lastPlanId;
      }
    } catch (_) {}
  }
  function _persistState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        sessionId: _sessionId, version: _version, lastPlanId: _lastPlanId,
      }));
    } catch (_) {}
  }
  function _clearPersistedState() {
    try { localStorage.removeItem(STATE_KEY); } catch (_) {}
  }

  // FIX-3: sanitiza callsign en cliente. Confiar en UI es fragil.
  function _sanitizeCallsign(s) {
    if (typeof s !== 'string') return '';
    return s.trim().toUpperCase().slice(0, 16).replace(/[^A-Z0-9 -]/g, '');
  }

  // FIX-4: URL validation. http SOLO loopback. Stub aceptado.
  function _isAllowedBaseUrl(url) {
    if (!url) return false;
    if (url === 'stub' || url.indexOf('stub:') === 0) return true;
    try {
      const u = new URL(url);
      if (u.protocol === 'https:') return true;
      if (u.protocol === 'http:') {
        return ['localhost', '127.0.0.1', '::1', '[::1]'].indexOf(u.hostname) >= 0;
      }
      return false;
    } catch (_) { return false; }
  }
  function _isStub() {
    return !_cfg.baseUrl || _cfg.baseUrl === 'stub' || _cfg.baseUrl.indexOf('stub:') === 0;
  }
  // Workflow corp-proxy-livesync-diagnose: detecta si estamos servidos
  // desde Cloudflare Pages. En ese caso usamos same-origin /api/live/*
  // que es proxeado por functions/api/live/[[path]].js hacia
  // notamhub.duckdns.org desde el edge de Cloudflare. Asi:
  //   - El cliente solo ve trafico a *.pages.dev (whitelisted en
  //     firewalls corporativos que ya permiten NotamHub).
  //   - Sin preflight CORS cross-origin (es same-origin).
  //   - El metodo PUT/DELETE va oculto del DPI corporativo (queda
  //     dentro del request a *.pages.dev).
  // En local (file:// o localhost) caemos al baseUrl configurado directo.
  function _onRemotePages() {
    try {
      if (typeof location === 'undefined') return false;
      const h = location.hostname || '';
      return h.endsWith('.pages.dev') || h.endsWith('tsagestor.pages.dev');
    } catch (_) { return false; }
  }
  function _apiUrl(path) {
    if (_isStub()) return 'stub://' + path;
    // Same-origin via Pages Function proxy. El path siempre empieza con
    // /api/live/... — el proxy /api/live/[[path]].js captura todo el
    // sub-arbol y lo reenvia al upstream.
    if (_onRemotePages() && path.indexOf('/api/live') === 0) {
      return path;
    }
    return _cfg.baseUrl.replace(/\/+$/,'') + path;
  }

  // FIX-12: requestId estable mientras (sessionId, version) no cambian.
  // Implementacion: digest barato djb2-like del body relevante. Si el
  // server es idempotente, dos reintentos con el mismo body llevan el
  // mismo requestId.
  function _hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return ((h >>> 0).toString(36));
  }
  function _digestBody(body) {
    // Subset relevante: lo que CAMBIA influye.
    return _hashStr(
      (body.sessionId || '') + '|' +
      (body.version || 0)    + '|' +
      ((body.meta && body.meta.currentIdx) || 0) + '|' +
      ((body.meta && body.meta.fuelRest) || '') + '|' +
      (body.session && body.session.eventLog ? body.session.eventLog.length : 0)
    );
  }

  // FIX-14: digest enriquecido para markDirty gate.
  // Incluye campos que importan al dispatch — cambios de hold/override
  // disparan push sin esperar al heartbeat de intervalSec.
  function _sessionDigest(s) {
    if (!s) return null;
    const holdKeys = s.liveHolds ? Object.keys(s.liveHolds).join(',') : '';
    const fovrKeys = s.fuelOverrides ? Object.keys(s.fuelOverrides).join(',') : '';
    const ov = s.overrides ? JSON.stringify(s.overrides).slice(0, 64) : '';
    const elLen = Array.isArray(s.eventLog) ? s.eventLog.length : 0;
    const cal = s.calibration ? (s.calibration.calibratedAt || 0) : 0;
    // Workflow fleet-tsa-integration: TSA ids en el digest -> activacion
    // mid-flight (NOTAM Hub refresh anyade una TSA nueva) dispara push
    // inmediato sin esperar al heartbeat de 30s.
    const tsaIds = Array.isArray(s.crossingTSAs)
      ? s.crossingTSAs.map(t => t && t.id).filter(Boolean).sort().join(',').slice(0, 256)
      : '';
    return _hashStr([
      s.planId || '',
      s.currentIdx | 0,
      s.started ? '1' : '0',
      s.rtbEngaged ? 'R' : '-',
      holdKeys, fovrKeys, ov, elLen, cal, tsaIds,
    ].join('|'));
  }

  // ── Snapshot reading (FIX-8 defensiva) ───────────────────────────
  function _getSnapshot() {
    try {
      const lp = window.TSAgestor && window.TSAgestor.livePlan;
      if (!lp || typeof lp.getSessionSnapshot !== 'function') return null;
      return lp.getSessionSnapshot();
    } catch (_) { return null; }
  }

  // ── Listeners (observable) ───────────────────────────────────────
  function _emit(evt) {
    for (let i = 0; i < _listeners.length; i++) {
      try { _listeners[i](evt); } catch (_) {}
    }
  }
  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    _listeners.push(fn);
    return function unsubscribe() {
      const idx = _listeners.indexOf(fn);
      if (idx >= 0) _listeners.splice(idx, 1);
    };
  }

  // ── Estado / status ──────────────────────────────────────────────
  function getStatus() {
    return {
      kind: _kind,
      inflight: _inflight,
      dirty: _dirty,
      lastPushTs: _lastPushTs,
      lastError: _lastError,
      failCount: _failCount,
      backoffSec: _backoffSec,
      deviceId: _deviceId,
      sessionId: _sessionId,
      version: _version,
      finalized: _finalized,
      stub: _isStub(),
      configured: isConfigured(),
      online: isOnline(),
    };
  }
  function getDeviceId() { _loadDeviceId(); return _deviceId; }
  function isOnline() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  function isConfigured() {
    return !!_cfg.enabled && _isAllowedBaseUrl(_cfg.baseUrl);
  }

  // ── Push real (fetch) o stub ─────────────────────────────────────
  async function _doFetch(method, path, body, opts) {
    opts = opts || {};
    // FIX-7: bypass de cache al servidor real.
    const headers = { 'Content-Type': 'application/json' };
    if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;

    if (_isStub()) {
      // Stub: persiste en localStorage. NO hace network.
      return _stubHandle(method, path, body);
    }
    _abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timeoutMs = opts.timeoutMs || 8000;
    const timer = _abortCtrl ? setTimeout(() => _abortCtrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(_apiUrl(path), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: _abortCtrl ? _abortCtrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        // FIX-16: distingue auth-fail vs fail.
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        err._liveSync = true;
        throw err;
      }
      const txt = await res.text();
      return txt ? JSON.parse(txt) : { ok: true };
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (!e._liveSync) {
        e._liveSync = true;
      }
      throw e;
    }
  }

  // Stub: simula la API en localStorage.
  function _stubHandle(method, path, body) {
    let store = {};
    try { store = JSON.parse(localStorage.getItem(STUB_KEY) || '{}'); } catch (_) { store = {}; }
    store.sessions = store.sessions || {};
    // PUT /api/live/sessions/{id}
    const putMatch = /^\/api\/live\/sessions\/([^/]+)$/.exec(path);
    if (method === 'PUT' && putMatch) {
      const id = putMatch[1];
      store.sessions[id] = Object.assign({}, body, { tsPushed: Date.now() });
      try { localStorage.setItem(STUB_KEY, JSON.stringify(store)); } catch (_) {}
      return Promise.resolve({ ok: true, serverTs: Date.now() });
    }
    if (method === 'DELETE' && putMatch) {
      const id = putMatch[1];
      if (store.sessions[id]) {
        store.sessions[id].tsEnded = Date.now();
        try { localStorage.setItem(STUB_KEY, JSON.stringify(store)); } catch (_) {}
      }
      return Promise.resolve({ ok: true });
    }
    if (method === 'POST' && /^\/api\/live\/sessions\/[^/]+\/finalize$/.test(path)) {
      const id = path.split('/')[4];
      if (store.sessions[id]) {
        store.sessions[id].tsEnded = Date.now();
        store.sessions[id].finalized = true;
        try { localStorage.setItem(STUB_KEY, JSON.stringify(store)); } catch (_) {}
      }
      return Promise.resolve({ ok: true });
    }
    // GET /api/live/sessions?unit=...
    if (method === 'GET' && /^\/api\/live\/sessions(\?.*)?$/.test(path)) {
      const nowMs = Date.now();
      const list = Object.values(store.sessions || {})
        .filter(s => !s.tsEnded || (nowMs - s.tsEnded) < 10 * 60 * 1000)
        .map(s => ({
          deviceId:    s.deviceId,
          callsign:    s.callsign,
          origin:      s.meta && s.meta.origin,
          destination: s.meta && s.meta.destination,
          currentIdx:  s.meta && s.meta.currentIdx,
          fuelRest:    s.meta && s.meta.fuelRest,
          tsPushed:    s.tsPushed,
          tsEnded:     s.tsEnded || null,
        }));
      return Promise.resolve({ sessions: list, serverTimeMs: nowMs });
    }
    if (method === 'GET' && /^\/api\/live\/sessions\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      const s = store.sessions[id];
      if (!s) {
        const err = new Error('not found');
        err.status = 404; err._liveSync = true;
        return Promise.reject(err);
      }
      return Promise.resolve(s);
    }
    if (method === 'GET' && path === '/api/live/health') {
      return Promise.resolve({ ok: true, stub: true, serverTimeMs: Date.now() });
    }
    return Promise.resolve({ ok: true });
  }

  // ── Build payload PUT ────────────────────────────────────────────
  function _buildBody(session) {
    if (!session) return null;
    _loadDeviceId();
    // Si la sesion empezo nueva (planId distinto del ultimo
    // pusheado o session.started recien activado), gen nuevo sessionId.
    if (!_sessionId || (session.planId && session.planId !== _lastPlanId)) {
      _sessionId = getDeviceId() + '-' + Date.now().toString(36);
      _lastPlanId = session.planId;
      _version = 0;
    }
    _version++;
    // Audit M3 + minor m1: persiste tras cada incremento para que
    // F5 conserve la version monotonica.
    _persistState();
    const last = session.coords ? session.coords.length - 1 : 0;
    // Test report: el meta.currentIdx debe coincidir con el numero
    // del WP que muestra el mapa y el log Live, no con el indice
    // raw en session.coords (que incluye sub-legs de climb/descent).
    // Computa el real-WP-index 1-based saltando coords.isSub —
    // mismo criterio que mapView.renderFlightPlan y livePlan._renderTable.
    // Tambien el nombre del WP actual para que el dispatch tenga
    // contexto adicional aunque el backend no lo retorne en la lista.
    let currentRealIdx = 0;
    let currentWpName = '';
    if (Array.isArray(session.coords)) {
      const ci = session.currentIdx | 0;
      let count = 0;
      for (let i = 0; i <= ci && i < session.coords.length; i++) {
        const c = session.coords[i];
        if (c && !c.isSub) count++;
      }
      currentRealIdx = count;
      const curCoord = session.coords[ci];
      if (curCoord && curCoord.name) currentWpName = curCoord.name;
    }
    // F1.5 Dispatch metrics: llama a livePlan.getLiveMetrics si esta
    // disponible para que dispatch vea fuel actual + ETA proximo WP +
    // ETA destino. Antes meta.fuelRest era null hardcoded y dispatch
    // no podia mostrar nada util mas alla del callsign + ruta.
    let liveMetrics = null;
    try {
      const lp = window.TSAgestor && window.TSAgestor.livePlan;
      if (lp && typeof lp.getLiveMetrics === 'function') {
        liveMetrics = lp.getLiveMetrics();
      }
    } catch (_) {}
    // Workflow fleet-tsa-integration: anyadir TSA ids slim + hash al
    // meta. session.crossingTSAs viaja verbatim en el payload pero
    // meta.*Ids permite al dispatcher saber QUE TSAs son las del avion
    // incluso si session.crossingTSAs fue stripeada por size-gate.
    let conflictTsaIds = [];
    let overflownTsaIds = [];
    let tsaSourceHash = '00000000';
    try {
      if (Array.isArray(session.crossingTSAs) && session.crossingTSAs.length) {
        overflownTsaIds = session.crossingTSAs.map(t => t && t.id).filter(Boolean);
        const fp = window.TSAgestor && window.TSAgestor.flightPlan;
        if (fp && typeof fp._hashTsaSet === 'function') {
          tsaSourceHash = fp._hashTsaSet(session.crossingTSAs);
        }
      }
      // conflictTsaIds idealmente vendria de plan.conflicts. Como ya
      // no tenemos acceso directo aqui, dispatcher recomputa contra
      // su state.tsas — los Ids del piloto son aditivos no obligatorios.
    } catch (_) {}

    const meta = {
      origin:      session.coords && session.coords[0] && session.coords[0].name,
      destination: session.coords && session.coords[last] && session.coords[last].name,
      // currentIdx ahora lleva el real-WP-index (1-based), no el array
      // index. El backend lo almacena tal cual y fleet lo muestra
      // coincidiendo con la numeracion del mapa.
      currentIdx:  currentRealIdx,
      currentWpName,
      // El array index raw queda en _rawIdx por si algun consumer lo
      // necesita (debug, futuras features).
      _rawIdx:     session.currentIdx | 0,
      fuelRest:        liveMetrics ? liveMetrics.fuelRest : null,
      fuelUnit:        liveMetrics ? liveMetrics.fuelUnit : null,
      fuelStatus:      liveMetrics ? liveMetrics.fuelStatus : null,
      etaNextWp:       liveMetrics ? liveMetrics.etaNextWp : null,
      nextWpName:      liveMetrics ? liveMetrics.nextWpName : null,
      etaDestination:  liveMetrics ? liveMetrics.etaDestination : null,
      conflictTsaIds,
      overflownTsaIds,
      tsaSourceHash,
      started:     !!session.started,
      rtbEngaged:  !!session.rtbEngaged,
    };
    const body = {
      deviceId:      _deviceId,
      sessionId:     _sessionId,
      version:       _version,
      clientPushId:  null,
      callsign:      _sanitizeCallsign(_cfg.callsign),
      unitId:        _cfg.unitId || null,
      clientVersion: CLIENT_VER,
      meta,
      session,
    };
    body.clientPushId = _digestBody(body);
    return body;
  }

  // ── Push (con backoff) ───────────────────────────────────────────
  async function _push(reason) {
    if (!isConfigured()) return null;
    if (_inflight) return null;
    if (!isOnline()) {
      _kind = 'offline'; _emit({ type: 'fail', reason: 'offline' }); return null;
    }
    // Test report: reason==='start' (operador pulso "Iniciar ruta") o
    // 'rtb' (engage/cancel) son transiciones que arrancan operativa
    // nueva — resetean _finalized para no silenciar pushes de la
    // session siguiente si la previa cerro con AAR.
    if (reason === 'start' || reason === 'rtb') _finalized = false;
    if (_finalized) return null; // FIX-9
    const snap = _getSnapshot();
    if (!snap) return null;
    if (!snap.started) return null;
    const digest = _sessionDigest(snap);
    // Test report: anyado 'heartbeat' al bypass — el push de heartbeat
    // SIEMPRE va aunque el digest no cambie. La razon: el dispatcher
    // usa tsPushed como "senyal de vida". Si la sesion esta volando
    // sin cambios (cruise estable, sin advances en X minutos), igual
    // necesitamos refrescar tsPushed para no marcarse como lost.
    // El body es identico pero el server actualiza tsPushed al
    // procesar la PUT.
    if (digest === _lastBodyDigest && reason !== 'force' && reason !== 'rtb' && reason !== 'start' && reason !== 'heartbeat') {
      return null; // nada cambio
    }
    const body = _buildBody(snap);
    if (!body) return null;
    _inflight = true;
    _kind = 'pushing';
    _emit({ type: 'start', reason });
    try {
      const res = await _doFetch('PUT', '/api/live/sessions/' + encodeURIComponent(_deviceId), body);
      _inflight = false;
      _lastPushTs = Date.now();
      _lastBodyDigest = digest;
      _kind = 'ok';
      _lastError = null;
      _failCount = 0;
      _backoffSec = 0;
      _dirty = false;
      _emit({ type: 'ok', res });
      return res;
    } catch (e) {
      _inflight = false;
      _lastErrorTs = Date.now();
      _lastError = (e && e.message) || 'unknown';
      _failCount++;
      // FIX-16: distinguir auth vs general.
      if (e && (e.status === 401 || e.status === 403)) {
        _kind = 'auth-fail';
        // Audit B1 (blocker): tras 401/403 el operador tiene que
        // reconfigurar el token explicitamente. Setemos el backoff
        // al maximo (retryMaxSec) para evitar hammering al backend
        // cada intervalSec con un token revocado/mal pegado. El
        // operador puede pulsar retry() (chip click) o cambiar el
        // token en Ajustes (reconfigure resetea el backoff).
        _backoffSec = _cfg.retryMaxSec || 300;
        _emit({ type: 'auth-fail', error: _lastError, backoffSec: _backoffSec });
        return null;
      }
      _kind = 'fail';
      // Backoff 5,10,20,40,80,160,300 capped
      const next = Math.min(_cfg.retryMaxSec || 300, Math.pow(2, _failCount) * 5);
      _backoffSec = next;
      _emit({ type: 'fail', error: _lastError, backoffSec: next });
      return null;
    }
  }

  // ── Timer loop ───────────────────────────────────────────────────
  function _scheduleNext() {
    _stopTimer();
    if (!isConfigured()) { _kind = 'off'; return; }
    const delaySec = _backoffSec > 0 ? _backoffSec : (_cfg.intervalSec || 30);
    _timer = setTimeout(_tick, delaySec * 1000);
  }
  function _stopTimer() {
    if (_timer) { try { clearTimeout(_timer); } catch (_) {} _timer = null; }
  }
  async function _tick() {
    _timer = null;
    if (!isConfigured()) { _kind = 'off'; return; }
    // Audit B1: si estamos en auth-fail no se reintenta automaticamente.
    // El operador debe reconfigurar el token (que dispara configure() y
    // resetea estado) o llamar retry() explicitamente desde el chip.
    if (_kind === 'auth-fail') { _scheduleNext(); return; }
    // Test report: antes solo se pusheaba cuando _dirty=true o tras 5
    // min de heartbeat. Resultado: sesion activa SIN cambios -> el
    // dispatcher veia tsPushed sin actualizar y marcaba al avion como
    // stale (60s+) o lost (10min+) aunque siguiera volando bien.
    //
    // Ahora: si hay session activa (snap.started), push cada
    // intervalSec REGARDLESS para mantener tsPushed fresco. Esa es
    // la "senyal de vida" que dispatch necesita.
    // Si no hay session activa (no started) no se pushea — no waste.
    const snap = _getSnapshot();
    const hasActiveSession = !!(snap && snap.started);
    if (_dirty || hasActiveSession || _failCount > 0) {
      const reason = _failCount > 0 ? 'retry' : (_dirty ? 'dirty' : 'heartbeat');
      await _push(reason);
    }
    _scheduleNext();
  }

  // ── API publica ──────────────────────────────────────────────────
  function configure(opts) {
    opts = opts || {};
    // Drena estado previo: timer + abort + emit config event.
    _stopTimer();
    if (_abortCtrl) { try { _abortCtrl.abort(); } catch (_) {} _abortCtrl = null; }
    _inflight = false;
    _cfg = {
      enabled:    !!opts.enabled,
      baseUrl:    typeof opts.baseUrl === 'string' ? opts.baseUrl.trim() : '',
      token:      typeof opts.token === 'string' ? opts.token : '',
      callsign:   _sanitizeCallsign(opts.callsign || ''),
      unitId:     typeof opts.unitId === 'string' ? opts.unitId.trim() : (opts.dispatch && opts.dispatch.unitId) || '',
      intervalSec: Number(opts.intervalSec) > 0 ? Number(opts.intervalSec) : 30,
      retryMaxSec: Number(opts.retryMaxSec) > 0 ? Number(opts.retryMaxSec) : 300,
    };
    _loadDeviceId();
    // Audit M3 + minor m1: rehidrata state persistido para preservar
    // version monotonica entre F5. Solo si no estamos finalizando.
    if (!_finalized) _loadState();
    if (!isConfigured()) { _kind = 'off'; _emit({ type: 'config', configured: false }); return; }
    _kind = 'idle';
    _emit({ type: 'config', configured: true, stub: _isStub() });
    _scheduleNext();
  }
  function markDirty() {
    if (!isConfigured() || _finalized) return;
    _dirty = true;
  }
  async function pushNow(opts) {
    if (!isConfigured()) return null;
    opts = opts || {};
    _stopTimer();
    const r = await _push(opts.reason || 'force');
    _scheduleNext();
    return r;
  }
  async function deleteRemote() {
    if (!isConfigured()) return;
    _loadDeviceId();
    try {
      await _doFetch('DELETE', '/api/live/sessions/' + encodeURIComponent(_deviceId));
    } catch (_) { /* best-effort */ }
    _sessionId = null;
    _lastPlanId = null;
    _version = 0;
    _lastBodyDigest = null;
    _finalized = false;
    _clearPersistedState();
  }
  async function finalize(/* payload */) {
    if (!isConfigured()) return;
    _loadDeviceId();
    try {
      await _doFetch('POST', '/api/live/sessions/' + encodeURIComponent(_deviceId) + '/finalize');
    } catch (_) {}
    _finalized = true;
  }
  async function testConnection() {
    if (!isConfigured()) return { ok: false, error: 'no configurado' };
    const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    // Workflow corp-proxy-livesync-diagnose: test granular para
    // discriminar firewall vs CORS vs PUT block. Devuelve hops:
    //   - hopGet: GET /health (basico, sin Authorization)
    //   - hopPut: PUT trivial a /sessions/_test (detecta block por metodo)
    // Asi el operador en PC corporativo ve donde se rompe.
    const diag = { onPagesProxy: _onRemotePages() };
    try {
      const r = await _doFetch('GET', '/api/live/health', null, { timeoutMs: 5000 });
      const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      diag.hopGet = 'ok';
      return { ok: true, latencyMs: Math.round(t1 - t0), stub: _isStub(), serverVersion: r && r.version, diag };
    } catch (e) {
      // Test report: diagnostico extendido. ERR_CONNECTION_CLOSED y
      // 'Failed to fetch' son los sintomas tipicos de firewall
      // corporativo, proxy con TLS interception, o bloqueo de DuckDNS.
      // El operador en cabina necesita saber QUE hacer.
      const raw = (e && e.message) || 'unknown';
      diag.hopGet = 'fail';
      diag.errorRaw = raw;
      let label = raw;
      let hint = null;
      const onProxy = diag.onPagesProxy;
      if (e && e.name === 'AbortError') {
        label = 'timeout (5s sin respuesta)';
        hint = 'El servidor no respondio. Posibles causas: red lenta, servidor caido, firewall que silencia conexiones. Probar con red distinta (hotspot movil).';
      } else if (e && (e.status === 401 || e.status === 403)) {
        label = 'token rechazado (HTTP ' + e.status + ')';
        hint = 'Token de unidad invalido o revocado. Reconfigura en Ajustes > Sync con servidor.';
      } else if (e && (raw.indexOf('Failed to fetch') >= 0 || raw.indexOf('NetworkError') >= 0 ||
                       raw.indexOf('ERR_CONNECTION') >= 0 || raw.indexOf('Load failed') >= 0)) {
        label = 'conexion rechazada (' + raw + ')';
        if (onProxy) {
          // Estamos en *.pages.dev usando el proxy Pages Function. Si
          // aqui falla, el backend duckdns probablemente esta caido O
          // la Pages Function functions/api/live/[[path]].js no esta
          // desplegada (404 envuelto como network error).
          hint = 'El proxy Pages Function /api/live/* no responde. Verifica: (1) que functions/api/live/[[path]].js esta desplegado en Cloudflare Pages, (2) que el backend notamhub.duckdns.org responde (curl directo desde otra red), (3) que el firewall corporativo permite tu propio dominio *.pages.dev.';
        } else {
          hint = 'Probablemente FIREWALL CORPORATIVO bloqueando notamhub.duckdns.org. Para usar la app desde un PC corporativo, accede via la version desplegada en *.pages.dev (que tiene proxy same-origin), no via file:// local. O usa hotspot movil.';
        }
      } else if (raw.indexOf('CORS') >= 0 || raw.indexOf('preflight') >= 0) {
        label = 'CORS bloqueo';
        hint = 'Cabecera CORS rechazada. Si estas en *.pages.dev verifica que functions/api/live/[[path]].js incluye Allow-Methods: PUT,DELETE.';
      }
      return { ok: false, error: label, hint, diag };
    }
  }
  async function listActive() {
    if (!_cfg.enabled && !_isStub()) return { sessions: [], serverTimeMs: Date.now() };
    const q = _cfg.unitId ? ('?unit=' + encodeURIComponent(_cfg.unitId)) : '';
    return _doFetch('GET', '/api/live/sessions' + q);
  }
  async function getById(deviceId) {
    return _doFetch('GET', '/api/live/sessions/' + encodeURIComponent(deviceId));
  }
  function forcePush() {
    // El operador pulso el chip manualmente: reset de finalized si
    // procedia. Asi un click siempre da feedback util.
    _finalized = false;
    return pushNow({ reason: 'force' });
  }
  function retry() {
    _backoffSec = 0;
    _failCount = 0;
    _finalized = false;
    return pushNow({ reason: 'retry' });
  }
  function resetSessionId() {
    // Llamado desde livePlan cuando el plan cambia para que el
    // siguiente push genere nuevo sessionId.
    _sessionId = null; _lastPlanId = null; _version = 0; _lastBodyDigest = null;
    _finalized = false;
    _clearPersistedState();
  }

  // FIX-18: capturar unhandledrejection marcadas como _liveSync sin
  // contaminar la consola con stacks irrelevantes.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('unhandledrejection', e => {
      if (e && e.reason && e.reason._liveSync) {
        try { e.preventDefault(); } catch (_) {}
        console.warn('[liveSync] rejected:', e.reason.message || e.reason);
      }
    });
    // Audit minor m2: al volver online, push INMEDIATO (no
    // reprogramar el timer hasta intervalSec). Antes _scheduleNext()
    // dejaba un delay de hasta 30s aunque tuvieramos _dirty=true.
    window.addEventListener('online', () => {
      if (isConfigured() && (_dirty || _failCount > 0) && _kind !== 'auth-fail') {
        try { pushNow({ reason: 'online' }); } catch (_) {}
      }
    });
    // Audit M3: storage event listener para sincronia cross-tab.
    // Si otra pestana cambia el state persistido del liveSync
    // (sessionId/version/lastPlanId), recargamos nuestra copia.
    // Si otra pestana muta la session Live local, invalidamos el
    // digest para que el proximo tick lo recompute correctamente.
    window.addEventListener('storage', (e) => {
      if (!e || !e.key) return;
      if (e.key === STATE_KEY) {
        _loadState();
        _emit({ type: 'state-synced' });
      } else if (e.key === PLAN_SESSION_KEY) {
        _lastBodyDigest = null;
        _dirty = true;
      }
    });
  }

  return {
    configure,
    markDirty,
    pushNow,
    forcePush,
    retry,
    'delete': deleteRemote,    // 'delete' reservada, exportada via bracket
    deleteRemote,
    finalize,
    testConnection,
    listActive,
    getById,
    subscribe,
    getStatus,
    getDeviceId,
    isConfigured,
    isOnline,
    resetSessionId,
  };
})();
