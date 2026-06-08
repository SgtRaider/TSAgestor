// Modo Live: sigue un plan calculado durante el vuelo.
//
// Flujo:
//   1. Plan calculado -> Live tab muestra preview con ETAs planificadas.
//   2. Operador pulsa "Iniciar ruta" (con hora editable o "Despegue ahora")
//      para arrancar el seguimiento.
//   3. Cada "Estoy en proximo WP" registra Date.now() como paso real y
//      refresca vientos via Open-Meteo para los WPs restantes.
//   4. ETAs futuras se recalculan con el viento refetched o el cacheado
//      del plan; el combustible restante por WP es editable in-place
//      para reflejar consumo real.
//
// Estado en window.TSAgestor.livePlan.session, persistido en localStorage
// bajo la clave tsagestor_live_session.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.livePlan = (function () {
  'use strict';

  // Bump a _v2 cuando _hashPlan() se extendio para detectar cambios
  // estructurales (longitud de coords, sub-legs, lat/lon redondeadas).
  // Las sesiones live en formato v1 se migran silenciosamente: si el
  // hash con la formula nueva coincide con la cacheada las preservamos;
  // si no, se descartan (no hay riesgo, los pilotos no estan en vuelo
  // durante un deploy).
  const STORAGE_KEY = 'tsagestor_live_session_v2';
  const STORAGE_KEY_LEGACY = 'tsagestor_live_session';

  // Estructura de session:
  // {
  //   planId,                       hash basico del plan
  //   coords: [                     todos los WPs reales + sub-legs (no holds)
  //     { name, lat, lon, fl, originalIdx, isSub }
  //   ],
  //   plannedEtas: [ms],            ETA planificada por WP
  //   plannedFuelRest: [num],       Combustible restante planificado por WP
  //   legPlan: [{                   data del plan por leg (1 entrada por coord)
  //     ias, tas, gs, legNM, legTimeMin, legFuel, flow,
  //     wind: { speedKt, dir, headwind, atTime } | null
  //   }],
  //   fuelOpts: { initialFuel, fuelFlow, joker, bingo, unit, defaultSpeedKt },
  //   totalDistNM,
  //   started: bool,                Si la sesion live esta arrancada
  //   proposedStartTime: ms,        Hora prepuesta para empezar (editable)
  //   currentIdx: number,           Indice del WP actual (despues de iniciar)
  //   actualPassTimes: { idx: ms }, Tiempo real de paso por WP
  //   liveHolds: { idx: minutes },  Holds anadidos en vivo
  //   overrides: { fromIdx, ias|null, flow|null, fl|null } | null,
  //   fuelOverrides: { idx: number }, Combustible restante override por WP
  //   refetched: { startIdx, legTimes:[min] } | null, Tiempos por leg con
  //                                  viento refetched (relativos a startIdx)
  // }
  let session = null;
  let clockInterval = null;
  let _wired = false;
  let _refetchInFlight = false;
  // BUG#1 (audit v2): epoch monotonico bumpeado en cada transicion
  // que invalida la session (reset/build/engage/cancel RTB). El
  // _refetchWinds captura el epoch al lanzar el fetch y lo recompara
  // antes de commitear `session.refetched`: si cambio mientras await,
  // descartamos el resultado y dejamos `_refetchInFlight=false`. Asi
  // un reset/RTB en mitad del fetch no corrompe la sesion nueva ni
  // bloquea futuros refetch.
  let _sessionEpoch = 0;
  let _visibilityWired = false;
  let _etaAudioCtx = null;
  // F2.4: cache local de METAR/TAF de destino + tiempo de ultimo
  // refresh. Vive en memoria del modulo (no persistido) — el operador
  // siempre quiere meteo fresco al cargar.
  let _destMet = null;          // { icao, metar, taf, fetchedAt }
  let _destMetInFlight = false;
  // F2.5: cache de SIGMETs (raw + geometrias parseadas) y resultado
  // del ultimo cross-check. Refresh max cada 20 min para no abusar
  // de la API AWC.
  let _sigmetCache = null;      // { sigmets:[], geoms:[], fetchedAt }
  let _sigmetInFlight = false;
  // Audit OLA1 BUG#9: backoff de error en SIGMETs. _maybeRefreshSigmets
  // se llamaba desde _refresh (cada tick aprox.); si fetchSigmets
  // rechazaba (red caida, AWC 5xx), reintentaba en cada llamada y
  // hammereaba la API. Mantenemos timestamp del ultimo error y
  // saltamos durante 2 minutos para dar tiempo a que el servicio se
  // recupere.
  let _sigmetLastError = 0;
  const SIGMET_ERROR_COOLDOWN_MS = 2 * 60 * 1000;
  let _sigmetCrossings = [];    // ultimo resultado del cross-check vs ruta
  let _activeTSAcrossings = []; // F2.6: TSAs activas que cruza la ruta restante
  // F2.8: cache del ultimo _recalc para evitar recomputar O(N²) en
  // cada _tick (1 vez/segundo). Se invalida al mutar session o tras
  // refetch de viento (que cambia legTimes).
  let _recalcCache = null;
  let _recalcDirty = true;

  function init() {
    if (!_wired) {
      _wireUI();
      _wired = true;
    }
    _wireVisibility();
    _startClock();
    _loadSession();
    _maybeShowContent();
  }

  // ── Inicializacion de sesion a partir del plan calculado ───────────
  function _buildSessionFromPlan(force) {
    const plan = _getPlan();
    if (!plan || !plan.coords || plan.coords.length < 2) return null;

    // BUG#3 (audit v2): si hay un RTB engaged y el plan cambia (recalc
    // en Plan tab), NO destruir la sesion ni preRtbSnapshot por
    // sorpresa — el piloto puede estar evaluando RTB y volver al plan
    // original despues. Avisar con toast y conservar la sesion RTB.
    // El operador debe cancelar RTB primero para adoptar el plan nuevo.
    if (force !== true && session && session.rtbEngaged && session.preRtbSnapshot) {
      const newId = _hashPlan(plan);
      if (session.planId !== newId) {
        _showToast({
          id: 'plan-rtb-block', level: 'warn',
          title: 'Plan recalculado durante RTB',
          message: 'Hay un Modo Retorno engaged. La sesion Live se ha conservado para no perder el progreso del retorno. Pulsa "Cancelar RTB" si quieres adoptar el plan nuevo.',
          autoDismissMs: 12000,
        });
        return session;
      }
    }

    // Incluye TODOS los puntos (incluidos sub-legs de ascenso/descenso
    // intermedios). Filtra solo los holds (que son sinteticos y viven
    // en su propia fila del log original).
    const coordsAll = [];
    plan.coords.forEach((c, i) => {
      if (c.isHold) return;
      coordsAll.push({
        name: c.name, lat: c.lat, lon: c.lon,
        fl: Number.isFinite(c.fl) ? c.fl : null,
        originalIdx: i,
        isSub: !!c.isClimbDescentSub,
      });
    });
    if (coordsAll.length < 2) return null;

    // plan.fuel.rows (NO plan.fuel.legs — bug fix) contiene una fila
    // por coord con etaUTC, remaining, legSpeedKt (TAS), legGS, legIAS,
    // wind, legNM, legFuel, legFuelFlow, legTimeMin.
    const rows = (plan.fuel && plan.fuel.rows) || [];
    const plannedEtas = [];
    const plannedFuelRest = [];
    const legPlan = [];
    let lastEta = null, lastRem = null;
    coordsAll.forEach((c) => {
      const r = rows.find(x => x.index === c.originalIdx && !x.isHold);
      if (r) {
        const etaMs = r.etaUTC ? new Date(r.etaUTC).getTime() : null;
        if (etaMs != null) lastEta = etaMs;
        if (Number.isFinite(r.remaining)) lastRem = r.remaining;
        legPlan.push({
          ias:         Number.isFinite(r.legIAS) ? r.legIAS : null,
          tas:         Number.isFinite(r.legSpeedKt) ? r.legSpeedKt : null,
          gs:          Number.isFinite(r.legGS) ? r.legGS : null,
          legNM:       Number.isFinite(r.legDistNM) ? r.legDistNM : 0,
          legTimeMin:  Number.isFinite(r.legTimeMin) ? r.legTimeMin : 0,
          legFuel:     Number.isFinite(r.legFuel) ? r.legFuel : 0,
          flow:        Number.isFinite(r.legFuelFlow) ? r.legFuelFlow : 0,
          wind:        r.wind || null,
        });
      } else {
        legPlan.push({ ias: null, tas: null, gs: null, legNM: 0, legTimeMin: 0, legFuel: 0, flow: 0, wind: null });
      }
      plannedEtas.push(lastEta);
      plannedFuelRest.push(lastRem);
    });

    const totalDistNM = legPlan.reduce((s, l) => s + (Number(l.legNM) || 0), 0);
    const planId = _hashPlan(plan);
    const fuelOpts = plan.fuelOpts || {};
    const departureMs = plan.departureUTC ? new Date(plan.departureUTC).getTime()
                                          : (plannedEtas[0] || Date.now());

    const prev = session;
    const keep = (force !== true) && prev && prev.planId === planId;
    // Detecta cambio estructural del plan: habia sesion en curso
    // (started=true) pero el hash del plan ha cambiado. Avisar al
    // operador con toast no-bloqueante; la sesion se reconstruira con
    // currentIdx=0 abajo (porque keep sera false).
    if (force !== true && prev && prev.started && prev.planId !== planId) {
      _showToast({
        id: 'plan-changed', level: 'warn',
        title: 'El plan ha cambiado',
        message: 'Se ha recalculado el plan en otra sección. La sesión Live anterior se ha reseteado al estado inicial. Si quieres conservar el progreso, retrocede al plan original.',
        autoDismissMs: 10000,
      });
    }

    session = {
      planId,
      coords: coordsAll,
      plannedEtas,
      plannedFuelRest,
      legPlan,
      fuelOpts: (function () {
        // Bug 6 (test report): plan.fuelOpts almacena jokerFuel/bingoFuel
        // como STRING desde el HTML input. Antes Number.isFinite(string)
        // devolvia false -> joker/bingo eran SIEMPRE null en la sesion
        // Live, asi que la card de evaluacion nunca alcanzaba estados
        // bingo/joker. Acepto los dos nombres (jokerFuel/bingoFuel del
        // form + joker/bingo de un consumer interno) y parseo a number.
        const toNum = v => {
          if (v == null || v === '') return null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        return {
          initialFuel:     toNum(fuelOpts.initialFuel) || 0,
          fuelFlow:        toNum(fuelOpts.fuelFlow) || 0,
          joker:           toNum(fuelOpts.jokerFuel != null ? fuelOpts.jokerFuel : fuelOpts.joker),
          bingo:           toNum(fuelOpts.bingoFuel != null ? fuelOpts.bingoFuel : fuelOpts.bingo),
          unit:            fuelOpts.unit || 'lb',
          defaultSpeedKt:  toNum(fuelOpts.defaultSpeedKt != null ? fuelOpts.defaultSpeedKt : fuelOpts.speedKt),
          flightLevel:     toNum(fuelOpts.flightLevel),
        };
      })(),
      totalDistNM,
      started:           keep ? prev.started           : false,
      proposedStartTime: keep ? prev.proposedStartTime : departureMs,
      currentIdx:        keep ? prev.currentIdx        : 0,
      actualPassTimes:   keep ? Object.assign({}, prev.actualPassTimes) : {},
      liveHolds:         keep ? Object.assign({}, prev.liveHolds)       : {},
      overrides:         keep ? prev.overrides         : null,
      fuelOverrides:     keep ? Object.assign({}, prev.fuelOverrides || {}) : {},
      refetched:         keep ? prev.refetched         : null,
    };
    // BUG#1 (audit v2): bumpear el epoch invalida cualquier
    // _refetchWinds en vuelo — su commit detectara el cambio y
    // descartara el resultado en lugar de aplicarlo a la session nueva.
    _sessionEpoch++;
    _saveSession();
    return session;
  }

  // Hash robusto del plan: incluye longitud de coords, conteo de
  // sub-legs y coordenadas redondeadas a 4 decimales ademas de los
  // campos basicos. Antes la firma solo era `name@fl + departure +
  // defaultSpeedKt + fuelFlow`, de modo que un recalculo que insertaba
  // o quitaba un sub-leg de ascenso/descenso mantenia el hash y la
  // sesion live preservaba `actualPassTimes[idx]` apuntando a coords
  // distintas -> ETAs y consumo falsos. CRITICO.
  function _hashPlan(plan) {
    if (!plan || !plan.coords) return '0';
    // Bug 5.4 (test report): excluye holds del hash. _buildSessionFromPlan
    // filtra holds (no entran en session.coords), asi que anyadir un
    // hold no cambia la sesion Live — pero antes el hash SI cambiaba y
    // disparaba un falso "Plan ha cambiado" + reset desde cero. Filtra
    // primero y hashea sobre lo que realmente usa la sesion.
    const coordsForHash = plan.coords.filter(c => !c.isHold);
    const subCount = coordsForHash.filter(c => c.isClimbDescentSub).length;
    const fo = plan.fuelOpts || {};
    // Audit review: normaliza departureUTC a ISO string para que el
    // hash sea estable entre el plan vivo (Date) y el plan restaurado
    // desde localStorage (string).
    let depKey = '';
    if (plan.departureUTC) {
      depKey = (plan.departureUTC instanceof Date)
        ? plan.departureUTC.toISOString()
        : String(plan.departureUTC);
    }
    // Bug 6 (test report): fuelOpts en plan.fuelOpts usa los nombres
    // `jokerFuel` / `bingoFuel` (sufijo Fuel) y los almacena como
    // STRING (vienen directamente del input HTML). Antes leiamos
    // `fo.joker` / `fo.bingo` que siempre eran undefined -> el hash
    // ignoraba los umbrales y cambiar BINGO en Plan no reseteaba Live.
    // Normalizo con Number() y un fallback al nombre sin sufijo por si
    // algun consumer interno los rebautiza.
    const numOrEmpty = v => {
      if (v == null || v === '') return '';
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : '';
    };
    const sigParts = [
      'len=' + coordsForHash.length,
      'sub=' + subCount,
      coordsForHash.map(c => {
        const lat = Number.isFinite(c.lat) ? c.lat.toFixed(4) : 'NaN';
        const lon = Number.isFinite(c.lon) ? c.lon.toFixed(4) : 'NaN';
        const fl  = Number.isFinite(c.fl) ? c.fl : '-';
        return `${c.name}@${fl}@${lat},${lon}`;
      }).join('|'),
      'dep=' + depKey,
      'ias=' + numOrEmpty(fo.defaultSpeedKt || fo.speedKt),
      'flow=' + numOrEmpty(fo.fuelFlow),
      'init=' + numOrEmpty(fo.initialFuel),
      'jok=' + numOrEmpty(fo.jokerFuel != null ? fo.jokerFuel : fo.joker),
      'bgo=' + numOrEmpty(fo.bingoFuel != null ? fo.bingoFuel : fo.bingo),
      'u=' + (fo.unit || ''),
    ];
    const sig = sigParts.join('#');
    let h = 0;
    for (let i = 0; i < sig.length; i++) {
      h = ((h << 5) - h) + sig.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }
  function _getPlan() {
    const app = window.TSAgestor && window.TSAgestor.app;
    if (app && typeof app.getLastPlan === 'function') return app.getLastPlan();
    return null;
  }

  // ── Persistencia ───────────────────────────────────────────────────
  function _loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        session = JSON.parse(raw);
        _invalidateRecalc();
        // F3.3: si reaparece una sesion ya iniciada (recarga del tab),
        // avisamos al operador con un toast info para que sepa que
        // estamos continuando, no empezando de cero.
        if (session && session.started === true) {
          // Diferir un tick para que el container del toast exista.
          setTimeout(() => {
            if (!session || !session.started) return;
            // Bug audit v2: re-validar PLAN antes de anunciar
            // continuidad. Antes el guard solo miraba session.started,
            // asi que tras un F5 sin state.lastPlan restaurado el
            // operador veia "✓ Sesion Live restaurada" sobre el empty
            // state "El modo Live necesita un plan calculado".
            // Doble check: (1) hay plan vivo, (2) coincide con el hash
            // que persistio en la session — si no, _buildSessionFromPlan
            // emitira su propio toast "Plan ha cambiado" mas tarde y
            // no queremos doble mensaje contradictorio.
            const p = _getPlan();
            if (!p || !Array.isArray(p.coords) || p.coords.length < 2) return;
            if (_hashPlan(p) !== session.planId) return;
            const curr = session.currentIdx | 0;
            _showToast({
              id: 'session-restored', level: 'info',
              title: '✓ Sesión Live restaurada',
              message: `Continuando desde WP #${curr + 1}. Pulsa "Estoy en próximo WP" cuando llegues al siguiente.`,
              autoDismissMs: 6000,
            });
          }, 200);
        }
        return;
      }
      // Migracion v1 -> v2: si hay sesion legacy y el plan actual
      // coincide con su planId nuevo, la preservamos. Si no, se
      // descarta y se ignora.
      const legacyRaw = localStorage.getItem(STORAGE_KEY_LEGACY);
      if (legacyRaw) {
        try {
          const legacy = JSON.parse(legacyRaw);
          if (legacy && typeof legacy === 'object') session = legacy;
        } catch (_) { /* corrupted */ }
        try { localStorage.removeItem(STORAGE_KEY_LEGACY); } catch (_) {}
        _invalidateRecalc();
      }
    } catch (_) { session = null; }
  }
  function _saveSession() {
    if (!session) return;
    // F2.8: cualquier guardado implica mutacion del estado -> el cache
    // del recalc queda obsoleto.
    _invalidateRecalc();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch (e) {
      console.warn('[livePlan] localStorage.setItem fallo:', e && e.message);
      // QuotaExceededError o disabled. Avisa al operador (toast).
      _showToast({
        id: 'storage-error', level: 'danger',
        title: 'Sesión NO persistida',
        message: 'localStorage no disponible: ' + (e && e.message ? e.message : 'unknown'),
        autoDismissMs: 8000,
      });
    }
  }
  function _clearSession() {
    session = null;
    _invalidateRecalc();
    // BUG#1: epoch++ para que un _refetchWinds en vuelo no committee
    // su resultado sobre la session siguiente.
    _sessionEpoch++;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // ── Sistema de toasts no-bloqueantes (top-right) ──────────────────
  // Reusable para: F1.1 plan cambiado, F1.5 WP-alert, F1.6 vuelo
  // completado, F3.3 sesion restaurada. Cada toast tiene id (para
  // poder reemplazar el mismo), level (info|warn|danger|success), y
  // contenido custom. Si no auto-dismiss, queda visible hasta accion.
  function _ensureToastContainer() {
    let c = document.getElementById('live-toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'live-toast-container';
      c.className = 'live-toast-container';
      c.setAttribute('aria-live', 'polite');
      c.setAttribute('aria-atomic', 'false');
      document.body.appendChild(c);
    }
    return c;
  }
  function _showToast(opts) {
    opts = opts || {};
    const container = _ensureToastContainer();
    // Si ya hay un toast con ese id, lo reemplazamos (busca en el
    // container Y a nivel body por si era centered antes).
    if (opts.id) {
      const existing = document.querySelector('.live-toast[data-toast-id="' + opts.id + '"]');
      if (existing) existing.remove();
      const existingBd = document.querySelector('.live-toast-backdrop[data-toast-id="' + opts.id + '"]');
      if (existingBd) existingBd.remove();
    }
    const div = document.createElement('div');
    div.className = 'live-toast live-toast-' + (opts.level || 'info');
    if (opts.centered) div.classList.add('live-toast-centered');
    if (opts.id) div.dataset.toastId = opts.id;
    div.setAttribute('role', opts.level === 'danger' ? 'alert' : 'status');
    let innerHTML = '';
    if (opts.title)   innerHTML += '<div class="live-toast-title">' + opts.title + '</div>';
    if (opts.message) innerHTML += '<div class="live-toast-message">' + opts.message + '</div>';
    if (opts.bodyHTML) innerHTML += '<div class="live-toast-body">' + opts.bodyHTML + '</div>';
    if (opts.actionsHTML) innerHTML += '<div class="live-toast-actions">' + opts.actionsHTML + '</div>';
    div.innerHTML = innerHTML;
    if (opts.closeable !== false) {
      const close = document.createElement('button');
      close.className = 'live-toast-close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Cerrar');
      close.textContent = '✕';
      close.addEventListener('click', () => _dismissToast(opts.id || div));
      div.appendChild(close);
    }
    // Modo centered: monta directamente en body con backdrop dimmer
    // (semi-transparente, NO bloquea clicks fuera del toast para no
    // ser modal). Para los toasts normales, stack en top-right.
    if (opts.centered) {
      if (opts.backdrop !== false) {
        const bd = document.createElement('div');
        bd.className = 'live-toast-backdrop';
        if (opts.id) bd.dataset.toastId = opts.id;
        document.body.appendChild(bd);
      }
      document.body.appendChild(div);
    } else {
      container.appendChild(div);
    }
    if (opts.autoDismissMs && opts.autoDismissMs > 0) {
      setTimeout(() => { _dismissToast(opts.id || div); }, opts.autoDismissMs);
    }
    return div;
  }
  function _dismissToast(idOrEl) {
    if (!idOrEl) return;
    if (typeof idOrEl === 'string') {
      const el = document.querySelector('.live-toast[data-toast-id="' + idOrEl + '"]');
      if (el) el.remove();
      const bd = document.querySelector('.live-toast-backdrop[data-toast-id="' + idOrEl + '"]');
      if (bd) bd.remove();
    } else if (idOrEl.parentElement) {
      const id = idOrEl.dataset && idOrEl.dataset.toastId;
      idOrEl.remove();
      if (id) {
        const bd = document.querySelector('.live-toast-backdrop[data-toast-id="' + id + '"]');
        if (bd) bd.remove();
      }
    }
  }

  // ── Calculo de tiempo de leg ──────────────────────────────────────
  // Si hay viento refetched para el rango actual, lo usa para
  // recomputar GS y por tanto el tiempo del leg. Si no, devuelve el
  // legTimeMin cacheado del plan.
  function _legTimeMinAt(idx) {
    if (!session) return 0;
    if (idx <= 0) return 0;
    const lp = session.legPlan[idx];
    if (!lp) return 0;
    let timeMin = lp.legTimeMin || 0;

    // Si hay refetched winds para este leg, recompute.
    if (session.refetched && session.refetched.legTimes &&
        idx >= session.refetched.startIdx) {
      const rIdx = idx - session.refetched.startIdx;
      const refMin = session.refetched.legTimes[rIdx];
      if (Number.isFinite(refMin) && refMin > 0) timeMin = refMin;
    }
    // Audit OLA1 BUG#5: aplica overrides de IAS NO-LINEALMENTE.
    // Antes hacia `timeMin *= (planIas / ov.ias)`, que asume que GS
    // escala con IAS — falso con viento: GS = TAS - HW, y la
    // componente HW NO cambia al cambiar IAS. Si tenemos refetched
    // TAS+wind reales, recalculamos GS correctamente y derivamos el
    // tiempo. Si no, caemos al escalado lineal (mejor que nada).
    const ov = session.overrides;
    if (ov && Number.isFinite(ov.ias) && ov.ias > 0 && ov.fromIdx != null && ov.fromIdx <= idx) {
      const geom = window.TSAgestor && window.TSAgestor.geom;
      let newGS = null;
      if (session.refetched && Number.isFinite(lp.legNM) && lp.legNM > 0 &&
          geom && typeof geom.kiasToTAS === 'function') {
        const rIdx = idx - session.refetched.startIdx;
        const daFt = (rIdx >= 0 && session.refetched.legDa && Number.isFinite(session.refetched.legDa[rIdx]))
          ? session.refetched.legDa[rIdx]
          : (Number.isFinite(session.coords[idx].fl) ? session.coords[idx].fl * 100 : null);
        if (Number.isFinite(daFt)) {
          const newTAS = geom.kiasToTAS(ov.ias, daFt);
          // Headwind real del refetched (signo: + es cara).
          let hw = 0;
          if (session.refetched.legWindDir && session.refetched.legWindSpeed) {
            const wDir = session.refetched.legWindDir[rIdx];
            const wSpd = session.refetched.legWindSpeed[rIdx];
            if (Number.isFinite(wDir) && Number.isFinite(wSpd)) {
              const bearing = _bearingDeg(session.coords[idx - 1], session.coords[idx]);
              hw = -wSpd * Math.cos((wDir - bearing) * Math.PI / 180);
            }
          }
          if (Number.isFinite(newTAS) && newTAS > 0) {
            newGS = Math.max(30, newTAS - hw);
          }
        }
      }
      if (Number.isFinite(newGS) && newGS > 0) {
        timeMin = (lp.legNM / newGS) * 60;
      } else {
        // Fallback lineal cuando no hay datos refetched.
        const planIas = lp.ias || _planIasFromPlan() || 120;
        timeMin = timeMin * (planIas / ov.ias);
      }
    }
    return timeMin;
  }

  function _planIasFromPlan() {
    const plan = _getPlan();
    if (!plan || !plan.fuel || !plan.fuel.rows) return null;
    const first = plan.fuel.rows.find(l => Number.isFinite(l.legIAS));
    return first ? first.legIAS : null;
  }

  // ── Recalculo principal ────────────────────────────────────────────
  function _invalidateRecalc() { _recalcDirty = true; _recalcCache = null; }
  function _recalc() {
    if (!session) return [];
    // F2.8: si nada ha cambiado desde el ultimo recalc, devuelve cache.
    // Reduce ~60-70% CPU en _tick para planes con 20+ WPs.
    if (!_recalcDirty && _recalcCache) return _recalcCache;
    const rows = _recalcImpl();
    _recalcCache = rows;
    _recalcDirty = false;
    return rows;
  }
  function _recalcImpl() {
    if (!session) return [];
    const N = session.coords.length;
    const rows = [];

    // ETA live por WP
    function lastKnownLE(idx) {
      for (let k = idx; k >= 0; k--) {
        if (session.actualPassTimes[k] != null) return k;
      }
      return null;
    }

    for (let i = 0; i < N; i++) {
      const c = session.coords[i];
      const lp = session.legPlan[i];
      const planEta = session.plannedEtas[i];
      let liveEta = null;

      const pass = session.actualPassTimes[i];
      if (pass != null) {
        liveEta = pass;
      } else if (session.started) {
        const knownIdx = lastKnownLE(i);
        if (knownIdx != null) {
          // Suma leg times de knownIdx+1 hasta i.
          // Test report: el HOLD AT WP knownIdx (donde estoy ahora)
          // retrasa la salida HACIA el siguiente WP. Antes el bucle
          // empezaba en k=knownIdx+1 y solo sumaba liveHolds[k>knownIdx],
          // asi que un hold introducido en el WP actual no afectaba
          // a las ETAs siguientes. Anyado liveHolds[knownIdx] una vez
          // antes del bucle.
          let t = session.actualPassTimes[knownIdx];
          const holdAtKnown = Number(session.liveHolds[knownIdx]) || 0;
          if (holdAtKnown > 0) t += holdAtKnown * 60000;
          for (let k = knownIdx + 1; k <= i; k++) {
            t += _legTimeMinAt(k) * 60000;
            // Holds vivos en k (retraso AT k antes de salir HACIA k+1)
            const hm = Number(session.liveHolds[k]) || 0;
            if (hm > 0) t += hm * 60000;
          }
          liveEta = t;
        } else if (i === 0) {
          // No deberia llegar aqui si started=true (proposedStartTime se
          // grabo en actualPassTimes[0]), pero fallback razonable.
          liveEta = session.proposedStartTime;
        }
      } else {
        // Preview pre-iniciar ruta: liveEta = planEta
        liveEta = planEta;
      }

      // Combustible restante:
      // 1. Si hay override explicito para este WP, usalo
      // 2. Si no, propaga desde el override anterior usando legFuel
      //    (con override de flow si aplica)
      let fuelRest = _computeFuelRest(i);

      const joker = session.fuelOpts.joker;
      const bingo = session.fuelOpts.bingo;
      let fuelStatus = 'ok';
      if (Number.isFinite(bingo) && fuelRest <= bingo) fuelStatus = 'bingo';
      else if (Number.isFinite(joker) && fuelRest <= joker) fuelStatus = 'joker';

      // BUG#11: si hay refetched winds que cubren este leg, sobrescribe
      // la columna Viento con el dato fresco. Antes la columna mostraba
      // siempre lp.wind, asi que un plan calculado SIN viento dejaba
      // "—" aunque el refetch trajera datos validos.
      let windToUse = lp ? lp.wind : null;
      // BUG#11: igual con TAS / GS — si el refetch recalculo TAS via DA
      // real (geom.kiasToTAS con OAT), preferir ese valor sobre el
      // legPlan cacheado del plan original.
      let tasToUse = lp ? lp.tas : null;
      let gsToUse  = lp ? lp.gs  : null;
      if (session.refetched && i >= session.refetched.startIdx) {
        const rIdx = i - session.refetched.startIdx;
        const wdir = session.refetched.legWindDir   && session.refetched.legWindDir[rIdx];
        const wspd = session.refetched.legWindSpeed && session.refetched.legWindSpeed[rIdx];
        if (Number.isFinite(wdir) && Number.isFinite(wspd)) {
          windToUse = { dir: wdir, speedKt: wspd };
        }
        const rTas = session.refetched.legTas && session.refetched.legTas[rIdx];
        if (Number.isFinite(rTas) && rTas > 0) tasToUse = rTas;
        if (lp && Number.isFinite(lp.legNM) && lp.legNM > 0) {
          const tMin = session.refetched.legTimes && session.refetched.legTimes[rIdx];
          if (Number.isFinite(tMin) && tMin > 0) {
            gsToUse = (lp.legNM / tMin) * 60;
          }
        }
      }

      rows.push({
        i,
        name: c.name,
        fl: c.fl,
        isSub: c.isSub,
        planEta,
        liveEta,
        delta: (planEta != null && liveEta != null) ? (liveEta - planEta) : null,
        fuelRest,
        fuelRestOverridden: session.fuelOverrides[i] != null,
        fuelStatus,
        ias:  lp ? lp.ias : null,
        tas:  tasToUse,
        gs:   gsToUse,
        wind: windToUse,
        passReal: pass != null,
        isCurrent: i === session.currentIdx,
        isPast: i < session.currentIdx,
        liveHoldMin: Number(session.liveHolds[i]) || 0,
      });
    }
    return rows;
  }

  // Combustible restante en WP i:
  //   - busca el ultimo override <= i, usalo como base
  //   - suma los legFuel de cada leg posterior aplicando flow override
  //     si esta activo
  function _computeFuelRest(i) {
    if (!session) return 0;
    const overrides = session.fuelOverrides || {};
    let baseIdx = -1;
    for (let k = i; k >= 0; k--) {
      if (overrides[k] != null) { baseIdx = k; break; }
    }
    let rest;
    let baseFromOverride = false;
    if (baseIdx >= 0) {
      rest = Number(overrides[baseIdx]);
      baseFromOverride = true;
    } else {
      // Empieza desde initialFuel en idx 0
      rest = session.fuelOpts.initialFuel || 0;
      baseIdx = 0;
    }
    const flowOv = session.overrides;
    // Test report: si NO hay override explicito en el WP base,
    // initialFuel es pre-flight (antes de cualquier hold). Un hold AT
    // WP 0 (o el baseIdx) consume durante el hold y debe restarse de
    // rest una sola vez. Si SI hay override, ese override es el fuel
    // medido AHORA (post-hold), asi que NO sumamos el hold ahi.
    if (!baseFromOverride) {
      const holdAtBase = Number(session.liveHolds[baseIdx]) || 0;
      if (holdAtBase > 0) {
        // Flow durante el hold: override de flow si aplica, sino flow
        // del leg arriving o el flow base del plan.
        const lpBase = session.legPlan[baseIdx];
        const ovAppliesHere = flowOv && Number.isFinite(flowOv.flow) &&
                              flowOv.fromIdx != null && flowOv.fromIdx <= baseIdx + 1;
        const holdFlow = ovAppliesHere
          ? flowOv.flow
          : (lpBase && lpBase.flow ? lpBase.flow : session.fuelOpts.fuelFlow);
        rest -= (holdAtBase / 60) * holdFlow;
      }
    }
    for (let k = baseIdx + 1; k <= i; k++) {
      const lp = session.legPlan[k];
      let legFuel = lp ? lp.legFuel : 0;
      // Si hay override de flow que aplica a este leg, recalcula
      if (flowOv && Number.isFinite(flowOv.flow) && flowOv.flow >= 0 &&
          flowOv.fromIdx != null && flowOv.fromIdx <= k) {
        const planFlow = lp ? lp.flow : 0;
        if (planFlow > 0) legFuel = legFuel * (flowOv.flow / planFlow);
      }
      // Holds vivos en este k anyaden tiempo y por tanto combustible.
      // Audit OLA1 BUG#10: el override de flow se aplica al hold AL
      // ARRANCAR el override (fromIdx==k+1, convencion de
      // _confirmWpAlert). Antes el hold AT k usaba lp.flow (leg
      // precedente) porque exigiamos fromIdx<=k — el operador acababa
      // de definir el override en el WP-alert pero el hold AT el
      // mismo WP no lo veia. Aceptamos tambien fromIdx==k+1.
      const holdMin = Number(session.liveHolds[k]) || 0;
      if (holdMin > 0) {
        const ovAppliesHere = flowOv && Number.isFinite(flowOv.flow) &&
                              flowOv.fromIdx != null && flowOv.fromIdx <= k + 1;
        const holdFlow = ovAppliesHere
          ? flowOv.flow
          : (lp ? lp.flow : session.fuelOpts.fuelFlow);
        legFuel += (holdMin / 60) * holdFlow;
      }
      rest -= legFuel;
    }
    return rest;
  }

  // ── Vuelta a base (RTB) ────────────────────────────────────────────
  // Audit v3 BLOCKER#2: el calculo anterior usaba GS = IAS (sin viento
  // ni correccion DA) y distancia como suma de legs de IDA, lo que
  // subestimaba el tiempo y combustible 30-40% con viento adverso —
  // decision GO/NO-GO comprometida. La version corregida:
  //   1. Distancia: directa actual->origen (haversine), no la ruta de
  //      ida. RTB es un divert directo, no devolver por la misma ruta.
  //      Tambien se ofrece la suma de legs como referencia para el
  //      operador, pero la decision usa la directa.
  //   2. TAS: kiasToTAS(IAS, DA) usando el FL actual y la DA del
  //      refetched.legDa si disponible, sino la DA estandar ISA.
  //   3. GS: TAS + headwind componente desde el viento medio del
  //      refetched, evaluado en el bearing actual->origen.
  //   4. Warn si BINGO no esta configurado (fuelOpts.bingo == null).
  function _evalRTB() {
    if (!session) return null;
    const curr = session.currentIdx;
    if (curr <= 0) return { distanceNM: 0, minutes: 0, fuelNeeded: 0, ok: true, bingoConfigured: Number.isFinite(session.fuelOpts.bingo) };
    const coords = session.coords;
    // Distancia DIRECTA actual -> origen (great-circle), no la suma de
    // legs por la ruta de ida. RTB es un divert: el avion vuela
    // directo al aerodromo de origen, no rebobina la ruta.
    const A = coords[curr];
    const O = coords[0];
    const distKMDirect = _greatCircleKM(A.lat, A.lon, O.lat, O.lon);
    const distNM = distKMDirect / 1.852;
    // Suma de legs (referencia operativa, no decision)
    let distKMviaPlan = 0;
    for (let k = 1; k <= curr; k++) {
      const P = coords[k - 1], Q = coords[k];
      distKMviaPlan += _greatCircleKM(P.lat, P.lon, Q.lat, Q.lon);
    }
    const distanceNMviaPlan = distKMviaPlan / 1.852;

    const ov = session.overrides;
    const iasUsed = (ov && Number.isFinite(ov.ias)) ? ov.ias : (_planIasFromPlan() || 120);

    // TAS via DA real (refetched si disponible) o ISA del FL actual.
    const fl = Number.isFinite(A.fl) ? A.fl : (session.fuelOpts.flightLevel || 100);
    const paFt = fl * 100;
    const geom = window.TSAgestor && window.TSAgestor.geom;
    let daFt = paFt; // fallback ISA
    if (session.refetched && Array.isArray(session.refetched.legDa)) {
      const rIdx = curr - session.refetched.startIdx;
      if (rIdx >= 0 && Number.isFinite(session.refetched.legDa[rIdx])) {
        daFt = session.refetched.legDa[rIdx];
      }
    }
    let tas = iasUsed;
    if (geom && typeof geom.kiasToTAS === 'function') {
      const t = geom.kiasToTAS(iasUsed, daFt);
      if (Number.isFinite(t) && t > 0) tas = t;
    }

    // Headwind component: viento del refetched (en el WP actual) o sin
    // viento si no hay datos. Bearing actual->origen.
    let headwindKt = 0;
    let windAvailable = false;
    if (session.refetched && Array.isArray(session.refetched.legWindDir) &&
        Array.isArray(session.refetched.legWindSpeed)) {
      const rIdx = curr - session.refetched.startIdx;
      const wDir = session.refetched.legWindDir[rIdx];
      const wSpd = session.refetched.legWindSpeed[rIdx];
      if (Number.isFinite(wDir) && Number.isFinite(wSpd)) {
        const bearing = _bearingDeg(A, O);
        // Viento meteorologico (FROM): headwind positivo = cara.
        headwindKt = -wSpd * Math.cos((wDir - bearing) * Math.PI / 180);
        windAvailable = true;
      }
    }
    const gs = Math.max(30, tas - headwindKt);

    const hours = distNM / gs;
    const minutes = hours * 60;
    const flow = (ov && Number.isFinite(ov.flow)) ? ov.flow : session.fuelOpts.fuelFlow;
    const fuelNeeded = hours * flow;
    const rows = _recalc();
    const currentRow = rows[curr];
    const fuelNow = currentRow ? currentRow.fuelRest : 0;
    const bingoConfigured = Number.isFinite(session.fuelOpts.bingo);
    const bingo = bingoConfigured ? session.fuelOpts.bingo : 0;
    const fuelAfterRtb = fuelNow - fuelNeeded;
    const ok = bingoConfigured ? (fuelAfterRtb >= bingo) : (fuelAfterRtb >= 0);
    return {
      distanceNM: distNM,
      distanceNMviaPlan,
      minutes,
      fuelNeeded,
      fuelNow,
      fuelAfterRtb,
      bingo,
      bingoConfigured,
      windAvailable,
      headwindKt,
      tas, gs,
      ok,
    };
  }
  function _greatCircleKM(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ── Refetch de viento ──────────────────────────────────────────────
  // Llama a meteoApi.fetchWindsAloft para los WPs restantes y recalcula
  // los tiempos de leg con el viento nuevo. F2.1: ademas recalcula
  // TAS via DA real (geom.kiasToTAS) usando la temperatura refetched
  // en vez de la TAS cacheada del plan original. F2.2: marca
  // fetchedAt para que _renderEval pueda mostrar la edad del viento.
  // F2.7: acumula desviaciones ISA > 3°C para alertarlas.
  async function _refetchWinds() {
    if (!session || !session.started) return;
    if (_refetchInFlight) return;
    const startIdx = session.currentIdx;
    if (startIdx >= session.coords.length - 1) return;
    const meteo = window.TSAgestor && window.TSAgestor.meteoApi;
    if (!meteo || !meteo.fetchWindsAloft || !meteo.lookupWindAt) return;
    const geom = window.TSAgestor && window.TSAgestor.geom;

    // BUG#1+#2 (audit v2): snapshot defensivo + epoch para detectar
    // que la session no haya cambiado mientras await. Sin esto, un
    // reset / engage RTB / cancel RTB / rebuild del plan durante el
    // fetch deja `session.refetched.legTimes` indexado a coords
    // antiguas -> ETA del WP rota silenciosamente. Iteramos sobre los
    // snapshots para que la respuesta sea internamente consistente.
    const myEpoch    = _sessionEpoch;
    const coordsSnap = session.coords.slice();
    const legPlanSnap = session.legPlan.slice();
    const refStartMs = session.actualPassTimes[startIdx] || session.proposedStartTime || Date.now();

    const remaining = coordsSnap.slice(startIdx);
    const points = remaining.map(c => ({ lat: c.lat, lon: c.lon }));
    _refetchInFlight = true;
    // F2.x sale render aqui para que el spinner "⏳ Refrescando vientos
    // en altura..." aparezca DURANTE el fetch, no solo al final.
    _refresh();
    try {
      const result = await meteo.fetchWindsAloft(points);
      // BUG#1: si la session cambio durante await, descartar y limpiar
      // flag para no bloquear el proximo refetch.
      if (!session || _sessionEpoch !== myEpoch) {
        _refetchInFlight = false;
        _refresh();
        return;
      }
      const ph = result && result.pointsHourly;
      if (!ph || !ph.length) {
        _refetchInFlight = false;
        _refresh(); // limpia el spinner
        return;
      }
      // Buffers paralelos: tiempos, TAS, DA, OAT, viento (dir + speed)
      // por leg. legTimes[0] queda a 0 (padding para que el indice
      // local k - startIdx mapee directo al leg k).
      const legTimes     = [0];
      const legTas       = [null];
      const legDa        = [null];
      const legOat       = [null];
      // BUG#11: capturamos viento (dir + speed) para que _recalcImpl
      // pueda pintar la columna Viento con datos refetched. Antes
      // legPlan[k].wind era la unica fuente -> "—" si el plan se
      // calculo sin viento.
      const legWindDir   = [null];
      const legWindSpeed = [null];
      const isaDeviations = []; // F2.7: WPs con |OAT - ISA(PA)| > 3 °C
      let etaMs = refStartMs;
      for (let k = startIdx + 1; k < coordsSnap.length; k++) {
        const localIdx = k - startIdx;
        const phCurr = ph[localIdx];
        const lp = legPlanSnap[k];
        const fl = coordsSnap[k].fl || 100;
        let legTimeMin = lp ? lp.legTimeMin : 0;
        let tasUsed    = lp ? lp.tas : null;
        let daFt       = null;
        let oatC       = null;
        const wB = phCurr ? meteo.lookupWindAt(phCurr, etaMs, fl) : null;
        if (wB && Number.isFinite(wB.windSpeedKt) && Number.isFinite(wB.windDir)) {
          legWindDir[localIdx]   = wB.windDir;
          legWindSpeed[localIdx] = wB.windSpeedKt;
          // F2.1: recalcula TAS si tenemos IAS del plan + OAT del refetch + geom.
          if (geom && Number.isFinite(wB.temperatureC) &&
              lp && Number.isFinite(lp.ias) && lp.ias > 0 &&
              typeof geom.densityAltitudeFt === 'function' &&
              typeof geom.kiasToTAS === 'function') {
            oatC = wB.temperatureC;
            daFt = geom.densityAltitudeFt(fl * 100, oatC);
            const tasNew = geom.kiasToTAS(lp.ias, daFt);
            if (Number.isFinite(tasNew) && tasNew > 0) tasUsed = tasNew;
            // F2.7: desviacion ISA
            if (typeof geom.isaTempC === 'function') {
              const isaC = geom.isaTempC(fl * 100);
              const devC = oatC - isaC;
              if (Math.abs(devC) > 3) {
                isaDeviations.push({
                  idx: k, name: coordsSnap[k].name,
                  oatC, isaC, devC, daFt, fl,
                });
              }
            }
          }
          if (Number.isFinite(tasUsed) && lp && Number.isFinite(lp.legNM) && lp.legNM > 0) {
            const bearing = _bearingDeg(coordsSnap[k - 1], coordsSnap[k]);
            const hw = -wB.windSpeedKt * Math.cos((wB.windDir - bearing) * Math.PI / 180);
            const gs = Math.max(30, tasUsed + hw);
            legTimeMin = (lp.legNM / gs) * 60;
          }
        }
        legTimes[localIdx] = legTimeMin;
        legTas[localIdx]   = tasUsed;
        legDa[localIdx]    = daFt;
        legOat[localIdx]   = oatC;
        etaMs += legTimeMin * 60000;
      }
      // BUG#1: re-check epoch (puede haber cambiado durante el bucle
      // si hubo cross-tab sync, p.ej.).
      if (!session || _sessionEpoch !== myEpoch) {
        _refetchInFlight = false;
        _refresh();
        return;
      }
      // F2.2: fetchedAt para mostrar antiguedad. legTas / legDa / legOat
      // / legWindDir / legWindSpeed persistidos para que la tabla los
      // muestre tras el refetch.
      session.refetched = {
        startIdx, legTimes, legTas, legDa, legOat,
        legWindDir, legWindSpeed,
        fetchedAt: Date.now(),
        isaDeviations,
      };
      _invalidateRecalc();
      // F2.x bug fix: poner el flag a false ANTES de _refresh para que
      // _renderEval ya no muestre el spinner cuando recompone el DOM.
      _refetchInFlight = false;
      _saveSession();
      _refresh();
    } catch (e) {
      console.warn('[livePlan] refetch winds fallo:', e && e.message ? e.message : e);
      // Mismo patron: limpiar flag y refrescar para quitar el spinner
      // antes de mostrar el toast de error.
      _refetchInFlight = false;
      _refresh();
      _showToast({
        id: 'wind-refetch-fail', level: 'warn',
        title: 'Refresh de viento falló',
        message: (e && e.message) ? e.message : 'Error desconocido',
        autoDismissMs: 6000,
      });
    }
  }

  // ── F2.5: SIGMET cross-check vs ruta restante ─────────────────────
  // Geometria: helpers minimos copiados de flightPlan.js (internos al
  // IIFE alli; duplicar 15 lineas vs exponer rompe encapsulacion).
  function _pointInPolyLL(pt, poly) {
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
  function _segIntersect(p1, p2, p3, p4) {
    const ccw = (A, B, C) => (C[0] - A[0]) * (B[1] - A[1]) > (B[0] - A[0]) * (C[1] - A[1]);
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
           ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  }
  function _segCrossesPoly(a, b, poly) {
    if (_pointInPolyLL(a, poly) || _pointInPolyLL(b, poly)) return true;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      if (_segIntersect(a, b, poly[i], poly[(i + 1) % n])) return true;
    }
    return false;
  }
  // Distancia geodesica simple en metros (Haversine).
  function _distM(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // Cross-check segmento AB vs circulo (centro,radioM): si A o B
  // estan dentro, o la distancia minima de cualquier extremo a centro
  // es < radioM. Aproximacion conservadora.
  function _segCrossesCircle(a, b, center, radiusM) {
    return _distM(a, center) <= radiusM || _distM(b, center) <= radiusM;
  }

  function _maybeRefreshSigmets() {
    if (!session || !session.started) return;
    if (_sigmetInFlight) return;
    if (_sigmetCache && (Date.now() - _sigmetCache.fetchedAt) < 20 * 60 * 1000) {
      // No refresh; pero recomputa el cross-check con la posicion actual.
      _recomputeSigmetCrossings();
      return;
    }
    // Audit OLA1 BUG#9: si el ultimo intento fallo hace menos de 2
    // minutos, no reintentamos — antes hammereabamos AWC en cada tick
    // mientras el endpoint estuviera caido. El operador puede pulsar
    // Refresh manualmente si urge.
    if (_sigmetLastError && (Date.now() - _sigmetLastError) < SIGMET_ERROR_COOLDOWN_MS) return;
    const meteo = window.TSAgestor && window.TSAgestor.meteoApi;
    if (!meteo || typeof meteo.fetchSigmets !== 'function' || typeof meteo.parseSigmetGeometry !== 'function') return;
    _sigmetInFlight = true;
    meteo.fetchSigmets().then((sigmets) => {
      const list = Array.isArray(sigmets) ? sigmets : [];
      const geoms = list.map(s => {
        try { return { sig: s, geom: meteo.parseSigmetGeometry(s) }; }
        catch (_) { return null; }
      }).filter(x => x && x.geom);
      _sigmetCache = { sigmets: list, geoms, fetchedAt: Date.now() };
      _sigmetLastError = 0; // reset backoff tras success
      _recomputeSigmetCrossings();
      _refresh();
    }).catch((e) => {
      console.warn('[livePlan] SIGMETs fallo:', e && e.message);
      _sigmetLastError = Date.now();
    }).finally(() => {
      _sigmetInFlight = false;
    });
  }
  function _recomputeSigmetCrossings() {
    if (!session || !_sigmetCache) { _sigmetCrossings = []; return; }
    const startIdx = Math.max(0, session.currentIdx);
    const out = [];
    for (const item of _sigmetCache.geoms) {
      const { sig, geom } = item;
      let crosses = false;
      for (let k = startIdx + 1; k < session.coords.length; k++) {
        const A = session.coords[k - 1], B = session.coords[k];
        if (!Number.isFinite(A.lat) || !Number.isFinite(B.lat)) continue;
        const pA = [A.lat, A.lon], pB = [B.lat, B.lon];
        if (geom.kind === 'poly') {
          if (_segCrossesPoly(pA, pB, geom.latlngs)) { crosses = true; break; }
        } else if (geom.kind === 'circle') {
          if (_segCrossesCircle(pA, pB, geom.center, geom.radiusM)) { crosses = true; break; }
        }
      }
      if (crosses) {
        const haz = sig.hazard || sig.hazardType || sig.phen || 'SIGMET';
        const fir = sig.firId || sig.icaoId || sig.firCode || '';
        const rawShort = (sig.rawSigmet || '').slice(0, 120);
        out.push({ haz, fir, rawShort, raw: sig.rawSigmet || '' });
      }
    }
    _sigmetCrossings = out;
  }

  function _bearingDeg(A, B) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const dLon = toRad(B.lon - A.lon);
    const y = Math.sin(dLon) * Math.cos(toRad(B.lat));
    const x = Math.cos(toRad(A.lat)) * Math.sin(toRad(B.lat)) -
              Math.sin(toRad(A.lat)) * Math.cos(toRad(B.lat)) * Math.cos(dLon);
    let b = toDeg(Math.atan2(y, x));
    if (b < 0) b += 360;
    return b;
  }

  // ── UI wire ────────────────────────────────────────────────────────
  // F3.1: atajos de teclado para acciones frecuentes en cabina.
  // Solo se activan cuando la seccion Live esta visible y el foco
  // NO esta en un input/textarea/select para no robar la escritura.
  function _isLiveSectionVisible() {
    // tab-live tiene class 'active' cuando b1Layout lo trae al panel.
    const sec = document.getElementById('tab-live');
    if (!sec) return false;
    if (sec.classList.contains('active')) return true;
    // Fallback: detecta si la card de Estado actual esta visible.
    const c = document.getElementById('live-content');
    if (c && !c.classList.contains('hidden')) {
      // Comprueba que el ancestro mas cercano sea visible (no display:none)
      try { return c.offsetParent !== null; } catch (_) { return false; }
    }
    return false;
  }
  function _onKeydown(e) {
    if (!_isLiveSectionVisible()) return;
    const tgt = e.target;
    if (tgt && tgt.matches && tgt.matches('input, textarea, select, [contenteditable]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    switch (e.key) {
      case 'a': case 'A': e.preventDefault(); _advance(); return;
      case 'b': case 'B': e.preventDefault(); _back();    return;
      case 'h': case 'H': e.preventDefault(); _addHold(); return;
      case 'r': case 'R': e.preventDefault(); _refetchWinds(); return;
    }
  }

  // F3.6: storage event cross-tab. Si el operador abre Live en dos
  // pestanyas y avanza en una, la otra se sincroniza.
  function _onStorage(e) {
    if (!e || e.key !== STORAGE_KEY) return;
    _loadSession();
    _maybeShowContent();
  }

  function _wireUI() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.id === 'btn-live-start') { _iniciarRuta(); return; }
      if (t.id === 'btn-live-now')   { _setStartNow();  return; }
      if (t.id === 'btn-live-advance') { _advance(); return; }
      if (t.id === 'btn-live-back')    { _back(); return; }
      if (t.id === 'btn-live-hold')    { _addHold(); return; }
      if (t.id === 'btn-live-rtb')     { _showRtbInline(); return; }
      if (t.id === 'btn-live-reset')   { _resetSession(); return; }
      if (t.id === 'btn-live-apply-overrides') { _applyOverrides(); return; }
      if (t.id === 'btn-live-clear-overrides') { _clearOverrides(); return; }
      if (t.id === 'btn-live-refetch-winds') { _refetchWinds(); return; }
      if (t.id === 'btn-live-alert-confirm') { _confirmWpAlert(); return; }
      if (t.id === 'btn-live-alert-defer')   { _dismissWpAlert(); return; }
      if (t.id === 'btn-live-alert-close')   { _dismissWpAlert(); return; }
      if (t.id === 'btn-live-table-toggle')  { _toggleTableDetail(); return; }
      if (t.id === 'btn-live-save-flown')    { _saveFlown(); return; }
      if (t.id === 'btn-live-pdf-aar')       { _exportFlownPdf(); return; }
      // Bug 7 (test report): listar / re-exportar / borrar vuelos
      // realizados (AAR) guardados con savedPlans.saveFlown.
      if (t.id === 'btn-live-show-flown')    { _showFlownList(); return; }
      if (t.dataset && t.dataset.flownAct) {
        _onFlownAction(t.dataset.flownName, t.dataset.flownAct);
        return;
      }
    });
    // F3.1: atajos teclado A/B/H/R
    document.addEventListener('keydown', _onKeydown);
    // F3.6: sync cross-tab via storage event
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', _onStorage);
    }
    // Edicion in-place de fuel restante (input delegated)
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('live-fuel-input')) {
        const idx = parseInt(t.dataset.idx, 10);
        const val = parseFloat(t.value);
        _editFuelRest(idx, val);
      }
    });
  }
  function _startClock() {
    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(_tick, 1000);
    _tick();
  }
  function _tick() {
    // F1.4: skip si el tab esta oculto — ahorra CPU/bateria en tablet.
    // visibilitychange dispara un tick inmediato al volver (ver
    // _wireVisibility) asi que el reloj se actualiza al instante.
    if (typeof document !== 'undefined' && document.hidden) return;
    const d = new Date();
    const txt = String(d.getUTCHours()).padStart(2, '0') + ':' +
                String(d.getUTCMinutes()).padStart(2, '0') + ':' +
                String(d.getUTCSeconds()).padStart(2, '0');
    // Hay dos relojes en la UI (preflight + en-vuelo).
    const a = document.getElementById('live-clock-utc');
    const b = document.getElementById('live-clock-utc-2');
    if (a) a.textContent = txt;
    if (b) b.textContent = txt;
    // Comprueba si la ETA del siguiente WP real ha sido alcanzada
    // y, de ser asi, dispara el modal de alerta (una vez por WP).
    _checkWpAlertOnTick();
  }
  function _wireVisibility() {
    if (_visibilityWired) return;
    if (typeof document === 'undefined' || !document.addEventListener) return;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // Acabamos de volver al tab. Tick inmediato para que la UI
        // refleje la realidad sin esperar al siguiente segundo.
        _tick();
      }
    });
    _visibilityWired = true;
  }

  // Indice del siguiente WP "real" (saltando sub-legs).
  function _nextRealIdx() {
    if (!session) return null;
    let k = session.currentIdx + 1;
    while (k < session.coords.length && session.coords[k].isSub) k++;
    return k < session.coords.length ? k : null;
  }

  function _checkWpAlertOnTick() {
    if (!session || !session.started) return;
    // BUG#10 (audit v2): el WP-alert ahora es un toast (F1.5), no el
    // modal antiguo <#live-wp-alert>. Buscar por data-toast-id para
    // que el guard "ya hay alert abierto" siga funcionando — antes
    // este getElementById devolvia null SIEMPRE y, si dos ETAs caian
    // en el mismo tick (tipico tras refetch que reduce legs), el
    // segundo toast reemplazaba al primero dejando el primer WP
    // marcado en alertedWPs sin haber sido confirmado.
    const openToast = document.querySelector('.live-toast[data-toast-id="wp-alert"]');
    if (openToast) return;
    const idx = _nextRealIdx();
    if (idx == null) return;
    if (session.alertedWPs && session.alertedWPs[idx]) return;
    const rows = _recalc();
    const r = rows[idx];
    if (!r || !Number.isFinite(r.liveEta)) return;
    if (Date.now() < r.liveEta) return;
    // BUG#10: marca alertedWPs DESPUES de mostrar el toast — asi si
    // _showWpAlert falla (DOM no listo, lo que sea) no queda el flag
    // bloqueando futuros intentos.
    _showWpAlert(idx);
    if (!session.alertedWPs) session.alertedWPs = {};
    session.alertedWPs[idx] = true;
    _saveSession();
  }

  // F1.5: WP-alert como toast NO-BLOQUEANTE top-right. Sustituye al
  // antiguo modal centrado con backdrop que rompia la lectura del
  // mapa. Conserva los 4 inputs (IAS/FF/FL/Fuel) y los 2 botones
  // (Confirmar / Aun no). Marca un indicador rojo persistente en la
  // card "Estado actual" hasta que el operador atienda. Beep WebAudio
  // + vibracion al aparecer (configurable). Click fuera NO cierra.
  function _showWpAlert(idx) {
    if (!session) return;
    const c = session.coords[idx];
    const lp = session.legPlan[idx];
    const rows = _recalc();
    const r = rows[idx];
    const ov = session.overrides;
    const iasVal  = (ov && Number.isFinite(ov.ias))  ? ov.ias
                  : (lp && Number.isFinite(lp.ias))  ? Math.round(lp.ias) : '';
    const flowVal = (ov && Number.isFinite(ov.flow)) ? ov.flow
                  : (lp && Number.isFinite(lp.flow)) ? Math.round(lp.flow) : '';
    const flVal   = (ov && Number.isFinite(ov.fl))   ? ov.fl
                  : Number.isFinite(c.fl)            ? c.fl : '';
    const fuelVal = (r && Number.isFinite(r.fuelRest)) ? Math.round(r.fuelRest) : '';

    // Cuerpo del toast: 4 inputs en grid + 2 botones de accion.
    const bodyHTML =
      '<div class="live-alert-grid">' +
        '<label class="live-override-label"><span>IAS (kt)</span>' +
          `<input type="number" id="live-alert-ias" min="50" max="900" step="5" value="${iasVal}"></label>` +
        '<label class="live-override-label"><span>FF / Flow (/h)</span>' +
          `<input type="number" id="live-alert-flow" min="0" step="10" value="${flowVal}"></label>` +
        '<label class="live-override-label"><span>FL</span>' +
          `<input type="number" id="live-alert-fl" min="10" max="600" step="5" value="${flVal}"></label>` +
        '<label class="live-override-label"><span>Combustible total</span>' +
          `<input type="number" id="live-alert-fuel" step="10" value="${fuelVal}"></label>` +
      '</div>';
    const actionsHTML =
      '<button id="btn-live-alert-confirm" class="btn btn-primary btn-sm" type="button">✓ Confirmar paso</button>' +
      '<button id="btn-live-alert-defer" class="btn btn-ghost btn-sm" type="button">Aún no</button>';
    const toast = _showToast({
      id: 'wp-alert',
      level: 'warn',
      title: `ETA alcanzada: WP #${idx + 1} · ${c.name}`,
      message: 'Si has pasado por él, confirma (registra Date.now() y aplica ajustes desde el siguiente leg). Si aún no, descártalo y usa "Estoy en próximo WP" cuando llegues.',
      bodyHTML, actionsHTML,
      closeable: false,
      // UX: centrado en pantalla con backdrop oscurecido para que sea
      // imposible perderlo en cabina. Sigue siendo no bloqueante (no
      // captura clicks fuera del toast) por compromiso entre atencion
      // y poder consultar el mapa en paralelo.
      centered: true,
      backdrop: true,
    });
    if (toast) toast.dataset.targetIdx = String(idx);
    // F3.4: foco en el primer input para teclado-friendly.
    setTimeout(() => {
      const first = document.getElementById('live-alert-ias');
      if (first && typeof first.focus === 'function') {
        try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); }
      }
    }, 50);
    // Indicador rojo persistente en la card "Estado actual" hasta atender.
    _setEtaAlertIndicator(true, idx);
    // Beep WebAudio + vibracion (best-effort, sin bloqueo si fallan).
    _playEtaBeep();
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate([200, 100, 200]); } catch (_) {}
    }
    // F2.11: Notification API si tab oculto.
    _maybeNotifyBackground(
      `ETA alcanzada · WP #${idx + 1} ${c.name}`,
      'Vuelve a la pestaña Live para confirmar el paso o ajustar parámetros.'
    );
  }

  // Indicador persistente "ETA alcanzada — atender". Vive en la card
  // de Estado actual; se quita al confirmar o descartar.
  function _setEtaAlertIndicator(on, idx) {
    const statusCard = document.querySelector('.live-status-card');
    if (!statusCard) return;
    let badge = document.getElementById('live-eta-alert-badge');
    if (!on) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'live-eta-alert-badge';
      badge.className = 'live-eta-alert-badge';
      const head = statusCard.querySelector('.live-card-head');
      if (head) head.appendChild(badge);
    }
    badge.textContent = `⚠ ETA WP #${(idx | 0) + 1} alcanzada`;
  }

  // Beep corto via WebAudio. Frecuencia 880 Hz, duracion 180ms,
  // fade-out para evitar click. Tolerante a errores (AudioContext
  // requiere gesture en algunos navegadores).
  function _playEtaBeep() {
    try {
      if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) return;
      if (!_etaAudioCtx) _etaAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _etaAudioCtx;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.2);
    } catch (_) {}
  }

  function _confirmWpAlert() {
    if (!session) return;
    // F1.5: el WP-alert ahora es un toast con id "wp-alert". Leemos
    // el targetIdx del dataset del toast.
    const toast = document.querySelector('.live-toast[data-toast-id="wp-alert"]');
    if (!toast) return;
    const idx = parseInt(toast.dataset.targetIdx, 10);
    if (!Number.isFinite(idx)) return;
    const iasEl  = document.getElementById('live-alert-ias');
    const flowEl = document.getElementById('live-alert-flow');
    const flEl   = document.getElementById('live-alert-fl');
    const fuelEl = document.getElementById('live-alert-fuel');
    const ias  = iasEl  ? parseFloat(iasEl.value)  : NaN;
    const flow = flowEl ? parseFloat(flowEl.value) : NaN;
    const fl   = flEl   ? parseFloat(flEl.value)   : NaN;
    const fuel = fuelEl ? parseFloat(fuelEl.value) : NaN;
    const now = Date.now();
    for (let k = session.currentIdx + 1; k <= idx; k++) {
      session.actualPassTimes[k] = now;
    }
    session.currentIdx = idx;
    const hasOv = Number.isFinite(ias) || Number.isFinite(flow) || Number.isFinite(fl);
    if (hasOv) {
      const prev = session.overrides || { fromIdx: null, ias: null, flow: null, fl: null };
      const newIas  = (Number.isFinite(ias)  && ias  > 0)  ? ias  : prev.ias;
      const newFlow = (Number.isFinite(flow) && flow >= 0) ? flow : prev.flow;
      const newFl   = (Number.isFinite(fl)   && fl   > 0)  ? fl   : prev.fl;
      // BUG#9 (audit v2): solo encoge fromIdx si el operador
      // REALMENTE cambio algun valor en el modal del WP-alert. Antes
      // cualquier "Confirmar paso" reseteaba fromIdx=idx+1 aunque el
      // operador no tocara IAS/Flow/FL — borrando un rango activo de
      // override IAS que el piloto queria conservar desde un WP
      // anterior.
      const changed = (Number.isFinite(ias)  && ias  > 0  && ias  !== prev.ias) ||
                      (Number.isFinite(flow) && flow >= 0 && flow !== prev.flow) ||
                      (Number.isFinite(fl)   && fl   > 0  && fl   !== prev.fl);
      const fromIdx = changed
        ? Math.min(idx + 1, session.coords.length - 1)
        : (prev.fromIdx != null ? prev.fromIdx
                                : Math.min(idx + 1, session.coords.length - 1));
      session.overrides = { fromIdx, ias: newIas, flow: newFlow, fl: newFl };
    }
    if (Number.isFinite(fuel)) {
      session.fuelOverrides[idx] = Math.max(0, fuel);
    }
    _saveSession();
    _dismissToast('wp-alert');
    _setEtaAlertIndicator(false);
    _refresh();
    _refetchWinds();
  }

  function _dismissWpAlert() {
    // alertedWPs[idx] ya esta seteado: el toast no re-aparece hasta
    // retrocede / reset / cambio del plan. Pero conservamos el badge
    // rojo en Estado actual para que el operador no olvide atender
    // la posicion cuando llegue (usa "Estoy en proximo WP").
    _dismissToast('wp-alert');
    // El badge se queda visible — el operador lo ve hasta que avance.
  }

  function _maybeShowContent() {
    const noPlan = document.getElementById('live-no-plan');
    const preflight = document.getElementById('live-preflight');
    const content = document.getElementById('live-content');
    const tableWrap = document.getElementById('live-log-table-wrap');
    if (!noPlan || !content || !preflight) return;

    const plan = _getPlan();
    if (!plan || !plan.coords || plan.coords.length < 2) {
      noPlan.classList.remove('hidden');
      preflight.classList.add('hidden');
      content.classList.add('hidden');
      if (tableWrap) tableWrap.classList.add('hidden');
      // Sin plan -> limpia cualquier marcador Live residual del mapa.
      const mv = window.TSAgestor && window.TSAgestor.mapView;
      if (mv && mv.clearLiveOverlay) mv.clearLiveOverlay();
      return;
    }
    noPlan.classList.add('hidden');

    // Sincroniza session con el plan actual
    if (!session || session.planId !== _hashPlan(plan)) _buildSessionFromPlan();

    if (!session.started) {
      preflight.classList.remove('hidden');
      content.classList.add('hidden');
      if (tableWrap) tableWrap.classList.remove('hidden');
      _renderPreflight();
      _applyTableMode();
      _refresh();
    } else {
      preflight.classList.add('hidden');
      content.classList.remove('hidden');
      if (tableWrap) tableWrap.classList.remove('hidden');
      _applyTableMode();
      _refresh();
    }
  }

  function _refresh() {
    if (!session) return;
    const rows = _recalc();
    _renderStatus(rows);
    _renderTable(rows);
    _renderEval(rows);
    _updateMapOverlay();
    // F2.4: auto-refresh METAR/TAF destino si falta poco para llegar.
    // Fire-and-forget — no bloquea el render.
    _maybeRefreshDestMet(rows);
    // F2.5: refresh SIGMETs (max cada 20 min) + recompute cross-check
    // contra la ruta restante.
    _maybeRefreshSigmets();
    // F2.6: cross-check TSAs activas en este instante.
    _recomputeActiveTSACrossings();
  }

  // F2.6: revisa TSAs cuyo schedule esta activo AHORA y verifica si la
  // ruta restante cruza alguna. Resultado en _activeTSAcrossings; el
  // _renderEval lo pinta como danger.
  function _recomputeActiveTSACrossings() {
    _activeTSAcrossings = [];
    if (!session) return;
    const app = window.TSAgestor && window.TSAgestor.app;
    if (!app || typeof app.getTsas !== 'function') return;
    const tsas = app.getTsas();
    if (!tsas || !tsas.length) return;
    const now = Date.now();
    const startIdx = Math.max(0, session.currentIdx);
    for (const t of tsas) {
      if (!t || !Array.isArray(t.polygon) || t.polygon.length < 3) continue;
      // Schedule activo: alguna ventana cubre `now`.
      const schedules = Array.isArray(t.schedules) ? t.schedules : [];
      const active = schedules.find(s => {
        const a = s.startUTC instanceof Date ? s.startUTC.getTime() : (s.startUTC ? new Date(s.startUTC).getTime() : null);
        const b = s.endUTC   instanceof Date ? s.endUTC.getTime()   : (s.endUTC   ? new Date(s.endUTC).getTime()   : null);
        return Number.isFinite(a) && Number.isFinite(b) && a <= now && now <= b;
      });
      if (!active) continue;
      // Cross-check contra ruta restante
      let crosses = false;
      for (let k = startIdx + 1; k < session.coords.length; k++) {
        const A = session.coords[k - 1], B = session.coords[k];
        if (!Number.isFinite(A.lat) || !Number.isFinite(B.lat)) continue;
        if (_segCrossesPoly([A.lat, A.lon], [B.lat, B.lon], t.polygon)) {
          crosses = true; break;
        }
      }
      if (crosses) {
        _activeTSAcrossings.push({
          name: t.name || 'TSA',
          endMs: active.endUTC instanceof Date ? active.endUTC.getTime() : new Date(active.endUTC).getTime(),
        });
      }
    }
  }

  // F2.4: si la ETA al destino esta a menos de 60 min y no se ha
  // refrescado en los ultimos 15 min, lanza fetchWeatherForAirports
  // para el ICAO destino. Cachea el resultado en _destMet para que
  // _renderEval lo pinte como entrada informativa. La frecuencia esta
  // codeada (15 min) para evitar abuso del endpoint AWC.
  function _maybeRefreshDestMet(rows) {
    if (!session || !session.started) return;
    if (_destMetInFlight) return;
    const last = session.coords.length - 1;
    const destRow = rows && rows[last];
    if (!destRow || !Number.isFinite(destRow.liveEta)) return;
    const minsToDest = (destRow.liveEta - Date.now()) / 60000;
    if (minsToDest > 60 || minsToDest < -30) return; // ventana sensata
    const meteo = window.TSAgestor && window.TSAgestor.meteoApi;
    if (!meteo || typeof meteo.fetchWeatherForAirports !== 'function') return;
    const icao = (session.coords[last] && session.coords[last].name || '').toUpperCase();
    if (!/^[A-Z]{4}$/.test(icao)) return; // no es ICAO valido
    if (_destMet && _destMet.icao === icao && (Date.now() - _destMet.fetchedAt) < 15 * 60 * 1000) {
      return; // refresh hace menos de 15 min
    }
    _destMetInFlight = true;
    meteo.fetchWeatherForAirports([icao]).then((res) => {
      const ap = res && res.airports && res.airports[icao];
      if (ap) {
        _destMet = {
          icao,
          metar: ap.metar || null,
          taf:   ap.taf   || null,
          fetchedAt: Date.now(),
        };
        _refresh();
      }
    }).catch((e) => {
      console.warn('[livePlan] METAR/TAF destino fallo:', e && e.message);
    }).finally(() => {
      _destMetInFlight = false;
    });
  }

  // F1.2 + F1.3: actualiza el marcador "soy aqui" y la linea de
  // progreso recorrida vs pendiente en el mapa. Solo dibuja si la
  // sesion esta arrancada — antes del Iniciar ruta el mapa muestra
  // unicamente la ruta del plan (renderFlightPlan).
  function _updateMapOverlay() {
    const mv = window.TSAgestor && window.TSAgestor.mapView;
    if (!mv || typeof mv.setLiveMarker !== 'function') return;
    // BUG#7 (audit v2): mantener sync el flag de supresion del plan
    // original en el mapa con session.rtbEngaged. Asi al recargar el
    // tab con RTB persistido + entrar a Live por primera vez, NO se
    // pinta la ruta amarilla del plan original sobre la cyan del
    // retorno. Igual al cancelar RTB sin pasar por _cancelRTB (raro).
    if (typeof mv.suppressFlightPlan === 'function') {
      mv.suppressFlightPlan(!!(session && session.rtbEngaged));
    }
    if (!session || !session.started || !session.coords || session.coords.length < 1) {
      mv.clearLiveOverlay && mv.clearLiveOverlay();
      return;
    }
    const idx = Math.max(0, Math.min(session.currentIdx | 0, session.coords.length - 1));
    const c = session.coords[idx];
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      mv.setLiveMarker([c.lat, c.lon]);
    } else {
      mv.setLiveMarker(null);
    }
    mv.setLiveProgress(session.coords, idx);
  }

  // ── Render: pre-flight (Iniciar ruta) ──────────────────────────────
  function _renderPreflight() {
    if (!session) return;
    const inp = document.getElementById('live-start-time');
    if (inp) {
      // Pre-rellena con la planificada (en formato datetime-local UTC).
      const ms = session.proposedStartTime || Date.now();
      inp.value = _msToDateTimeLocal(ms);
    }
    // F3.5: preview de los primeros 3-5 WPs con ETA planificada para
    // que el operador valide la ruta antes de iniciar el seguimiento.
    _renderPreflightPreview();
  }
  function _renderPreflightPreview() {
    if (!session) return;
    const host = document.getElementById('live-preflight');
    if (!host) return;
    // Bug 7 (test report): boton "Vuelos realizados" en el preflight
    // si hay alguno guardado. Antes _saveFlown escribia en localStorage
    // pero no habia UI para verlos / borrarlos / re-exportarlos.
    _renderFlownBanner(host);
    let prev = document.getElementById('live-preflight-preview');
    if (!prev) {
      prev = document.createElement('div');
      prev.id = 'live-preflight-preview';
      prev.className = 'live-card';
      host.appendChild(prev);
    }
    const coords = session.coords || [];
    const N = coords.length;
    const max = Math.min(5, N);
    let html = '<div class="live-card-head"><h3>Vista previa de la ruta</h3>' +
               `<span class="dim">${N} WPs · ${session.totalDistNM.toFixed(0)} NM</span></div>` +
               '<table class="live-preview-table"><thead><tr>' +
               '<th>#</th><th>Waypoint</th><th>FL</th><th>ETA plan</th></tr></thead><tbody>';
    for (let i = 0; i < max; i++) {
      const c = coords[i];
      const flTxt = Number.isFinite(c.fl) ? `FL${String(c.fl).padStart(3, '0')}` : '—';
      const eta = session.plannedEtas[i];
      html += `<tr${c.isSub ? ' class="live-row-sub"' : ''}>` +
              `<td>${i + 1}</td><td><b>${c.name}</b></td>` +
              `<td>${flTxt}</td><td>${_fmtTime(eta)}</td></tr>`;
    }
    if (N > max) {
      html += `<tr><td colspan="4" class="dim">… y ${N - max} WPs más (ver Log live para detalle)</td></tr>`;
    }
    html += '</tbody></table>';
    prev.innerHTML = html;
  }

  function _msToDateTimeLocal(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
           'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function _dateTimeLocalToMs(s) {
    // El input datetime-local devuelve "YYYY-MM-DDTHH:MM" sin zona;
    // lo interpretamos como UTC anyadiendo 'Z'.
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  }

  function _setStartNow() {
    const inp = document.getElementById('live-start-time');
    if (inp) inp.value = _msToDateTimeLocal(Date.now());
  }

  function _iniciarRuta() {
    if (!session) return;
    const inp = document.getElementById('live-start-time');
    const ms = inp ? _dateTimeLocalToMs(inp.value) : null;
    const startMs = ms || Date.now();
    session.started = true;
    session.proposedStartTime = startMs;
    session.currentIdx = 0;
    session.actualPassTimes = { 0: startMs };
    _saveSession();
    // F2.11: solicitar permiso de notificaciones si esta soportado.
    // Asi cuando el tab pierde foco y se cumple una ETA podemos lanzar
    // una Notification del SO ademas del toast in-page.
    _requestNotificationPermission();
    // Refetch inmediato para tener vientos frescos al arrancar
    _refetchWinds();
    _maybeShowContent();
  }
  function _requestNotificationPermission() {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (_) {}
    }
  }
  // F2.11: si el tab no esta en focus, dispara una Notification del SO
  // ademas del toast. Es best-effort (silenciosa si no hay permiso).
  function _maybeNotifyBackground(title, body) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (typeof document === 'undefined' || !document.hidden) return;
    if (Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: 'live-eta' }); } catch (_) {}
  }

  // ── Render: estado actual ──────────────────────────────────────────
  function _fmtTime(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return String(d.getUTCHours()).padStart(2, '0') + ':' +
           String(d.getUTCMinutes()).padStart(2, '0');
  }
  function _fmtDelta(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const min = Math.round(ms / 60000);
    if (min === 0) return '0';
    return (min > 0 ? '+' : '') + min;
  }
  function _fmtFuel(n) {
    if (!Number.isFinite(n)) return '—';
    return Math.round(n) + ' ' + (session ? session.fuelOpts.unit : '');
  }
  function _fmtWind(w) {
    if (!w || !Number.isFinite(w.speedKt) || !Number.isFinite(w.dir)) return '—';
    const dir = String(Math.round(w.dir)).padStart(3, '0');
    const sp = Math.round(w.speedKt);
    return dir + '/' + sp;
  }

  // F1.6: banner "VUELO COMPLETADO" cuando el operador ha registrado
  // el paso por el ultimo WP. Sustituye la grid de 6 cifras por un
  // resumen verde con duracion real, combustible consumido vs plan,
  // delta ETA total. Si la sesion aun no ha llegado al destino, oculta
  // el banner (la grid normal se rellena en _renderStatus).
  function _renderCompleted(rows) {
    if (!session) return;
    const statusCard = document.querySelector('.live-status-card');
    if (!statusCard) return;
    const last = session.coords.length - 1;
    const done = session.started && session.currentIdx >= last;
    let banner = document.getElementById('live-completed-banner');
    if (!done) {
      if (banner) banner.remove();
      statusCard.classList.remove('live-status-card-done');
      return;
    }
    statusCard.classList.add('live-status-card-done');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'live-completed-banner';
      banner.className = 'live-completed-banner';
      // Insertar despues del head de la card (antes del grid)
      const head = statusCard.querySelector('.live-card-head');
      if (head && head.nextSibling) {
        statusCard.insertBefore(banner, head.nextSibling);
      } else {
        statusCard.appendChild(banner);
      }
    }
    const destRow = rows[last];
    // Duracion real desde el primer paso registrado hasta el ultimo
    const startMs = session.actualPassTimes[0];
    const endMs   = session.actualPassTimes[last];
    const durMs = (Number.isFinite(startMs) && Number.isFinite(endMs)) ? (endMs - startMs) : null;
    const durTxt = durMs != null ? _fmtDuration(durMs) : '—';
    // Plan duration (en ETAs planificadas)
    const planStart = session.plannedEtas[0];
    const planEnd   = session.plannedEtas[last];
    const planDurMs = (Number.isFinite(planStart) && Number.isFinite(planEnd)) ? (planEnd - planStart) : null;
    const planDurTxt = planDurMs != null ? _fmtDuration(planDurMs) : '—';
    // Delta combustible: planificado vs real al destino
    const planFuelRest = session.plannedFuelRest[last];
    const liveFuelRest = destRow ? destRow.fuelRest : null;
    let fuelTxt = '—';
    if (Number.isFinite(planFuelRest) && Number.isFinite(liveFuelRest)) {
      const used  = session.fuelOpts.initialFuel - liveFuelRest;
      const planUsed = session.fuelOpts.initialFuel - planFuelRest;
      const dlt = used - planUsed;
      const sign = dlt > 0 ? '+' : '';
      fuelTxt = `${Math.round(used)} ${session.fuelOpts.unit} consumidos · plan ${Math.round(planUsed)} (${sign}${Math.round(dlt)})`;
    }
    // Delta ETA total
    const etaDelta = (Number.isFinite(endMs) && Number.isFinite(planEnd)) ? (endMs - planEnd) : null;
    const etaTxt = etaDelta != null ? _fmtDeltaLong(etaDelta) : '—';
    banner.innerHTML =
      '<div class="live-completed-title">✓ VUELO COMPLETADO</div>' +
      '<dl class="live-completed-list">' +
        `<dt>Duración real</dt><dd><b>${durTxt}</b> <span class="dim">(plan ${planDurTxt})</span></dd>` +
        `<dt>Combustible</dt><dd>${fuelTxt}</dd>` +
        `<dt>ETA destino</dt><dd>${etaTxt}</dd>` +
      '</dl>' +
      // F3.8 + F3.9: acciones AAR — guardar la sesion como vuelo
      // realizado en localStorage o exportarla como PDF.
      '<div class="live-completed-actions">' +
        '<button id="btn-live-save-flown" class="btn btn-primary btn-sm" type="button" title="Guarda esta sesión Live como vuelo realizado (AAR) en el navegador">💾 Guardar como vuelo realizado</button>' +
        '<button id="btn-live-pdf-aar"    class="btn btn-ghost   btn-sm" type="button" title="Exporta un PDF After Action Report con plan vs real por waypoint">📄 PDF AAR</button>' +
      '</div>';
  }

  // F3.8: construye un snapshot serializable de la sesion Live actual
  // para AAR. Captura todo lo necesario para reconstruir la tabla
  // plan-vs-real + metadatos resumen.
  function buildFlownSnapshot() {
    if (!session) return null;
    const last = session.coords.length - 1;
    const rows = _recalc(); // ya tenemos los campos calculados
    const startMs    = session.actualPassTimes[0]                || null;
    const endMs      = session.actualPassTimes[last]              || null;
    const planStart  = Number.isFinite(session.plannedEtas[0])    ? session.plannedEtas[0]    : null;
    const planEnd    = Number.isFinite(session.plannedEtas[last]) ? session.plannedEtas[last] : null;
    const initialFuel = Number.isFinite(session.fuelOpts.initialFuel) ? session.fuelOpts.initialFuel : null;
    const lastRow = rows[last];
    const finalFuel = lastRow && Number.isFinite(lastRow.fuelRest) ? lastRow.fuelRest : null;
    const planFinalFuel = Number.isFinite(session.plannedFuelRest[last]) ? session.plannedFuelRest[last] : null;

    // Eventos: holds vivos + alertedWPs + RTB (best-effort, info para AAR)
    const events = [];
    if (session.actualPassTimes[0]) {
      events.push({ time: session.actualPassTimes[0], type: 'Despegue', detail: 'Inicio de sesión Live' });
    }
    Object.keys(session.liveHolds || {}).forEach(k => {
      const idx = parseInt(k, 10);
      const mins = session.liveHolds[k];
      const t = session.actualPassTimes[idx];
      events.push({
        time: t,
        type: 'Hold',
        detail: `${mins} min en WP #${idx + 1} ${session.coords[idx] && session.coords[idx].name || ''}`,
      });
    });
    if (session.overrides) {
      const ov = session.overrides;
      const parts = [];
      if (Number.isFinite(ov.ias))  parts.push(`IAS ${ov.ias} kt`);
      if (Number.isFinite(ov.flow)) parts.push(`Flow ${ov.flow}/h`);
      if (Number.isFinite(ov.fl))   parts.push(`FL${ov.fl}`);
      if (parts.length) {
        events.push({
          time: session.actualPassTimes[ov.fromIdx] || null,
          type: 'Override',
          detail: `Desde WP #${(ov.fromIdx | 0) + 1}: ${parts.join(', ')}`,
        });
      }
    }
    if (session.rtbEngaged) {
      events.push({ time: startMs, type: 'RTB', detail: 'Modo retorno engaged durante el vuelo' });
    }
    if (session.refetched && Array.isArray(session.refetched.isaDeviations)) {
      for (const d of session.refetched.isaDeviations) {
        events.push({
          time: session.refetched.fetchedAt,
          type: 'ISA dev',
          detail: `WP #${d.idx + 1} ${d.name}: OAT ${Math.round(d.oatC)}°C (ISA ${(d.devC >= 0 ? '+' : '')}${Math.round(d.devC)}°C, DA ${Math.round(d.daFt)} ft)`,
        });
      }
    }
    if (endMs) {
      events.push({ time: endMs, type: 'Aterrizaje', detail: 'Llegada a destino' });
    }
    events.sort((a, b) => (a.time || 0) - (b.time || 0));

    return {
      meta: {
        origin:           session.coords[0] && session.coords[0].name,
        destination:      session.coords[last] && session.coords[last].name,
        startMs, endMs,
        planStartMs:      planStart,
        planEndMs:        planEnd,
        initialFuel,
        finalFuel,
        fuelConsumed:     (initialFuel != null && finalFuel != null)     ? (initialFuel - finalFuel) : null,
        fuelConsumedPlan: (initialFuel != null && planFinalFuel != null) ? (initialFuel - planFinalFuel) : null,
        fuelUnit:         session.fuelOpts.unit || '',
        totalDistNM:      session.totalDistNM,
        rtbEngaged:       !!session.rtbEngaged,
        savedAt:          Date.now(),
      },
      coords: session.coords,
      rows: rows.map(r => ({
        i: r.i, name: r.name, fl: r.fl, isSub: r.isSub,
        planEta: r.planEta, liveEta: r.liveEta,
        planFuelRest: session.plannedFuelRest[r.i],
        fuelRest: r.fuelRest,
        liveHoldMin: r.liveHoldMin || 0,
      })),
      events,
      session: JSON.parse(JSON.stringify(session)),
    };
  }

  function _saveFlown() {
    const snap = buildFlownSnapshot();
    if (!snap) {
      _showToast({ id: 'aar-result', level: 'warn',
        title: 'No se puede guardar', message: 'Sesión Live no disponible.', autoDismissMs: 5000 });
      return;
    }
    const sp = window.TSAgestor && window.TSAgestor.savedPlans;
    if (!sp || typeof sp.saveFlown !== 'function') {
      _showToast({ id: 'aar-result', level: 'warn',
        title: 'savedPlans no disponible', message: '', autoDismissMs: 5000 });
      return;
    }
    const origin = snap.meta.origin || 'XX';
    const dest   = snap.meta.destination || 'XX';
    const t = snap.meta.endMs || Date.now();
    const stamp = (function () {
      const d = new Date(t);
      const p = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
    })();
    const defaultName = `LIVE-${origin}-${dest}-${stamp}`;
    const name = prompt('Nombre del vuelo realizado:', defaultName);
    if (!name) return;
    sp.saveFlown(name, snap);
    // Visible en DOS sitios: (1) Plan → Planes guardados (seccion
    // "📂 Vuelos realizados (AAR)"), (2) preflight Live cuando no
    // hay sesion arrancada (card verde con boton "Ver lista").
    _showToast({
      id: 'aar-result', level: 'success',
      title: '✓ Vuelo realizado guardado',
      message: `"${name}" persistido. Visible en Plan → Planes guardados (seccion AAR) y en el preflight Live al resetear la sesion.`,
      autoDismissMs: 10000,
    });
  }

  async function _exportFlownPdf() {
    const snap = buildFlownSnapshot();
    if (!snap) {
      _showToast({ id: 'aar-result', level: 'warn',
        title: 'No se puede exportar', message: 'Sesión Live no disponible.', autoDismissMs: 5000 });
      return;
    }
    const pdf = window.TSAgestor && window.TSAgestor.pdfExport;
    if (!pdf || typeof pdf.exportLiveDelta !== 'function') {
      _showToast({ id: 'aar-result', level: 'warn',
        title: 'pdfExport no disponible', message: '', autoDismissMs: 5000 });
      return;
    }
    try {
      const fname = await pdf.exportLiveDelta(snap);
      _showToast({
        id: 'aar-result', level: 'success',
        title: '✓ PDF AAR generado',
        message: `Descargado: ${fname}`,
        autoDismissMs: 8000,
      });
    } catch (e) {
      _showToast({ id: 'aar-result', level: 'danger',
        title: 'Error generando PDF AAR',
        message: (e && e.message) ? e.message : 'Error desconocido',
        autoDismissMs: 8000 });
    }
  }

  // Bug 7 (test report): renderiza un banner en el preflight con un
  // contador de vuelos realizados guardados; click abre un toast
  // centrado con la lista. Si no hay vuelos, el banner no aparece —
  // el operador no necesita ver un boton vacio en cabina.
  function _renderFlownBanner(host) {
    if (!host) return;
    let banner = document.getElementById('live-flown-banner');
    const sp = window.TSAgestor && window.TSAgestor.savedPlans;
    const list = (sp && typeof sp.listFlown === 'function') ? sp.listFlown() : [];
    if (!list || !list.length) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'live-flown-banner';
      banner.className = 'live-card live-flown-banner';
      // Insertar al PRINCIPIO del preflight para que sea lo primero
      // que vea el operador.
      if (host.firstChild) host.insertBefore(banner, host.firstChild);
      else host.appendChild(banner);
    }
    banner.innerHTML =
      `<div class="live-card-head"><h3>📂 Vuelos realizados</h3>` +
      `<span class="dim">${list.length} guardados</span></div>` +
      `<button id="btn-live-show-flown" type="button" class="btn btn-ghost btn-sm" ` +
      `title="Lista de vuelos AAR guardados — ver detalles, re-exportar PDF o borrar">` +
      `Ver lista (${list.length})</button>`;
  }

  function _showFlownList() {
    const sp = window.TSAgestor && window.TSAgestor.savedPlans;
    if (!sp || typeof sp.listFlown !== 'function') {
      _showToast({ id: 'flown-list', level: 'warn',
        title: 'savedPlans no disponible', message: '', autoDismissMs: 4000 });
      return;
    }
    const list = sp.listFlown();
    if (!list.length) {
      _showToast({ id: 'flown-list', level: 'info',
        title: 'Sin vuelos realizados',
        message: 'Aun no has guardado ningun vuelo. Termina una sesion Live y pulsa "Guardar como vuelo realizado".',
        autoDismissMs: 6000 });
      return;
    }
    // Nota: savedPlans.saveFlown desestructura el snapshot en el
    // top-level (no en .data), asi que f tiene { name, saved, meta,
    // coords, rows, events, session } al mismo nivel. Ordeno por
    // meta.savedAt (ms) que es lo mas preciso; fallback a saved (ISO).
    list.sort((a, b) => {
      const aT = (a.meta && a.meta.savedAt) || Date.parse(a.saved || '') || 0;
      const bT = (b.meta && b.meta.savedAt) || Date.parse(b.saved || '') || 0;
      return bT - aT;
    });
    const rows = list.map(f => {
      const m = f.meta || {};
      const dur = (Number.isFinite(m.startMs) && Number.isFinite(m.endMs))
        ? _fmtDuration(m.endMs - m.startMs) : '—';
      const fuelTxt = (Number.isFinite(m.fuelConsumed))
        ? Math.round(m.fuelConsumed) + ' ' + (m.fuelUnit || '') : '—';
      const savMs = m.savedAt || Date.parse(f.saved || '') || null;
      const sav = savMs ? new Date(savMs).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—';
      const name = String(f.name || '').replace(/"/g, '&quot;');
      return '<tr>' +
        `<td><b>${name}</b><br><span class="dim">${m.origin || '?'} → ${m.destination || '?'} · ${sav}</span></td>` +
        `<td>${dur}</td>` +
        `<td>${fuelTxt}</td>` +
        `<td class="live-flown-actions">` +
          `<button class="btn btn-ghost btn-xs" type="button" data-flown-act="pdf" data-flown-name="${name}" title="Re-exportar PDF AAR">📄</button> ` +
          `<button class="btn btn-ghost btn-xs" type="button" data-flown-act="del" data-flown-name="${name}" title="Borrar este vuelo">🗑</button>` +
        `</td>` +
        '</tr>';
    }).join('');
    const bodyHTML =
      '<table class="live-flown-list">' +
        '<thead><tr><th>Vuelo</th><th>Duración</th><th>Fuel</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
    _showToast({
      id: 'flown-list', level: 'info',
      title: `📂 ${list.length} vuelos realizados guardados`,
      message: 'Click en 📄 para re-exportar PDF AAR · 🗑 para borrar.',
      bodyHTML,
      centered: true, backdrop: true,
      closeable: true,
    });
  }

  function _onFlownAction(name, action) {
    const sp = window.TSAgestor && window.TSAgestor.savedPlans;
    if (!sp) return;
    if (action === 'del') {
      if (!confirm(`Borrar el vuelo realizado "${name}"? No se puede deshacer.`)) return;
      sp.removeFlown(name);
      _dismissToast('flown-list');
      _showFlownList();
      // Re-render del banner para actualizar contador.
      const host = document.getElementById('live-preflight');
      if (host) _renderFlownBanner(host);
      return;
    }
    if (action === 'pdf') {
      const flown = sp.getFlown(name);
      if (!flown) {
        _showToast({ id: 'flown-pdf-err', level: 'warn', title: 'No encontrado', message: name, autoDismissMs: 4000 });
        return;
      }
      const pdf = window.TSAgestor && window.TSAgestor.pdfExport;
      if (!pdf || typeof pdf.exportLiveDelta !== 'function') return;
      // listFlown devuelve { name, savedAt, data: snapshot }; getFlown
      // devuelve el snapshot completo.
      pdf.exportLiveDelta(flown).then(fname => {
        _showToast({ id: 'flown-pdf', level: 'success',
          title: '✓ PDF AAR re-exportado', message: fname, autoDismissMs: 6000 });
      }).catch(e => {
        _showToast({ id: 'flown-pdf-err', level: 'danger',
          title: 'Error PDF', message: e && e.message, autoDismissMs: 6000 });
      });
    }
  }


  // Formato corto Xh Ym o Y min
  function _fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin - h * 60;
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return m + ' min';
  }
  // Formato delta con signo y unidad min legible
  function _fmtDeltaLong(ms) {
    if (!Number.isFinite(ms)) return '—';
    const min = Math.round(ms / 60000);
    if (min === 0) return 'sin desviación';
    if (min > 0) return `+${min} min (retraso)`;
    return `${min} min (adelanto)`;
  }

  function _renderStatus(rows) {
    const $ = id => document.getElementById(id);
    if (!session) return;
    // F1.6: si hemos llegado al destino (currentIdx === last) mostramos
    // un banner de cierre verde sobre la card "Estado actual".
    _renderCompleted(rows);
    const curr = session.currentIdx;
    // Para el "proximo WP" salta los sub-legs: WP real siguiente
    let next = null;
    for (let k = curr + 1; k < session.coords.length; k++) {
      next = k; break;
    }
    const last = session.coords.length - 1;
    const currRow = rows[curr];
    const nextRow = next != null ? rows[next] : null;
    const destRow = rows[last];

    if ($('live-current-wp')) {
      const c = session.coords[curr];
      const flTxt = Number.isFinite(c.fl) ? ` · FL${String(c.fl).padStart(3, '0')}` : '';
      const subTxt = c.isSub ? ' <span class="dim">(sub)</span>' : '';
      $('live-current-wp').innerHTML = `#${curr + 1} · ${c.name}${flTxt}${subTxt}`;
    }
    if ($('live-current-time')) {
      $('live-current-time').textContent = currRow ? _fmtTime(currRow.liveEta) + ' UTC' : '—';
    }
    if ($('live-next-wp')) {
      $('live-next-wp').textContent = nextRow ? `#${next + 1} · ${nextRow.name}` : 'Destino alcanzado';
    }
    if ($('live-next-eta')) {
      $('live-next-eta').textContent = nextRow ? _fmtTime(nextRow.liveEta) + ' UTC' : '—';
    }
    if ($('live-dest-eta')) {
      $('live-dest-eta').textContent = destRow ? _fmtTime(destRow.liveEta) + ' UTC' : '—';
    }
    if ($('live-fuel-remaining')) {
      const fuel = currRow ? currRow.fuelRest : null;
      $('live-fuel-remaining').textContent = _fmtFuel(fuel);
      $('live-fuel-remaining').className =
        currRow && currRow.fuelStatus === 'bingo' ? 'live-fuel-bingo'
      : currRow && currRow.fuelStatus === 'joker' ? 'live-fuel-joker' : '';
    }
    const advBtn = $('btn-live-advance');
    if (advBtn) advBtn.disabled = (next == null);
    const backBtn = $('btn-live-back');
    if (backBtn) backBtn.disabled = (curr <= 0);

    // RTB: actualiza texto del boton segun estado + banner visible.
    const rtbBtn = $('btn-live-rtb');
    if (rtbBtn) {
      if (session.rtbEngaged) {
        rtbBtn.textContent = '✗ Cancelar RTB';
        rtbBtn.title = 'Cancela el modo retorno y restaura el plan original';
        rtbBtn.classList.add('btn-warn-active');
      } else {
        rtbBtn.textContent = '↩ Vuelta a base';
        rtbBtn.title = 'Evalúa la vuelta inmediata al aeródromo de origen desde la posición actual';
        rtbBtn.classList.remove('btn-warn-active');
      }
    }
    // F2.9: stats enriquecidos. Todos toleran undefined / NaN.
    const t0Ms = session.actualPassTimes[0];
    const nowMs = Date.now();
    if ($('live-time-elapsed')) {
      const elapsed = Number.isFinite(t0Ms) ? (nowMs - t0Ms) : null;
      $('live-time-elapsed').textContent = elapsed != null && elapsed >= 0 ? _fmtDuration(elapsed) : '—';
    }
    if ($('live-time-remaining')) {
      const remain = destRow && Number.isFinite(destRow.liveEta) ? (destRow.liveEta - nowMs) : null;
      $('live-time-remaining').textContent = remain != null && remain >= 0 ? _fmtDuration(remain) : '—';
    }
    if ($('live-dist-progress')) {
      let doneNm = 0;
      for (let k = 1; k <= curr; k++) {
        const lp = session.legPlan[k];
        if (lp && Number.isFinite(lp.legNM)) doneNm += lp.legNM;
      }
      const total = Number.isFinite(session.totalDistNM) ? session.totalDistNM : 0;
      $('live-dist-progress').textContent = `${Math.round(doneNm)} / ${Math.round(total)} NM`;
    }
    if ($('live-leg-gs')) {
      let gs = null;
      if (next != null) {
        const lp = session.legPlan[next];
        const tMin = _legTimeMinAt(next);
        if (lp && Number.isFinite(lp.legNM) && lp.legNM > 0 && Number.isFinite(tMin) && tMin > 0) {
          gs = (lp.legNM / tMin) * 60;
        } else if (lp && Number.isFinite(lp.gs)) {
          gs = lp.gs;
        }
      }
      $('live-leg-gs').textContent = Number.isFinite(gs) ? Math.round(gs) + ' kt' : '—';
    }
    // Banner persistente en la card de Estado cuando RTB activo.
    _renderRtbBanner();
  }

  function _renderRtbBanner() {
    const statusCard = document.querySelector('.live-status-card');
    if (!statusCard) return;
    let banner = document.getElementById('live-rtb-banner');
    if (!session || !session.rtbEngaged) {
      if (banner) banner.remove();
      statusCard.classList.remove('live-status-card-rtb');
      return;
    }
    statusCard.classList.add('live-status-card-rtb');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'live-rtb-banner';
      banner.className = 'live-rtb-banner';
      const head = statusCard.querySelector('.live-card-head');
      if (head && head.nextSibling) {
        statusCard.insertBefore(banner, head.nextSibling);
      } else {
        statusCard.appendChild(banner);
      }
    }
    banner.innerHTML = '<span class="live-rtb-title">↩ MODO RETORNO</span> ' +
      '<span class="dim">Plan reescrito hacia origen. Pulsa "Cancelar RTB" para volver al plan original.</span>';
  }

  // ── Render: tabla log live ─────────────────────────────────────────
  function _renderTable(rows) {
    const tbody = document.querySelector('#live-log-table tbody');
    if (!tbody) return;
    // BUG#8 (audit v2): preserva el focus + el valor tecleado del
    // input de combustible que el operador esta editando. _refresh()
    // se llama desde callbacks async (refetch viento, METAR destino,
    // SIGMET, storage event de otra pestana, _tick) y la reescritura
    // de tbody.innerHTML destruia el <input> + perdia el valor parcial.
    let focusInfo = null;
    try {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('live-fuel-input') &&
          tbody.contains(active)) {
        focusInfo = {
          idx:      active.dataset.idx,
          value:    active.value,
          selStart: active.selectionStart,
          selEnd:   active.selectionEnd,
        };
      }
    } catch (_) { /* algunos navegadores fallan selectionStart en number inputs */ }
    tbody.innerHTML = '';
    // Bug 3 (test report): numeracion alineada con el mapa. Antes la
    // tabla usaba r.i+1 (indice en session.coords incluyendo sub-legs);
    // el mapa pinta etiquetas solo en los WPs reales, asi que un plan
    // con sub-legs tenia "WP 3 mapa = WP 5 tabla" -> imposible cross-
    // check con instrumentos. Ahora contamos solo WPs reales para el
    // numero; los sub-legs muestran "├" para indicar que son
    // intermedios del leg anterior.
    let realCount = 0;
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.className = (r.isCurrent ? 'live-row-current'
                   : r.isPast    ? 'live-row-past'
                                 : 'live-row-future') +
                   (r.isSub ? ' live-row-sub' : '');
      let displayN;
      if (!r.isSub) {
        realCount++;
        displayN = String(realCount);
      } else {
        displayN = '<span class="dim" title="Sub-leg intermedio (cambio de FL)">├</span>';
      }
      const deltaClass = (r.delta == null) ? ''
                      : (r.delta > 60000)   ? 'live-delta-late'
                      : (r.delta < -60000)  ? 'live-delta-early' : 'live-delta-on';
      const fuelClass = r.fuelStatus === 'bingo' ? 'live-fuel-bingo'
                      : r.fuelStatus === 'joker' ? 'live-fuel-joker' : '';
      const flTxt = Number.isFinite(r.fl) ? `FL${String(r.fl).padStart(3, '0')}` : '—';
      const iasTxt = Number.isFinite(r.ias) ? Math.round(r.ias) : '—';
      const tasTxt = Number.isFinite(r.tas) ? Math.round(r.tas) : '—';
      const gsTxt  = Number.isFinite(r.gs)  ? Math.round(r.gs)  : '—';
      const windTxt = _fmtWind(r.wind);
      const holdTxt = r.liveHoldMin > 0 ? `<span class="dim"> · hold ${r.liveHoldMin}'</span>` : '';
      const subBadge = r.isSub ? '<span class="dim"> · sub</span>' : '';
      const fuelInputCls = 'live-fuel-input' + (r.fuelRestOverridden ? ' live-fuel-overridden' : '') +
                          (fuelClass ? ' ' + fuelClass : '');
      const fuelCell = `<td><input type="number" class="${fuelInputCls}" data-idx="${r.i}" value="${Number.isFinite(r.fuelRest) ? Math.round(r.fuelRest) : ''}" step="10" placeholder="edit" title="Combustible restante en este WP — click para editar (valor real medido)"></td>`;
      tr.innerHTML =
        `<td>${displayN}</td>` +
        `<td><b>${r.name}</b>${subBadge}${holdTxt}</td>` +
        `<td>${flTxt}</td>` +
        `<td>${iasTxt}</td>` +
        `<td>${tasTxt}</td>` +
        `<td>${gsTxt}</td>` +
        `<td>${windTxt}</td>` +
        `<td>${_fmtTime(r.planEta)}</td>` +
        `<td><b>${_fmtTime(r.liveEta)}</b></td>` +
        `<td class="${deltaClass}">${_fmtDelta(r.delta)}</td>` +
        fuelCell;
      tbody.appendChild(tr);
    });
    const info = document.getElementById('live-log-info');
    if (info && session) {
      const curr = session.currentIdx;
      const reals = session.coords.filter(c => !c.isSub).length;
      info.textContent = `WP ${curr + 1} / ${session.coords.length} (${reals} reales) · ${session.totalDistNM.toFixed(0)} NM total`;
    }
    // BUG#8 + Bug 5.5 (test report): restaura focus + valor parcial +
    // posicion del cursor en el mismo input (mismo data-idx). El value
    // se restauraba bien pero el focus se perdia — sintoma reportado
    // "el focus cambia pero se queda el valor". Causa: el browser no
    // mantiene focus durante una sustitucion sincrona innerHTML; hay
    // que diferir focus() al siguiente frame para que el DOM se asiente.
    if (focusInfo && focusInfo.idx != null) {
      const reborn = tbody.querySelector('.live-fuel-input[data-idx="' + focusInfo.idx + '"]');
      if (reborn) {
        reborn.value = focusInfo.value;
        const doFocus = () => {
          try { reborn.focus({ preventScroll: true }); } catch (_) { reborn.focus(); }
          try {
            if (focusInfo.selStart != null && focusInfo.selEnd != null) {
              reborn.setSelectionRange(focusInfo.selStart, focusInfo.selEnd);
            }
          } catch (_) {}
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(doFocus);
        else doFocus();
      }
    }
  }

  // ── Render: evaluacion ─────────────────────────────────────────────
  function _renderEval(rows) {
    const ul = document.getElementById('live-eval-list');
    if (!ul) return;
    ul.innerHTML = '';
    if (!session) return;
    const last = session.coords.length - 1;
    const destRow = rows[last];

    if (destRow && Number.isFinite(destRow.fuelRest)) {
      const bingo = session.fuelOpts.bingo;
      const joker = session.fuelOpts.joker;
      let cls = 'ok', txt = '';
      if (Number.isFinite(bingo) && destRow.fuelRest <= bingo) {
        cls = 'bad';
        txt = `⚠ Combustible AL DESTINO ${_fmtFuel(destRow.fuelRest)} ≤ BINGO ${_fmtFuel(bingo)} — abortar`;
      } else if (Number.isFinite(joker) && destRow.fuelRest <= joker) {
        cls = 'warn';
        txt = `⚠ Combustible al destino ${_fmtFuel(destRow.fuelRest)} ≤ JOKER ${_fmtFuel(joker)}`;
      } else {
        cls = 'ok';
        txt = `✓ Combustible suficiente al destino (${_fmtFuel(destRow.fuelRest)} restantes)`;
      }
      const li = document.createElement('li');
      li.className = 'live-eval-' + cls;
      li.textContent = txt;
      ul.appendChild(li);
    }

    const rtb = _evalRTB();
    if (rtb && rtb.distanceNM > 0) {
      const li = document.createElement('li');
      li.className = 'live-eval-' + (rtb.ok ? 'ok' : 'bad');
      // Audit v3 BLOCKER#2: muestra GS real, headwind y aviso si
      // viento NO disponible o BINGO no configurado. Antes la linea
      // daba un sentido de seguridad falso (GS=IAS sin viento).
      const wTxt = rtb.windAvailable
        ? ` · ${rtb.headwindKt >= 0 ? 'HW' : 'TW'} ${Math.abs(rtb.headwindKt).toFixed(0)} kt`
        : ' · sin viento (refresh)';
      const marginTxt = rtb.bingoConfigured
        ? `margen sobre BINGO: ${_fmtFuel(rtb.fuelAfterRtb - rtb.bingo)}`
        : 'BINGO no configurado · combustible tras RTB: ' + _fmtFuel(rtb.fuelAfterRtb);
      li.textContent = `${rtb.ok ? '✓' : '⚠'} RTB directo: ${rtb.distanceNM.toFixed(0)} NM · GS ${rtb.gs.toFixed(0)} kt${wTxt} · ${Math.round(rtb.minutes)} min · necesita ${_fmtFuel(rtb.fuelNeeded)} (${marginTxt})`;
      ul.appendChild(li);
      // Aviso adicional si BINGO no esta configurado: decision RTB
      // requiere el umbral para ser util. Sin BINGO solo validamos
      // que tras RTB el fuel sea >= 0, lo cual NO es seguridad.
      if (!rtb.bingoConfigured) {
        const liB = document.createElement('li');
        liB.className = 'live-eval-warn';
        liB.textContent = '⚠ BINGO no configurado en el plan. La decision RTB se evalua solo contra fuel >= 0, sin reserva de seguridad. Configura BINGO en Plan -> Combustible.';
        ul.appendChild(liB);
      }
      // Si no hay viento del refetched, recomendamos al operador
      // pulsar Refresh para tener una decision RTB realista.
      if (!rtb.windAvailable) {
        const liW = document.createElement('li');
        liW.className = 'live-eval-warn';
        liW.textContent = '⚠ RTB calculado SIN viento. Pulsa "⟳ Refresh viento" para una decision realista (vientos adversos pueden duplicar el tiempo y combustible).';
        ul.appendChild(liW);
      }
    }

    if (destRow && destRow.delta != null) {
      const min = Math.round(destRow.delta / 60000);
      if (Math.abs(min) >= 1) {
        const li = document.createElement('li');
        li.className = min > 0 ? 'live-eval-warn' : 'live-eval-ok';
        li.textContent = `${min > 0 ? '⏱' : '✓'} ETA destino ${min > 0 ? min + ' min de retraso' : Math.abs(min) + ' min adelanto'}`;
        ul.appendChild(li);
      }
    }

    if (_refetchInFlight) {
      const li = document.createElement('li');
      li.className = 'live-eval-warn';
      li.textContent = '⏳ Refrescando vientos en altura...';
      ul.appendChild(li);
    }

    // F2.2: antiguedad del viento refetched. Si han pasado > 30 min
    // sugerimos refresh manual (el operador puede pulsar el boton).
    if (session.refetched && Number.isFinite(session.refetched.fetchedAt)) {
      const ageMs = Date.now() - session.refetched.fetchedAt;
      const ageMin = Math.floor(ageMs / 60000);
      if (ageMin >= 30) {
        const li = document.createElement('li');
        li.className = 'live-eval-warn';
        li.textContent = `⌛ Vientos refetched hace ${ageMin} min. Considera refrescar manualmente (⟳ Refresh viento) si el vuelo es largo.`;
        ul.appendChild(li);
      } else if (ageMin >= 1) {
        const li = document.createElement('li');
        li.className = 'live-eval-ok';
        li.textContent = `✓ Vientos refetched hace ${ageMin} min (fresco)`;
        ul.appendChild(li);
      }
    }

    // F2.7: desviaciones ISA significativas (>3 °C). El refetch las
    // recopila durante el recalculo; aqui las mostramos como warn.
    if (session.refetched && Array.isArray(session.refetched.isaDeviations) &&
        session.refetched.isaDeviations.length > 0) {
      const devs = session.refetched.isaDeviations;
      // Resumen: peor desviacion + count
      const worst = devs.reduce((a, b) => Math.abs(b.devC) > Math.abs(a.devC) ? b : a, devs[0]);
      const sign = worst.devC > 0 ? '+' : '';
      const li = document.createElement('li');
      li.className = 'live-eval-warn';
      li.textContent = `🌡 Desviación ISA detectada en ${devs.length} WP(s). Peor: WP #${worst.idx + 1} ${worst.name} · OAT ${Math.round(worst.oatC)}°C (ISA${sign}${Math.round(worst.devC)}°C, DA ${Math.round(worst.daFt)} ft).`;
      li.title = devs.map(d => `WP #${d.idx + 1} ${d.name}: OAT ${Math.round(d.oatC)}°C, ISA ${Math.round(d.isaC)}°C, DA ${Math.round(d.daFt)} ft`).join('\n');
      ul.appendChild(li);
    }

    // F2.6: TSAs activas que cruza la ruta restante AHORA.
    if (Array.isArray(_activeTSAcrossings) && _activeTSAcrossings.length > 0) {
      for (const t of _activeTSAcrossings) {
        const until = Number.isFinite(t.endMs)
          ? `hasta ${_fmtTime(t.endMs)} UTC`
          : 'hasta hora desconocida';
        const li = document.createElement('li');
        li.className = 'live-eval-bad';
        li.innerHTML = `⛔ <b>Cruzando TSA ACTIVA</b>: ${t.name} · ${until}`;
        ul.appendChild(li);
      }
    }

    // F2.5: SIGMETs que cruzan la ruta restante.
    if (Array.isArray(_sigmetCrossings) && _sigmetCrossings.length > 0) {
      for (const c of _sigmetCrossings) {
        const li = document.createElement('li');
        li.className = 'live-eval-bad';
        const hazTxt = c.haz || 'SIGMET';
        const firTxt = c.fir ? ` (${c.fir})` : '';
        li.innerHTML = `⚠ <b>SIGMET</b> ${hazTxt}${firTxt} cruza la ruta restante` +
                       (c.rawShort ? `<div class="live-eval-mono">${c.rawShort}${c.raw.length > c.rawShort.length ? '…' : ''}</div>` : '');
        if (c.raw) li.title = c.raw;
        ul.appendChild(li);
      }
    }

    // F2.4: METAR/TAF de destino si esta cargado y vigente.
    if (_destMet && _destMet.icao) {
      const ageMin = Math.floor((Date.now() - _destMet.fetchedAt) / 60000);
      const metarTxt = _destMet.metar && _destMet.metar.raw ? _destMet.metar.raw
                     : (typeof _destMet.metar === 'string' ? _destMet.metar : null);
      const tafTxt   = _destMet.taf && _destMet.taf.raw   ? _destMet.taf.raw
                     : (typeof _destMet.taf === 'string' ? _destMet.taf : null);
      if (metarTxt || tafTxt) {
        const li = document.createElement('li');
        li.className = 'live-eval-info';
        let html = `🌐 Meteo destino <b>${_destMet.icao}</b> <span class="dim">(refresh hace ${ageMin} min)</span>`;
        if (metarTxt) html += `<div class="live-eval-mono">METAR ${metarTxt}</div>`;
        if (tafTxt)   html += `<div class="live-eval-mono">TAF&nbsp;&nbsp; ${tafTxt}</div>`;
        li.innerHTML = html;
        ul.appendChild(li);
      }
    }

    if (ul.children.length === 0) {
      const li = document.createElement('li');
      li.className = 'dim';
      li.textContent = 'Sin alertas. Plan en marcha.';
      ul.appendChild(li);
    }
  }

  // ── Acciones ───────────────────────────────────────────────────────
  function _advance() {
    if (!session || !session.started) return;
    // Salta sub-legs: el operador no pulsa "Estoy en proximo WP" por
    // cada subdivision de ascenso/descenso (no son posiciones fisicas).
    let next = session.currentIdx + 1;
    while (next < session.coords.length && session.coords[next].isSub) next++;
    if (next >= session.coords.length) return;
    const now = Date.now();
    // Registra el paso por idx y, para mantener continuidad de ETAs,
    // tambien por los sub-legs intermedios saltados.
    for (let k = session.currentIdx + 1; k <= next; k++) {
      session.actualPassTimes[k] = now;
    }
    session.currentIdx = next;
    // Si habia un WP-alert pendiente del WP que acabamos de atender,
    // cierra el toast y quita el badge.
    _dismissToast('wp-alert');
    _setEtaAlertIndicator(false);
    _saveSession();
    _refresh();
    _refetchWinds();
  }
  function _back() {
    if (!session) return;
    if (session.currentIdx <= 0) return;
    // Limpia el paso real del WP actual (y los sub-legs que tengan
    // pass marcado del mismo grupo).
    const wasIdx = session.currentIdx;
    delete session.actualPassTimes[wasIdx];
    session.currentIdx--;
    while (session.currentIdx > 0 && session.coords[session.currentIdx].isSub) {
      delete session.actualPassTimes[session.currentIdx];
      session.currentIdx--;
    }
    // F3.7: limpia alertedWPs[k] para TODO k > currentIdx nuevo. Asi
    // si el operador retrocede varios WPs, el modal vuelve a dispararse
    // para cada uno cuando alcance su ETA otra vez.
    if (session.alertedWPs) {
      Object.keys(session.alertedWPs).forEach((k) => {
        const ki = parseInt(k, 10);
        if (Number.isFinite(ki) && ki > session.currentIdx) {
          delete session.alertedWPs[ki];
        }
      });
    }
    _saveSession();
    _refresh();
  }
  function _addHold() {
    if (!session || !session.started) return;
    const min = prompt('Minutos de hold en el WP actual:', '5');
    if (min == null) return;
    const n = Math.max(1, parseInt(min, 10));
    if (!Number.isFinite(n)) return;
    const idx = session.currentIdx;
    session.liveHolds[idx] = (session.liveHolds[idx] || 0) + n;
    _saveSession();
    _refresh();
  }
  // RTB: toggle entre engage (reconstruye la sesion como vuelta a base)
  // y cancel (restaura la sesion original guardada en snapshot).
  function _showRtbInline() {
    if (!session) return;
    if (session.rtbEngaged) {
      // Toggle: cancelar RTB y volver al plan original.
      if (!confirm('¿Cancelar el modo RTB y volver al plan de vuelo original?')) return;
      _cancelRTB();
      _showToast({
        id: 'rtb-cancelled', level: 'info',
        title: '✓ RTB cancelado',
        message: 'Sesión Live restaurada al plan original.',
        autoDismissMs: 5000,
      });
      return;
    }
    _engageRTB();
  }

  // F-RTB: engage modo retorno. Calcula la viabilidad, pide confirmacion
  // mostrando los numeros clave, y si el operador confirma reconstruye
  // la sesion Live tomando como ruta el camino inverso desde la posicion
  // actual hasta origen. Conserva un snapshot para poder cancelar.
  function _engageRTB() {
    if (!session || !session.started) return;
    if (session.currentIdx <= 0) {
      _showToast({ id: 'rtb-result', level: 'info',
        title: 'Ya estás en origen', message: 'No hay nada a lo que volver.', autoDismissMs: 3000 });
      return;
    }
    const r = _evalRTB();
    if (!r) {
      _showToast({ id: 'rtb-result', level: 'warn',
        title: 'No se pudo evaluar RTB', message: 'Faltan datos del plan.', autoDismissMs: 5000 });
      return;
    }
    const ok = r.ok ? '✓ FACTIBLE (margen sobre BINGO)' : '⚠ NO FACTIBLE con BINGO actual';
    const txt =
      `Vuelta a base desde WP ${session.currentIdx + 1}:\n\n` +
      `Distancia (inversa por waypoints): ${r.distanceNM.toFixed(0)} NM\n` +
      `Tiempo estimado: ${Math.round(r.minutes)} min\n` +
      `Combustible necesario: ${_fmtFuel(r.fuelNeeded)}\n` +
      `Combustible ahora: ${_fmtFuel(r.fuelNow)}\n` +
      `Quedaría al llegar: ${_fmtFuel(r.fuelAfterRtb)}\n` +
      `BINGO: ${_fmtFuel(r.bingo)}\n\n` +
      `${ok}\n\n` +
      `¿Engage RTB? Reconstruirá el log con la ruta de retorno (current → origen).`;
    if (!confirm(txt)) return;

    // Snapshot completo para poder cancelar.
    session.preRtbSnapshot = {
      coords: session.coords,
      plannedEtas: session.plannedEtas,
      plannedFuelRest: session.plannedFuelRest,
      legPlan: session.legPlan,
      totalDistNM: session.totalDistNM,
      currentIdx: session.currentIdx,
      actualPassTimes: Object.assign({}, session.actualPassTimes),
      liveHolds: Object.assign({}, session.liveHolds),
      overrides: session.overrides ? Object.assign({}, session.overrides) : null,
      fuelOverrides: Object.assign({}, session.fuelOverrides || {}),
      alertedWPs: Object.assign({}, session.alertedWPs || {}),
      refetched: session.refetched,
      // BUG#4 (audit v2): snapshot del fuelOpts COMPLETO (no solo
      // initialFuel). Antes _engageRTB hacia
      // `session.fuelOpts = {..., initialFuel}` pisando initialFuel
      // con el combustible del momento del engage; al cancelar, sin
      // snapshot del fuelOpts original, la card combustible quedaba
      // mintiendo (initialFuel == valor bajo del engage).
      fuelOpts: Object.assign({}, session.fuelOpts),
      // El planId se conserva como ref pero la nueva session ya no
      // corresponde al hash del plan -> no preservamos hash check.
    };

    // Construye la ruta inversa: posicion actual + WPs precedentes
    // hasta origen. Salta sub-legs (al volver no se simulan).
    const curIdx = session.currentIdx;
    const returnCoords = [];
    for (let k = curIdx; k >= 0; k--) {
      const c = session.coords[k];
      if (c.isSub) continue; // sub-legs no son posiciones reales
      returnCoords.push({
        name: (k === curIdx ? c.name + ' (RTB)' : c.name),
        lat: c.lat, lon: c.lon,
        fl: c.fl,
        originalIdx: k,
        isSub: false,
      });
    }
    if (returnCoords.length < 2) {
      _showToast({ id: 'rtb-result', level: 'warn',
        title: 'RTB no construible', message: 'No hay WPs reales en el camino inverso.', autoDismissMs: 5000 });
      return;
    }

    // Parámetros del retorno: usa override si activo, sino plan inicial.
    const ov = session.overrides;
    const ias  = (ov && Number.isFinite(ov.ias))  ? ov.ias  : (_planIasFromPlan() || 120);
    const flow = (ov && Number.isFinite(ov.flow)) ? ov.flow : session.fuelOpts.fuelFlow;

    // Tiempo de partida = paso real en current, o ahora.
    const startTime  = session.actualPassTimes[curIdx] || Date.now();
    const initialFuel = _computeFuelRest(curIdx);

    // Reconstruye legPlan + ETAs + fuel. Sin viento (aprox conservadora;
    // _refetchWinds tras engage refrescará GS/ETAs con datos reales).
    const newLegPlan    = [{ ias: null, tas: null, gs: null, legNM: 0, legTimeMin: 0, legFuel: 0, flow: 0, wind: null }];
    const newEtas       = [startTime];
    const newFuelRest   = [initialFuel];
    let cumNm = 0, cumFuel = 0, etaMs = startTime;
    for (let i = 1; i < returnCoords.length; i++) {
      const A = returnCoords[i - 1], B = returnCoords[i];
      const km = _greatCircleKM(A.lat, A.lon, B.lat, B.lon);
      const nm = km / 1.852;
      cumNm += nm;
      // TAS conservadora = IAS (sin correccion DA). _refetchWinds la
      // recalculara con OAT real tras engage.
      const tas = ias;
      const gs  = tas;
      const timeMin = (nm / Math.max(gs, 30)) * 60;
      const legFuel = (timeMin / 60) * flow;
      cumFuel += legFuel;
      etaMs += timeMin * 60000;
      newLegPlan.push({ ias, tas, gs, legNM: nm, legTimeMin: timeMin, legFuel, flow, wind: null });
      newEtas.push(etaMs);
      newFuelRest.push(Math.max(0, initialFuel - cumFuel));
    }

    // Sustituye la sesion con el plan de retorno.
    session.coords          = returnCoords;
    session.plannedEtas     = newEtas;
    session.plannedFuelRest = newFuelRest;
    session.legPlan         = newLegPlan;
    session.totalDistNM     = cumNm;
    session.currentIdx      = 0;
    session.actualPassTimes = { 0: startTime };
    session.liveHolds       = {};
    session.fuelOverrides   = {};
    session.alertedWPs      = {};
    session.refetched       = null;
    session.rtbEngaged      = true;
    // El initialFuel del fuelOpts se ajusta al combustible REAL en el
    // momento de engage para que la propagacion downstream cuadre.
    session.fuelOpts = Object.assign({}, session.fuelOpts, { initialFuel });

    // BUG#1+#7 (audit v2): bumpear epoch (invalida refetch en vuelo
    // sobre la ruta de IDA — ahora estamos en RTB) y suprimir la ruta
    // amarilla del plan en el mapa (mapView) para que solo se vea el
    // overlay cyan del retorno. Antes se solapaban las dos polilineas.
    _sessionEpoch++;
    // Audit OLA1 BUG#11: invalidar caches de meteo del destino y
    // SIGMETs. El destino antiguo (LEZG) cambia al origen (LEMD)
    // tras RTB; sin invalidar, _maybeRefreshDestMet veria el icao
    // distinto y refetchearia, pero los SIGMETs del cache seguian
    // siendo de la ruta de IDA y _recomputeSigmetCrossings comparaba
    // contra session.coords que ya son de RTB — falsos positivos /
    // negativos. Limpiamos ambos para que el proximo tick reconstruya.
    _destMet = null;
    _sigmetCache = null;
    _sigmetCrossings = [];
    _activeTSAcrossings = [];
    const mv = window.TSAgestor && window.TSAgestor.mapView;
    if (mv && typeof mv.suppressFlightPlan === 'function') mv.suppressFlightPlan(true);
    _saveSession();
    _refresh();
    // Refresca vientos para tener GS reales en la ruta de retorno.
    _refetchWinds();

    _showToast({
      id: 'rtb-engaged', level: 'warn',
      title: '↩ Modo RETORNO engaged',
      message: `Log reconstruido (${returnCoords.length - 1} legs). Distancia ${cumNm.toFixed(0)} NM · ETA origen ${_fmtTime(etaMs)} UTC. Pulsa "Cancelar RTB" para volver al plan original.`,
      autoDismissMs: 12000,
    });
  }

  function _cancelRTB() {
    if (!session || !session.rtbEngaged || !session.preRtbSnapshot) return;
    const snap = session.preRtbSnapshot;
    // BUG#5 (audit v2): confirmacion fuerte que lista lo que se
    // descarta. Si el operador avanzo WPs durante el retorno, el
    // cancel los pierde sin posibilidad de recuperar — silencioso
    // antes. Hacemos counting de WPs reales avanzados durante RTB.
    const rtbAdvanced = (session.currentIdx | 0); // currentIdx en RTB empezo a 0
    const rtbReal = session.coords.filter((c, i) => i > 0 && i <= rtbAdvanced && !c.isSub).length;
    let msg = 'Volver al plan ORIGINAL y descartar el modo RETORNO.';
    if (rtbAdvanced > 0) {
      msg += `\n\nATENCION: has avanzado ${rtbAdvanced} WPs (${rtbReal} reales) durante el retorno. Esos pasos se PERDERAN. ` +
             'El currentIdx vuelve al WP donde estabas al engage.';
    }
    msg += '\n\n¿Continuar?';
    if (!confirm(msg)) return;
    session.coords          = snap.coords;
    session.plannedEtas     = snap.plannedEtas;
    session.plannedFuelRest = snap.plannedFuelRest;
    session.legPlan         = snap.legPlan;
    session.totalDistNM     = snap.totalDistNM;
    session.currentIdx      = snap.currentIdx;
    session.actualPassTimes = snap.actualPassTimes;
    session.liveHolds       = snap.liveHolds;
    session.overrides       = snap.overrides;
    session.fuelOverrides   = snap.fuelOverrides;
    session.alertedWPs      = snap.alertedWPs;
    session.refetched       = snap.refetched;
    // BUG#4: restaurar fuelOpts COMPLETO desde snapshot (no solo
    // initialFuel). Si por alguna razon el snap viejo no tiene
    // fuelOpts (sesion v218 persistida), conservar la session actual
    // para no romper el render.
    if (snap.fuelOpts) session.fuelOpts = Object.assign({}, snap.fuelOpts);
    delete session.rtbEngaged;
    delete session.preRtbSnapshot;
    // BUG#1+#7: bumpear epoch + re-render del plan original en mapa.
    _sessionEpoch++;
    // Audit OLA1 BUG#11: simetrico al engage — invalida caches para
    // que el destino vuelva al original sin datos stale.
    _destMet = null;
    _sigmetCache = null;
    _sigmetCrossings = [];
    _activeTSAcrossings = [];
    const mv = window.TSAgestor && window.TSAgestor.mapView;
    if (mv && typeof mv.suppressFlightPlan === 'function') mv.suppressFlightPlan(false);
    if (mv && typeof mv.renderFlightPlan === 'function') {
      const app = window.TSAgestor && window.TSAgestor.app;
      const lastPlan = app && app.getLastPlan && app.getLastPlan();
      if (lastPlan) mv.renderFlightPlan(lastPlan);
    }
    _saveSession();
    _refresh();
    _showToast({
      id: 'rtb-cancelled', level: 'info',
      title: '↺ RTB cancelado',
      message: 'Plan original restaurado. Ruta de IDA visible de nuevo en el mapa.',
      autoDismissMs: 6000,
    });
  }
  function _resetSession() {
    if (!confirm('Resetear la sesión live al estado inicial? Se pierden todos los pasos, holds, overrides y correcciones de combustible.')) return;
    _clearSession();
    _dismissToast('wp-alert');
    _setEtaAlertIndicator(false);
    _buildSessionFromPlan(true);
    _maybeShowContent();
  }
  function _applyOverrides() {
    if (!session) return;
    const ias  = parseFloat(document.getElementById('live-override-ias').value);
    const flow = parseFloat(document.getElementById('live-override-flow').value);
    const fl   = parseFloat(document.getElementById('live-override-fl').value);
    const fromIdx = Math.min(session.currentIdx + 1, session.coords.length - 1);
    session.overrides = {
      fromIdx,
      ias:  Number.isFinite(ias)  && ias  > 0  ? ias  : null,
      flow: Number.isFinite(flow) && flow >= 0 ? flow : null,
      fl:   Number.isFinite(fl)   && fl   > 0  ? fl   : null,
    };
    _saveSession();
    _refresh();
  }
  function _clearOverrides() {
    if (!session) return;
    session.overrides = null;
    document.getElementById('live-override-ias').value  = '';
    document.getElementById('live-override-flow').value = '';
    document.getElementById('live-override-fl').value   = '';
    _saveSession();
    _refresh();
  }
  function _editFuelRest(idx, newRemaining) {
    if (!session) return;
    if (!Number.isFinite(idx) || !Number.isFinite(newRemaining)) return;
    // F2.12: clamp a >= 0. Un fuel negativo propaga restantes cada vez
    // mas negativos para los WPs siguientes sin que se note como bug.
    session.fuelOverrides[idx] = Math.max(0, newRemaining);
    _saveSession();
    _refresh();
  }

  // F2.10: alterna el modo compacto/detalle de la tabla live. Compacto
  // por defecto en B1 estrecho (panel ~320-400 px) — solo muestra
  // # / WP / FL / ETA live / Δ / Restante. Detalle expande IAS / TAS /
  // GS / Viento / ETA plan. Persiste en session.tableMode.
  function _toggleTableDetail() {
    if (!session) return;
    session.tableMode = (session.tableMode === 'detail') ? 'compact' : 'detail';
    _saveSession();
    _applyTableMode();
  }
  function _applyTableMode() {
    const wrap = document.getElementById('live-log-table-wrap');
    if (!wrap) return;
    const detail = session && session.tableMode === 'detail';
    wrap.classList.toggle('live-log-detail', detail);
    wrap.classList.toggle('live-log-compact', !detail);
    const btn = document.getElementById('btn-live-table-toggle');
    if (btn) btn.textContent = detail ? '↔ Compacto' : '↔ Detalle';
  }

  return {
    init,
    onTabOpen: _maybeShowContent,
    refresh: _refresh,
    // Audit OLA1 BUG#6: el Plan tab (calcPlan / loadPlanByName /
    // importPlan) llama a esto tras mutar state.lastPlan para que la
    // sesion Live re-valide el hash inmediatamente, sin esperar a que
    // el operador navegue al tab Live. Si el hash cambio,
    // _buildSessionFromPlan se encarga del reset + toast.
    onPlanChanged: () => {
      if (!session) return;
      try { _maybeShowContent(); } catch (e) { console.warn('[livePlan] onPlanChanged:', e); }
    },
    // Audit OLA1 BUG#8: clearPlan() de app.js llama a esto para que
    // la sesion Live no quede HUERFANA en localStorage. Sin esto,
    // tsagestor_live_session_v2 sobrevivia y si el operador
    // recalculaba un plan futuro que casualmente coincidia en hash,
    // la sesion vieja se reactivaba.
    clearSession: () => {
      try {
        _dismissToast('wp-alert');
        _dismissToast('session-restored');
        _setEtaAlertIndicator(false);
        _clearSession();
        _maybeShowContent();
      } catch (e) { console.warn('[livePlan] clearSession:', e); }
    },
  };
})();
