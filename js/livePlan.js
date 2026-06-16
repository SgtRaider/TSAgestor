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
  // Test report: pedido del operador "auto actualizar vientos una vez
  // cada 5 minutos". Ademas Open-Meteo retorna 429 cuando hay demasiadas
  // refetches en rapida sucesion — el trigger anterior llamaba
  // _maybeRefetchWinds en CADA _recalc (frecuente) + cooldown solo 2min,
  // generando cascade tras error. Ahora:
  //   - WIND_TTL_MS = 5 min: refresh periodico segun pedido del operador
  //   - WIND_HORIZON_MARGIN_MS = 60 min (mantenido)
  //   - WIND_REFETCH_ERROR_COOLDOWN_MS = 10 min: respeta rate limit
  //   - Timer dedicado en lugar de _maybeRefetchWinds via _recalc
  //     (elimina la cascada por error)
  const WIND_TTL_MS                    = 5  * 60 * 1000;     // 5 min auto-refresh
  const WIND_HORIZON_MARGIN_MS         = 60 * 60 * 1000;     // 60 min margen
  const WIND_REFETCH_ERROR_COOLDOWN_MS = 10 * 60 * 1000;     // 10 min tras 429/error
  let _windRefetchLastError = 0;
  let _windAutoTimer = null;
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
    // OLA2: cargar config TTS persistida + aplicar estado del boton.
    _loadTtsConfig();
    _applyTtsButtonState();
    _initWindAutoRefresh();
  }

  // Test report: timer dedicado para auto-refresh de viento cada
  // WIND_TTL_MS (5 min). Sustituye al trigger via _recalc que generaba
  // cascade tras errores 429 de Open-Meteo. Skip si tab oculto (ahorra
  // bateria + respeta rate limits del API).
  function _initWindAutoRefresh() {
    if (_windAutoTimer) return;
    _windAutoTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!session || !session.started) return;
      const rows = (typeof _recalcCache !== 'undefined' && _recalcCache) ? _recalcCache : [];
      try { _maybeRefetchWinds(rows); } catch (_) {}
    }, WIND_TTL_MS);
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
      // Test report: per-WP override maps. session.overrides (single
      // range) perdia el valor del WP anterior al encoger fromIdx.
      // Per-WP storage permite que cada WP recuerde QUE IAS/flow/FL
      // tenia cuando el operador paso por ahi. Estructura: { idx: val }.
      // _effOverride(i, 'ias') escanea la map y devuelve el valor del
      // mayor idx <= i — la ultima entrada antes (o exactamente en) el WP.
      iasOverrides:      keep ? Object.assign({}, prev.iasOverrides  || {}) : {},
      flowOverrides:     keep ? Object.assign({}, prev.flowOverrides || {}) : {},
      flOverrides:       keep ? Object.assign({}, prev.flOverrides   || {}) : {},
      fuelOverrides:     keep ? Object.assign({}, prev.fuelOverrides || {}) : {},
      refetched:         keep ? prev.refetched         : null,
      // OLA2: la calibracion OAT/QNH es una medicion del avion en el
      // aire — conservarla si es la misma sesion (mismo planId).
      // Si el plan cambia, se descarta (datos del vuelo anterior).
      calibration:       keep ? (prev.calibration || null) : null,
      // OLA3: event log append-only de cada accion operativa con
      // timestamp. Vital para el AAR — proporciona evidencia objetiva
      // del orden y momento exacto de cada decision durante el vuelo.
      eventLog:          keep ? (Array.isArray(prev.eventLog) ? prev.eventLog.slice() : []) : [],
    };
    // Workflow fleet-tsa-integration v2: el operador solo quiere las
    // TSAs por las que la ruta coincide en POSICION + ALTURA. Antes
    // se inyectaba plan.overflownTSAs (lateral-only, incluia TSAs por
    // encima/debajo del FL crucero — clutter en dispatch). Ahora se
    // usa plan.conflicts (cruce lateral + FL match en banda vertical)
    // sin filtrar por schedule, deduplicado.
    //
    // El uso de plan.conflicts es la fuente canonica de "TSAs que la
    // ruta REALMENTE cruza" segun la doctrina operativa:
    //   - segCrossesPolygon entre los 2 endpoints del segmento
    //   - max(seg.from.fl, seg.to.fl) dentro de tsa.vertical
    //   - schedule activo en la ventana [tStart, tEnd] del segmento
    //
    // Para el dispatcher mantenemos los DOS primeros criterios; el
    // schedule lo decide cliente con Date.now() vivo en fleet.
    try {
      const slim = (t) => t && t.id && t.polygon && t.vertical ? {
        id:        t.id,
        name:      t.name,
        polygon:   t.polygon,
        vertical:  t.vertical,
        schedules: Array.isArray(t.schedules) ? t.schedules.map(s => s ? {
          startUTC: s.startUTC instanceof Date ? s.startUTC.toISOString() : s.startUTC,
          endUTC:   s.endUTC   instanceof Date ? s.endUTC.toISOString()   : s.endUTC,
          raw:      s.raw,
        } : null).filter(Boolean) : [],
        kind:      t.kind || null,
        country:   t.country || null,
      } : null;
      // Construye el set: para cada TSA en plan.overflownTSAs, verifica
      // si AL MENOS UN segmento la cruza CON FL match. Asi se reproduce
      // el criterio de findConflicts sin filtrar por schedule (dispatch
      // necesita ver las TSAs aunque su horario no este activo en el
      // momento de la decision de calcular el plan).
      const segCross = window.TSAgestor && window.TSAgestor.flightPlan;
      const fp = window.TSAgestor.flightPlan;
      const positionAltitudeMatch = [];
      const seen = new Set();
      if (Array.isArray(plan.overflownTSAs) && plan.overflownTSAs.length) {
        // Replica del criterio findConflicts pero sin schedule check.
        // Usamos plan.coords (ya incluye sub-legs con su FL) y la
        // detection de cruce lateral por segmento.
        const coords = Array.isArray(plan.coords) ? plan.coords : [];
        function pointInPolyLocal(pt, poly) {
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
        function segIntersectLocal(p1, p2, p3, p4) {
          const ccw = (A, B, C) =>
            (C[0] - A[0]) * (B[1] - A[1]) > (B[0] - A[0]) * (C[1] - A[1]);
          return ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
                 ccw(p1, p2, p3) !== ccw(p1, p2, p4);
        }
        function segCrossesPolyLocal(a, b, poly) {
          if (pointInPolyLocal(a, poly) || pointInPolyLocal(b, poly)) return true;
          for (let i = 0; i < poly.length; i++) {
            if (segIntersectLocal(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
          }
          return false;
        }
        plan.overflownTSAs.forEach(t => {
          if (!t || !t.id || seen.has(t.id)) return;
          if (!t.vertical || !Number.isFinite(t.vertical.lowerFt) || !Number.isFinite(t.vertical.upperFt)) return;
          if (!Array.isArray(t.polygon) || t.polygon.length < 3) return;
          const lo = t.vertical.lowerFt;
          const up = t.vertical.upperFt;
          // Iterar segmentos de la ruta hasta encontrar uno que cruce
          // este TSA CON FL match (max(fl extremos) dentro de banda).
          for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i], b = coords[i + 1];
            if (!a || !b) continue;
            const flA = Number.isFinite(a.fl) ? a.fl * 100 : null;
            const flB = Number.isFinite(b.fl) ? b.fl * 100 : null;
            const flMax = (flA != null && flB != null) ? Math.max(flA, flB)
                        : (flA != null ? flA : flB);
            if (flMax == null) continue;
            if (flMax < lo || flMax > up) continue;
            if (segCrossesPolyLocal([a.lat, a.lon], [b.lat, b.lon], t.polygon)) {
              seen.add(t.id);
              positionAltitudeMatch.push(t);
              break;
            }
          }
        });
      }
      // Si no hay overflownTSAs persistidos (post-F5 con sesion vieja),
      // fallback al subset de plan.conflicts.map(c=>c.tsa) deduplicado.
      // Estos YA cumplen position+altitude (los conflicts los garantizan).
      if (!positionAltitudeMatch.length && Array.isArray(plan.conflicts) && plan.conflicts.length) {
        plan.conflicts.forEach(c => {
          if (c && c.tsa && c.tsa.id && !seen.has(c.tsa.id)) {
            seen.add(c.tsa.id);
            positionAltitudeMatch.push(c.tsa);
          }
        });
      }
      session.crossingTSAs = positionAltitudeMatch.map(slim).filter(Boolean);
      session._tsaSchema = 1;
    } catch (e) {
      console.warn('[livePlan] crossingTSAs inject fallo:', e && e.message);
      session.crossingTSAs = [];
    }
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
        // Workflow fleet-tsa-integration: revive schedules de
        // crossingTSAs (los ISO strings tras JSON.parse no son Date
        // objects). Tolerante a sesiones viejas sin crossingTSAs.
        if (session && Array.isArray(session.crossingTSAs)) {
          session.crossingTSAs.forEach(t => {
            if (t && Array.isArray(t.schedules)) {
              t.schedules = t.schedules.map(s => {
                if (!s) return null;
                const su = (typeof s.startUTC === 'string') ? new Date(s.startUTC) : s.startUTC;
                const eu = (typeof s.endUTC   === 'string') ? new Date(s.endUTC)   : s.endUTC;
                if (!(su instanceof Date) || isNaN(su.getTime())) return null;
                if (!(eu instanceof Date) || isNaN(eu.getTime())) return null;
                return { startUTC: su, endUTC: eu, raw: s.raw };
              }).filter(Boolean);
            }
          });
        }
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
  // OLA4: helper defensivo para hooks de liveSync. Triple guardia:
  // (1) typeof window.TSAgestor.liveSync; (2) method existe; (3)
  // try/catch para que NUNCA propague excepciones a callers — el
  // ecosistema actual funciona aunque liveSync.js no este cargado.
  function _syncHook(method) {
    try {
      const ls = window.TSAgestor && window.TSAgestor.liveSync;
      if (!ls || typeof ls[method] !== 'function') return;
      ls[method]();
    } catch (_) { /* no propagar */ }
  }
  function _saveSession() {
    if (!session) return;
    // F2.8: cualquier guardado implica mutacion del estado -> el cache
    // del recalc queda obsoleto.
    _invalidateRecalc();
    try {
      // Workflow fleet-tsa-integration size-gate: si el JSON supera
      // 200KB (TSAs con polygons grandes), persiste copia ligera sin
      // crossingTSAs y con _tsaStripped:true. El dispatcher
      // recomputara contra su state.tsas local usando meta.*Ids.
      //
      // Workflow wind-eta-resync-design step 3: SIEMPRE excluir
      // windsHourly del localStorage. El timeseries crudo ocupa
      // ~24KB/WP × 30 WPs = ~720KB — explotaria la cuota de 5MB.
      // Tras un F5, _maybeRefetchWinds detecta !windsHourly y re-fetcha
      // automaticamente. session.refetched legacy queda como fallback
      // grosero mientras llega el primer re-lookup.
      let toStore = Object.assign({}, session, { windsHourly: null });
      try {
        const tentative = JSON.stringify(toStore);
        if (tentative.length > 200 * 1024) {
          toStore = Object.assign({}, toStore, {
            crossingTSAs: null,
            _tsaStripped: true,
          });
        }
      } catch (_) {}
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
      // OLA4 FIX-15: hook a liveSync DENTRO del try pero DESPUES del
      // setItem OK, en su propio try/catch para que cualquier fallo de
      // liveSync NUNCA dispare el toast "Sesión NO persistida".
      try { _syncHook('markDirty'); } catch (_) {}
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
  // OLA3: append-only event log. Cada accion operativa relevante
  // (despegue, advance, back, hold, override, calibracion, RTB
  // engage/cancel, refetch) graba un entry con timestamp + payload
  // minimo. Persiste en session.eventLog y se incluye en el AAR
  // (buildFlownSnapshot) y en el PDF AAR (exportLiveDelta) para
  // proporcionar timeline objetiva del vuelo.
  function _logEvent(type, payload) {
    if (!session) return;
    if (!Array.isArray(session.eventLog)) session.eventLog = [];
    session.eventLog.push({
      t: Date.now(),
      type,
      currentIdx: session.currentIdx,
      payload: payload || null,
    });
    // Cap el log a 500 eventos (orden cronologico, descartamos los mas
    // antiguos) — un vuelo razonable tiene ~50-100 eventos; 500 es
    // proteccion contra acumulacion patologica.
    if (session.eventLog.length > 500) {
      session.eventLog.splice(0, session.eventLog.length - 500);
    }
  }
  function _clearSession() {
    // Audit M5 (major): antes deleteRemote se llamaba ANTES del clear
    // local pero sin await -> race. Si el operador iniciaba ruta nueva
    // inmediatamente, el DELETE stale podia llegar tras el primer PUT
    // y clobberar la session nueva. Ahora: clear local primero +
    // epoch bump (siguiente _saveSession dispara push con nuevo
    // sessionId), y liveSync.delete async como fire-and-forget DESPUES.
    // El sessionId del DELETE corresponde al del momento de la llamada
    // (capturado en la closure de liveSync), no al nuevo.
    session = null;
    // Workflow live-threats-cleanup: reset latch del chip fuel.
    _lastFuelStatusShown = 'ok';
    _invalidateRecalc();
    // BUG#1: epoch++ para que un _refetchWinds en vuelo no committee
    // su resultado sobre la session siguiente.
    _sessionEpoch++;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    // Audit M5: DELETE remoto AL FINAL como fire-and-forget. Si el
    // operador inicia ruta nueva inmediatamente, el push del nuevo
    // PUT lleva sessionId distinto (resetSessionId resetea la closure
    // de liveSync) y no colisiona con este DELETE.
    try { _syncHook('deleteRemote'); } catch (_) {}
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
    // OLA2 ARIA: si es centered con backdrop (modal-like), usar
    // alertdialog + aria-modal para que screen readers lo tratan como
    // dialogo modal. Si es toast normal top-right, status/alert region.
    // El title pasa a ser aria-labelledby de un id local.
    const isModalLike = opts.centered && opts.backdrop !== false;
    if (isModalLike) {
      div.setAttribute('role', 'alertdialog');
      div.setAttribute('aria-modal', 'true');
      div.setAttribute('tabindex', '-1');
    } else {
      div.setAttribute('role', opts.level === 'danger' ? 'alert' : 'status');
      div.setAttribute('aria-live', opts.level === 'danger' ? 'assertive' : 'polite');
    }
    let innerHTML = '';
    let titleId = null;
    if (opts.title) {
      titleId = 'live-toast-title-' + (opts.id || Math.floor(performance.now()));
      innerHTML += '<div class="live-toast-title" id="' + titleId + '">' + opts.title + '</div>';
    }
    if (opts.message) innerHTML += '<div class="live-toast-message">' + opts.message + '</div>';
    if (opts.bodyHTML) innerHTML += '<div class="live-toast-body">' + opts.bodyHTML + '</div>';
    if (opts.actionsHTML) innerHTML += '<div class="live-toast-actions">' + opts.actionsHTML + '</div>';
    div.innerHTML = innerHTML;
    if (titleId && isModalLike) div.setAttribute('aria-labelledby', titleId);
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
    // OLA2 ARIA: focus trap para alertdialog. Tab y Shift+Tab ciclean
    // entre los elementos focusables del dialogo. Escape NO cierra
    // (cerrar requiere boton explicito — el WP-alert necesita accion
    // operativa, no descartable por accidente).
    if (isModalLike) {
      div._prevActiveEl = (typeof document !== 'undefined') ? document.activeElement : null;
      div._trapHandler = function (e) {
        if (e.key !== 'Tab') return;
        const focusables = div.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last  = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      };
      document.addEventListener('keydown', div._trapHandler, true);
    }
    if (opts.autoDismissMs && opts.autoDismissMs > 0) {
      setTimeout(() => { _dismissToast(opts.id || div); }, opts.autoDismissMs);
    }
    return div;
  }
  function _dismissToast(idOrEl) {
    if (!idOrEl) return;
    // OLA2 ARIA: helper para limpiar trap + restaurar focus previo
    // antes de quitar el elemento del DOM.
    function _cleanupTrap(el) {
      if (!el) return;
      if (el._trapHandler) {
        try { document.removeEventListener('keydown', el._trapHandler, true); } catch (_) {}
      }
      if (el._prevActiveEl && typeof el._prevActiveEl.focus === 'function') {
        try { el._prevActiveEl.focus({ preventScroll: true }); } catch (_) {}
      }
    }
    if (typeof idOrEl === 'string') {
      const el = document.querySelector('.live-toast[data-toast-id="' + idOrEl + '"]');
      if (el) { _cleanupTrap(el); el.remove(); }
      const bd = document.querySelector('.live-toast-backdrop[data-toast-id="' + idOrEl + '"]');
      if (bd) bd.remove();
    } else if (idOrEl.parentElement) {
      const id = idOrEl.dataset && idOrEl.dataset.toastId;
      _cleanupTrap(idOrEl);
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
  // Test report: helper para per-WP override maps.
  // _effOverride(i, 'ias') devuelve el IAS efectivo en el row i
  // mirando la map session.iasOverrides — busca el mayor key <= i
  // (ultimo override seteado antes o en el WP actual). Fallback a
  // session.overrides legacy si la map esta vacia. Devuelve null si
  // no hay override aplicable.
  function _effOverride(idx, key) {
    if (!session) return null;
    const mapKey = key + 'Overrides';
    const map = session[mapKey];
    if (map) {
      let bestKey = -1, bestVal = null;
      for (const k in map) {
        const ki = parseInt(k, 10);
        if (Number.isFinite(ki) && ki <= idx && ki > bestKey) {
          bestKey = ki;
          bestVal = map[k];
        }
      }
      if (bestVal != null && Number.isFinite(bestVal) &&
          (key === 'flow' ? bestVal >= 0 : bestVal > 0)) {
        return bestVal;
      }
    }
    // Legacy fallback (sesiones pre-refactor con session.overrides
    // single-range).
    const lov = session.overrides;
    if (lov && Number.isFinite(lov[key]) && Number.isFinite(lov.fromIdx) && lov.fromIdx <= idx) {
      if (key === 'flow' ? lov[key] >= 0 : lov[key] > 0) return lov[key];
    }
    return null;
  }

  // Workflow override-prior-wp-loss: la fuente UNICA de los valores
  // pre-rellenados en el toast wp-alert. _confirmWpAlert y _advance
  // DEBEN comparar el input parseado contra ESTOS valores (no contra
  // _effOverride) para detectar "el operador no toco nada".
  //
  // Sin esto: cuando _effOverride(idx, key) es null (no hay override
  // ni inherited), el toast pre-llena con lp.ias / lp.flow / c.fl
  // (defaults del plan). Confirmar SIN tocar produce 120 !== null =
  // true -> escribe iasOverrides[idx] = 120 espurio. Estas escrituras
  // pinned al plan default shadow-eaban overrides upstream para WPs
  // futuros via la regla max-key<=idx de _effOverride.
  function _prefillsForWp(idx) {
    if (!session) return { ias: null, flow: null, fl: null };
    const lp = session.legPlan[idx];
    const c  = session.coords[idx];
    const effIas  = _effOverride(idx, 'ias');
    const effFlow = _effOverride(idx, 'flow');
    const effFl   = _effOverride(idx, 'fl');
    return {
      ias:  (effIas  != null) ? effIas  : (lp && Number.isFinite(lp.ias))  ? Math.round(lp.ias)  : null,
      flow: (effFlow != null) ? effFlow : (lp && Number.isFinite(lp.flow)) ? Math.round(lp.flow) : null,
      fl:   (effFl   != null) ? effFl   : (c && Number.isFinite(c.fl))     ? c.fl                : null,
    };
  }

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
    const effIas = _effOverride(idx, 'ias');
    if (effIas != null) {
      const geom = window.TSAgestor && window.TSAgestor.geom;
      let newGS = null;
      if (session.refetched && Number.isFinite(lp.legNM) && lp.legNM > 0 &&
          geom && typeof geom.kiasToTAS === 'function') {
        const rIdx = idx - session.refetched.startIdx;
        const daFt = (rIdx >= 0 && session.refetched.legDa && Number.isFinite(session.refetched.legDa[rIdx]))
          ? session.refetched.legDa[rIdx]
          : (Number.isFinite(session.coords[idx].fl) ? session.coords[idx].fl * 100 : null);
        if (Number.isFinite(daFt)) {
          const newTAS = geom.kiasToTAS(effIas, daFt);
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
            // Workflow wind-heading-gs-audit: bug de signo confirmado.
            // hw = -wSpd*cos((wDir-bearing)*π/180) es el TW component
            // signed (negativo=cara, positivo=cola). GS = TAS + hw
            // (no TAS - hw — invertiria el efecto del viento).
            newGS = Math.max(30, newTAS + hw);
          }
        }
      }
      if (Number.isFinite(newGS) && newGS > 0) {
        timeMin = (lp.legNM / newGS) * 60;
      } else {
        const planIas = lp.ias || _planIasFromPlan() || 120;
        timeMin = timeMin * (planIas / effIas);
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
    // Test report: _maybeRefetchWinds NO se llama aqui (eliminaba el
    // cascade tras error 429). Se trigger desde un timer dedicado que
    // arranca en _initWindAutoRefresh (intervalo WIND_TTL_MS=5 min).
    return rows;
  }
  // Workflow wind-eta-resync-design step 6: dispara _refetchWinds si:
  //   (a) No hay windsHourly persistido (boot / post-F5 / nunca fetched)
  //   (b) TTL agotado (>60 min desde windsHourlyFetchedAt)
  //   (c) Horizon corto: la ETA del destino se acerca al limite del
  //       timeseries (< 60 min de margen)
  //   (d) Cualquier escenario tras error reciente -> cooldown 2 min
  // Fire-and-forget — no await.
  function _maybeRefetchWinds(rows) {
    if (!session || !session.started) return;
    if (_refetchInFlight) return;
    const sinceErr = Date.now() - _windRefetchLastError;
    if (sinceErr < WIND_REFETCH_ERROR_COOLDOWN_MS) return;
    const wh = session.windsHourly;
    const noCache = !wh || !Array.isArray(wh) || !wh.length;
    const ttlExpired = !noCache && Number.isFinite(session.windsHourlyFetchedAt) &&
                       (Date.now() - session.windsHourlyFetchedAt) > WIND_TTL_MS;
    // Horizon check: ETA del ultimo WP > horizon - margin.
    let horizonShort = false;
    if (!noCache && Number.isFinite(session.windsHourlyHorizonMs) && Array.isArray(rows)) {
      const lastRow = rows[rows.length - 1];
      if (lastRow && Number.isFinite(lastRow.liveEta)) {
        horizonShort = (session.windsHourlyHorizonMs - lastRow.liveEta) < WIND_HORIZON_MARGIN_MS;
      }
    }
    if (noCache || ttlExpired || horizonShort) {
      // Fire-and-forget. Si falla, el catch en _refetchWinds setea
      // _windRefetchLastError y el cooldown previene tormenta.
      _refetchWinds().catch(() => {});
    }
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
      let iasToUse = lp ? lp.ias : null;
      let flToUse  = c.fl;
      // Workflow wind-eta-resync-design step 4: re-lookup local en el
      // timeseries cacheado. Si hay session.windsHourly y este WP esta
      // en rango, lookup con la liveEta ACTUAL (no la del refetch
      // original). Asi:
      //   - Advance con retraso -> liveEta posterior -> nuevo viento.
      //   - Override IAS reduce GS -> liveEta posterior -> nuevo viento.
      //   - Cambio departureUTC -> liveEta desplazada -> nuevo viento.
      // Sin red. Si no hay windsHourly cae al path session.refetched
      // legacy (back-compat post-F5 antes del primer auto-refetch).
      const meteoApi = window.TSAgestor && window.TSAgestor.meteoApi;
      const wh = session.windsHourly;
      const whStart = session.windsHourlyStartIdx;
      if (wh && Array.isArray(wh) && Number.isFinite(whStart) &&
          i >= whStart && Number.isFinite(liveEta) && meteoApi &&
          typeof meteoApi.lookupWindAt === 'function') {
        const localIdx = i - whStart;
        const ph = wh[localIdx];
        if (ph) {
          const ovFl = _effOverride(i, 'fl');
          const flLookup = Number.isFinite(ovFl) ? ovFl
                         : Number.isFinite(c.fl) ? c.fl : 100;
          try {
            const w = meteoApi.lookupWindAt(ph, new Date(liveEta), flLookup);
            if (w && Number.isFinite(w.windDir) && Number.isFinite(w.windSpeedKt)) {
              windToUse = { dir: w.windDir, speedKt: w.windSpeedKt };
              // Si tenemos temperatura, recomputa TAS/DA con kiasToTAS.
              const geomLocal = window.TSAgestor && window.TSAgestor.geom;
              if (Number.isFinite(w.temperatureC) && geomLocal &&
                  typeof geomLocal.densityAltitudeFt === 'function' &&
                  typeof geomLocal.kiasToTAS === 'function') {
                const paFt = flLookup * 100;
                let oatC = w.temperatureC;
                if (session.calibration && Number.isFinite(session.calibration.oatDeltaC)) {
                  oatC += session.calibration.oatDeltaC;
                }
                const daFt = geomLocal.densityAltitudeFt(paFt, oatC);
                const iasEff = _effOverride(i, 'ias');
                const iasForTas = Number.isFinite(iasEff) ? iasEff
                                : (lp && Number.isFinite(lp.ias) ? lp.ias : 120);
                const newTAS = geomLocal.kiasToTAS(iasForTas, daFt);
                if (Number.isFinite(newTAS) && newTAS > 0) tasToUse = newTAS;
                // Test report fix: ANTES gsToUse no se actualizaba aqui
                // — quedaba en lp.gs (plan default). Si refetched no
                // cubria el WP y effIas era null, gsToUse era stale.
                // Ahora recomputa con HW del viento fresco.
                if (Number.isFinite(newTAS) && newTAS > 0 && i > 0) {
                  const bearing = _bearingDeg(session.coords[i - 1], session.coords[i]);
                  const hw = -w.windSpeedKt * Math.cos((w.windDir - bearing) * Math.PI / 180);
                  gsToUse = Math.max(30, newTAS + hw);
                }
              }
            }
          } catch (_) {}
        }
      }
      if (session.refetched && i >= session.refetched.startIdx) {
        const rIdx = i - session.refetched.startIdx;
        const wdir = session.refetched.legWindDir   && session.refetched.legWindDir[rIdx];
        const wspd = session.refetched.legWindSpeed && session.refetched.legWindSpeed[rIdx];
        if (Number.isFinite(wdir) && Number.isFinite(wspd)) {
          windToUse = { dir: wdir, speedKt: wspd };
        }
        // Test report fix: session.refetched.legTas/legTimes se
        // computaron al MOMENTO del refetch con el IAS THEN (plan
        // default o override anterior). Si AHORA hay un override IAS
        // distinto en este WP (o heredado de uno anterior), aplicar
        // refetched.legTas sobreescribiria con valor stale. Solo
        // aplicamos refetched.legTas/legTimes SI no hay override IAS
        // efectivo en este WP. El bloque effIas posterior recompute
        // con kiasToTAS(effIas, ...) cuando aplica.
        const effIasGuard = _effOverride(i, 'ias');
        if (effIasGuard == null) {
          const rTas = session.refetched.legTas && session.refetched.legTas[rIdx];
          if (Number.isFinite(rTas) && rTas > 0) tasToUse = rTas;
          if (lp && Number.isFinite(lp.legNM) && lp.legNM > 0) {
            const tMin = session.refetched.legTimes && session.refetched.legTimes[rIdx];
            if (Number.isFinite(tMin) && tMin > 0) {
              gsToUse = (lp.legNM / tMin) * 60;
            }
          }
        }
      }
      // Test report: las columnas IAS/TAS/GS/FL ignoraban
      // session.overrides — solo la ETA (via _legTimeMinAt) y el
      // FF (via _computeFuelRest) cambiaban. El operador veia "nada
      // se modifica" porque las cifras que mira (IAS/TAS/GS) seguian
      // mostrando los valores del plan. Ademas ov.fl no se leia en
      // NINGUN sitio. Ahora aplicamos el override aqui para que sea
      // visible Y consistente con el calculo downstream.
      // Per-WP override map lookup (test report: cada WP recuerda
      // su propio IAS/flow/FL — si el operador cambia en N+1, el
      // WP N mantiene el suyo).
      const effFl  = _effOverride(i, 'fl');
      const effIas = _effOverride(i, 'ias');
      let overriddenIas = false, overriddenFl = false;
      const geomRow = window.TSAgestor && window.TSAgestor.geom;
      if (effFl != null) {
        flToUse = effFl;
        overriddenFl = true;
      }
      if (effIas != null) {
        iasToUse = effIas;
        overriddenIas = true;
        if (geomRow && typeof geomRow.kiasToTAS === 'function') {
          let daFt = null;
          if (session.refetched && Array.isArray(session.refetched.legDa) &&
              i >= session.refetched.startIdx) {
            const rIdx = i - session.refetched.startIdx;
            const refDa = session.refetched.legDa[rIdx];
            if (Number.isFinite(refDa)) daFt = refDa;
          }
          if (daFt == null || overriddenFl) {
            const paFt = (Number.isFinite(flToUse) ? flToUse : 100) * 100;
            if (typeof geomRow.densityAltitudeFt === 'function' &&
                typeof geomRow.isaTempC === 'function') {
              let oatC = geomRow.isaTempC(paFt);
              if (session.calibration && Number.isFinite(session.calibration.oatDeltaC)) {
                oatC += session.calibration.oatDeltaC;
              }
              daFt = geomRow.densityAltitudeFt(paFt, oatC);
            } else {
              daFt = paFt;
            }
          }
          const tasNew = geomRow.kiasToTAS(effIas, daFt);
          if (Number.isFinite(tasNew) && tasNew > 0) tasToUse = tasNew;
            // GS efectiva: TAS - HW del refetched (si disponible y
            // mismo leg). Sin viento, GS ≈ TAS.
            let hw = 0;
            if (session.refetched && i >= session.refetched.startIdx &&
                Array.isArray(session.refetched.legWindDir) &&
                Array.isArray(session.refetched.legWindSpeed) &&
                i > 0) {
              const rIdx = i - session.refetched.startIdx;
              const wDir = session.refetched.legWindDir[rIdx];
              const wSpd = session.refetched.legWindSpeed[rIdx];
              if (Number.isFinite(wDir) && Number.isFinite(wSpd)) {
                const bearing = _bearingDeg(session.coords[i - 1], session.coords[i]);
                hw = -wSpd * Math.cos((wDir - bearing) * Math.PI / 180);
              }
            }
            if (Number.isFinite(tasToUse) && tasToUse > 0) {
              // Workflow wind-heading-gs-audit: GS = TAS + hw (TW signed).
              gsToUse = Math.max(30, tasToUse + hw);
            }
        }
      }

      // Combustible consumido en este leg (delta vs WP anterior).
      // Para WP 0 es null (origen, sin leg previo). Si alguno de los
      // dos no es finito, deja null. Usa el row previo si existe.
      let fuelConsumedLeg = null;
      if (i > 0 && Number.isFinite(fuelRest)) {
        const prevRow = rows[i - 1];
        if (prevRow && Number.isFinite(prevRow.fuelRest)) {
          fuelConsumedLeg = prevRow.fuelRest - fuelRest;
        }
      }

      rows.push({
        i,
        name: c.name,
        fl: flToUse,
        flOverridden: overriddenFl,
        isSub: c.isSub,
        planEta,
        liveEta,
        delta: (planEta != null && liveEta != null) ? (liveEta - planEta) : null,
        fuelRest,
        fuelConsumedLeg,
        fuelRestOverridden: session.fuelOverrides[i] != null,
        fuelStatus,
        ias:  iasToUse,
        iasOverridden: overriddenIas,
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
    // Per-WP flow override via helper. Cada WP recuerda su propio flow.
    if (!baseFromOverride) {
      const holdAtBase = Number(session.liveHolds[baseIdx]) || 0;
      if (holdAtBase > 0) {
        const lpBase = session.legPlan[baseIdx];
        const effFlow = _effOverride(baseIdx + 1, 'flow');
        const holdFlow = (effFlow != null)
          ? effFlow
          : (lpBase && lpBase.flow ? lpBase.flow : session.fuelOpts.fuelFlow);
        rest -= (holdAtBase / 60) * holdFlow;
      }
    }
    for (let k = baseIdx + 1; k <= i; k++) {
      const lp = session.legPlan[k];
      const effFlow = _effOverride(k, 'flow');
      const effectiveFlow = (effFlow != null)
        ? effFlow
        : (lp && Number.isFinite(lp.flow) ? lp.flow : session.fuelOpts.fuelFlow);
      const effectiveTimeMin = _legTimeMinAt(k);
      let legFuel = (effectiveTimeMin / 60) * effectiveFlow;
      const holdMin = Number(session.liveHolds[k]) || 0;
      if (holdMin > 0) {
        const holdEffFlow = _effOverride(k + 1, 'flow');
        const holdFlow = (holdEffFlow != null)
          ? holdEffFlow
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

    // Per-WP IAS lookup: el RTB usa el IAS efectivo en el currentIdx.
    const effIasRtb = _effOverride(curr, 'ias');
    const iasUsed = (effIasRtb != null) ? effIasRtb : (_planIasFromPlan() || 120);

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
        // Workflow wind-heading-gs-audit: viento meteorologico (FROM).
        // headwindKt es el TW component SIGNED (negativo=cara,
        // positivo=cola). GS = TAS + headwindKt. Antes era TAS -
        // headwindKt y RTB sobrestimaba GS con headwind -> menor
        // fuelNeeded -> safety hazard (RTB OK cuando deberia NO-GO).
        headwindKt = -wSpd * Math.cos((wDir - bearing) * Math.PI / 180);
        windAvailable = true;
      }
    }
    const gs = Math.max(30, tas + headwindKt);

    const hours = distNM / gs;
    const minutes = hours * 60;
    // Per-WP flow override: usa el efectivo en el currentIdx (lookup
    // en flowOverrides map). Antes hacia `ov.flow` con ov ya
    // removido del refactor v266 -> ReferenceError.
    const effFlowRtb = _effOverride(curr, 'flow');
    const flow = (effFlowRtb != null) ? effFlowRtb : session.fuelOpts.fuelFlow;
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
      // Workflow wind-heading-gs-audit: invertir signo al exportar
      // para que la UI (linea 3188) siga interpretando >=0 como HW.
      // headwindKt interno es TW-signed (negativo=cara), pero la UI
      // muestra etiqueta semantica HW/TW al operador.
      headwindKt: -headwindKt,
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
  async function _refetchWinds(opts) {
    opts = opts || {};
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
            // OLA2 Calibracion: si el operador reporto OAT real por
            // radio, la calibracion guarda el delta vs ISA. Lo
            // aplicamos a ISA(FL del leg) para obtener la OAT efectiva
            // a usar en este leg — mejor que el modelo Open-Meteo
            // porque viene de una medicion real reciente. Asumimos
            // delta constante vs ISA en los 30 min siguientes.
            if (session.calibration &&
                Number.isFinite(session.calibration.oatDeltaC) &&
                typeof geom.isaTempC === 'function') {
              const isaAtThisFl = geom.isaTempC(fl * 100);
              oatC = isaAtThisFl + session.calibration.oatDeltaC;
            }
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
      // Workflow wind-eta-resync-design step 2: persiste el timeseries
      // CRUDO de Open-Meteo para que _recalc pueda hacer re-lookup
      // local cuando cambien las ETAs (advance con retraso, override
      // IAS, override FL, departure change). Sin esto, los winds
      // quedaban congelados al momento del refetch -> ETAs derivadas
      // con vientos stale tras 30 min de vuelo.
      session.windsHourly = ph;
      session.windsHourlyStartIdx = startIdx;
      // Horizonte: ultimo timestamp util del cache (la entrada mas
      // tardia del timeseries de cualquier WP).
      let horizonMs = 0;
      for (let k = 0; k < ph.length; k++) {
        const t = ph[k] && Array.isArray(ph[k].time) ? ph[k].time[ph[k].time.length - 1] : null;
        const tn = t ? Date.parse(t) : NaN;
        if (Number.isFinite(tn) && tn > horizonMs) horizonMs = tn;
      }
      session.windsHourlyHorizonMs = horizonMs;
      session.windsHourlyFetchedAt = Date.now();
      _invalidateRecalc();
      // F2.x bug fix: poner el flag a false ANTES de _refresh para que
      // _renderEval ya no muestre el spinner cuando recompone el DOM.
      _refetchInFlight = false;
      _saveSession();
      _refresh();
    } catch (e) {
      console.warn('[livePlan] refetch winds fallo:', e && e.message ? e.message : e);
      // Workflow wind-eta-resync-design step 6: cooldown anti-thrash.
      _windRefetchLastError = Date.now();
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
    // Workflow wind-heading-gs-audit: delega a TSAgestor.geom.bearing
    // (canonica) para evitar divergencia futura. Fallback inline si
    // geom no esta cargado todavia (caso edge en boot).
    const geom = window.TSAgestor && window.TSAgestor.geom;
    if (geom && typeof geom.bearing === 'function') {
      return geom.bearing([A.lat, A.lon], [B.lat, B.lon]);
    }
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    let dLonDeg = B.lon - A.lon;
    if (dLonDeg > 180)  dLonDeg -= 360;
    if (dLonDeg < -180) dLonDeg += 360;
    const dLon = toRad(dLonDeg);
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
      // Bug user-report (v241 regression): al meter <span data-i18n>
      // dentro de los botones Live para traduccion, click sobre el
      // texto deja e.target = span (sin id) en lugar del button. El
      // matching por t.id fallaba silenciosamente — los botones de
      // advance, back, hold, RTB, refresh viento y reset dejaban de
      // funcionar al pulsarlos en su parte de texto.
      // Fix: si el target esta dentro de un <button>, tratamos el
      // button como target para todos los chequeos por id.
      let t = e.target;
      if (!t) return;
      try {
        const btn = t.closest && t.closest('button');
        if (btn) t = btn;
      } catch (_) {}
      if (t.id === 'btn-live-start') { _iniciarRuta(); return; }
      if (t.id === 'btn-live-now')   { _setStartNow();  return; }
      if (t.id === 'btn-live-advance') { _advance(); return; }
      if (t.id === 'btn-live-back')    { _back(); return; }
      if (t.id === 'btn-live-hold')    { _addHold(); return; }
      if (t.id === 'btn-live-rtb')     { _showRtbInline(); return; }
      if (t.id === 'btn-live-reset')   { _resetSession(); return; }
      if (t.id === 'btn-live-tts')     { _toggleTts(); return; }
      if (t.id === 'btn-live-calibrate') { _calibrate(); return; }
      if (t.id === 'btn-live-apply-overrides') { _applyOverrides(); return; }
      if (t.id === 'btn-live-clear-overrides') { _clearOverrides(); return; }
      if (t.id === 'btn-live-refetch-winds') { _refetchWinds({ force: true }); return; }
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
    // Workflow live-overrides-marker-diagnose bug 2: actualiza la
    // posicion estimada del marker en cada tick (~1Hz). Antes el
    // marker quedaba estatico entre confirmaciones (minutos) — ahora
    // se mueve continuamente segun fraccion de tiempo en el leg.
    // Solo toca el marker (no recompone polyline ni stats — barato).
    _updateMarkerTick();
  }
  function _updateMarkerTick() {
    try {
      const mv = window.TSAgestor && window.TSAgestor.mapView;
      if (!mv || typeof mv.setLiveMarker !== 'function') return;
      if (!session || !session.started) return;
      const est = _estimateLivePosition();
      if (est && est.latlng) mv.setLiveMarker(est.latlng);
    } catch (_) {}
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
    // Workflow override-prior-wp-loss: usa _prefillsForWp para asegurar
    // que el toast y el gate de escritura comparen contra LOS MISMOS
    // valores. Sin esto, escribir override espurio si operador
    // confirma sin tocar nada.
    const pre = _prefillsForWp(idx);
    const iasVal  = (pre.ias  != null) ? pre.ias  : '';
    const flowVal = (pre.flow != null) ? pre.flow : '';
    const flVal   = (pre.fl   != null) ? pre.fl   : '';
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
    // OLA2 TTS: locucion del cue. Usa solo el nombre (no el FL ni la
    // hora) para que sea corto y la voz no machaque el toast visual.
    const safeName = (c.name || '').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s]/g, ' ').trim();
    _speak('Ee te a en ' + (safeName || 'siguiente waypoint'));
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

  // ── OLA2: TTS audio cues ──────────────────────────────────────────
  // Web Speech API. Avisa por voz al operador en cabina ruidosa
  // (toast in-page puede pasar desapercibido). Configurable via toggle
  // en la barra de acciones + persistido en localStorage.
  // Cues:
  //   - WP-alert (ETA alcanzada): "ETA en waypoint X"
  //   - Fuel cruza BINGO: "Combustible bajo bingo" (one-shot)
  //   - Fuel cruza JOKER: "Combustible bajo joker" (one-shot)
  //   - SIGMET nuevo cruzando ruta: "Aviso meteorologico en ruta"
  //   - TSA activa nueva: "Cruzando area TSA"
  const TTS_KEY = 'tsagestor_live_tts_enabled';
  let _ttsEnabled = false;
  // Estado one-shot: evita repetir el mismo cue en cada tick.
  let _ttsLastBingoIdx = -1;
  let _ttsLastJokerIdx = -1;
  let _ttsLastSigmetIds = new Set();
  // Workflow live-threats-cleanup: latch one-shot del chip fuel en
  // _renderThreats (independiente del TTS). Solo emite chip en TRANSICION
  // ok->joker->bingo. Reset en stop() y _resetStateInternal.
  let _lastFuelStatusShown = 'ok';
  let _ttsLastTSAIds = new Set();
  function _loadTtsConfig() {
    try { _ttsEnabled = localStorage.getItem(TTS_KEY) === '1'; }
    catch (_) { _ttsEnabled = false; }
  }
  function _saveTtsConfig() {
    try { localStorage.setItem(TTS_KEY, _ttsEnabled ? '1' : '0'); } catch (_) {}
  }
  function _speak(text, opts) {
    if (!_ttsEnabled) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window) ||
        typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      // Cancela utterances previos para no acumular cola si llegan
      // varios cues seguidos (BINGO + WP alcanzado a la vez).
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = (opts && opts.lang) || 'es-ES';
      u.rate = (opts && opts.rate) || 1.0;
      u.volume = (opts && opts.volume) || 1.0;
      window.speechSynthesis.speak(u);
    } catch (_) { /* best-effort */ }
  }
  function _toggleTts() {
    _ttsEnabled = !_ttsEnabled;
    _saveTtsConfig();
    _applyTtsButtonState();
    if (_ttsEnabled) {
      // Confirmacion audible para que el operador sepa que se activo
      // sin tener que esperar al primer cue. Tambien sirve como
      // "primer gesto" para autorizar speechSynthesis en navegadores
      // que requieren interaccion previa.
      _speak('Avisos por voz activados');
    } else {
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
    }
  }
  function _applyTtsButtonState() {
    const btn = document.getElementById('btn-live-tts');
    if (!btn) return;
    if (_ttsEnabled) {
      btn.textContent = '🔊 TTS ON';
      btn.classList.add('btn-warn-active');
    } else {
      btn.textContent = '🔊 TTS';
      btn.classList.remove('btn-warn-active');
    }
  }
  // Detector one-shot de cruce BINGO/JOKER: detecta la primera vez
  // que el currentRow entra en bingo/joker (no avisa de nuevo hasta
  // que vuelve por encima y baja otra vez). Llamado desde _refresh.
  function _ttsCheckFuelThresholds(rows) {
    if (!_ttsEnabled || !session) return;
    const cur = rows && rows[session.currentIdx];
    if (!cur) return;
    if (cur.fuelStatus === 'bingo') {
      if (_ttsLastBingoIdx !== session.currentIdx) {
        _ttsLastBingoIdx = session.currentIdx;
        _speak('Atencion, combustible bajo bingo');
      }
    } else if (cur.fuelStatus === 'joker') {
      if (_ttsLastJokerIdx !== session.currentIdx) {
        _ttsLastJokerIdx = session.currentIdx;
        _speak('Combustible bajo joker');
      }
      _ttsLastBingoIdx = -1; // re-armar bingo
    } else {
      _ttsLastBingoIdx = -1;
      _ttsLastJokerIdx = -1;
    }
  }
  function _ttsCheckSigmets() {
    if (!_ttsEnabled || !Array.isArray(_sigmetCrossings)) return;
    const currentIds = new Set(_sigmetCrossings.map(c => c.id || c.icaoId || JSON.stringify(c).slice(0,32)));
    let nuevos = 0;
    currentIds.forEach(id => { if (!_ttsLastSigmetIds.has(id)) nuevos++; });
    if (nuevos > 0) _speak('Aviso meteorologico en ruta');
    _ttsLastSigmetIds = currentIds;
  }
  function _ttsCheckTSAs() {
    if (!_ttsEnabled || !Array.isArray(_activeTSAcrossings)) return;
    const currentIds = new Set(_activeTSAcrossings.map(c => (c.tsa && c.tsa.id) || c.id || JSON.stringify(c).slice(0,32)));
    let nuevos = 0;
    currentIds.forEach(id => { if (!_ttsLastTSAIds.has(id)) nuevos++; });
    if (nuevos > 0) _speak('Atencion, cruzando area restringida activa');
    _ttsLastTSAIds = currentIds;
  }

  // ── OLA2: Calibracion manual OAT vs ISA ───────────────────────────
  // El operador escucha en radio la OAT real (-42 °C) y la QNH actual.
  // Comparamos con la OAT ISA del FL actual y guardamos el DELTA como
  // ajuste constante para todos los legs restantes: efectivamente
  // "esta atmosfera esta N grados mas caliente/fria que ISA". El
  // delta se aplica al calcular DA en _refetchWinds y por tanto a
  // TAS via kiasToTAS — la GS y el consumo del log se ajustan a la
  // realidad reportada por radio, no solo al modelo Open-Meteo.
  //
  // Guarda en session.calibration:
  //   { oatDeltaC, oatActualC, qnhHpa, measuredAtFl, calibratedAt }
  // Visible como chip en la card de Estado.
  function _calibrate() {
    if (!session || !session.started) {
      alert('Inicia la ruta Live antes de calibrar.');
      return;
    }
    const geom = window.TSAgestor && window.TSAgestor.geom;
    if (!geom || typeof geom.isaTempC !== 'function') {
      alert('Modulo geom no disponible.');
      return;
    }
    const idx = session.currentIdx;
    const fl = (session.coords[idx] && session.coords[idx].fl) || 100;
    const isa = geom.isaTempC(fl * 100);
    // Pre-rellena con la OAT del refetched si existe (asi el operador
    // empieza desde el modelo y solo ajusta el delta).
    let prefillOat = isa;
    if (session.refetched && Array.isArray(session.refetched.legOat)) {
      const rIdx = idx - session.refetched.startIdx;
      if (rIdx >= 0 && Number.isFinite(session.refetched.legOat[rIdx])) {
        prefillOat = session.refetched.legOat[rIdx];
      }
    }
    const oatStr = prompt(
      `Calibracion OAT — FL${String(fl).padStart(3, '0')}\n\n` +
      `ISA del FL actual: ${isa.toFixed(1)} °C\n` +
      `Modelo (refetched): ${prefillOat.toFixed(1)} °C\n\n` +
      'Introduce OAT REAL reportada por radio (°C):',
      String(Math.round(prefillOat))
    );
    if (oatStr == null) return;
    const oatActual = parseFloat(oatStr);
    if (!Number.isFinite(oatActual)) {
      alert('Valor invalido. Cancelado.');
      return;
    }
    const qnhStr = prompt(
      'QNH actual (hPa) — opcional, deja vacio para omitir:',
      '1013'
    );
    let qnhHpa = null;
    if (qnhStr != null && qnhStr.trim() !== '') {
      const q = parseFloat(qnhStr);
      if (Number.isFinite(q) && q > 800 && q < 1100) qnhHpa = q;
    }
    session.calibration = {
      oatDeltaC:     oatActual - isa,
      oatActualC:    oatActual,
      isaOatC:       isa,
      qnhHpa,
      measuredAtFl:  fl,
      calibratedAt:  Date.now(),
    };
    _logEvent('calibrate', Object.assign({}, session.calibration));
    _saveSession();
    // Refetch fuerza recalculo de TAS/GS con la calibracion aplicada.
    _refetchWinds();
    _refresh();
    _showToast({
      id: 'calibration-applied', level: 'info',
      title: '📡 Calibracion aplicada',
      message: `OAT real ${oatActual} °C en FL${fl} · delta vs ISA ${session.calibration.oatDeltaC >= 0 ? '+' : ''}${session.calibration.oatDeltaC.toFixed(1)} °C. Aplicado a TAS y consumo de los legs restantes.`,
      autoDismissMs: 8000,
    });
  }
  function _clearCalibration() {
    if (!session) return;
    delete session.calibration;
    _saveSession();
    _refetchWinds();
    _refresh();
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
    // Workflow override-prior-wp-loss: compara el input parseado
    // contra el valor que el toast PRE-RELLENO (no contra
    // _effOverride). _prefillsForWp devuelve EL MISMO valor que
    // _showWpAlert metio en el input. Asi:
    //   - Operador NO toca nada -> ias === prefill.ias -> NO se escribe.
    //   - Operador edita -> ias !== prefill.ias -> SE escribe.
    // Antes _effOverride(idx, 'ias') retornaba null cuando no habia
    // override propio NI inherited -> el toast pre-relleno con
    // Math.round(lp.ias) (plan default) -> confirmar sin tocar daba
    // ias=120 !== null = true -> iasOverrides[idx] = 120 ESPURIO.
    // Ese espurio shadow-eaba overrides reales upstream para WPs
    // futuros via la regla max-key<=idx de _effOverride.
    session.iasOverrides  = session.iasOverrides  || {};
    session.flowOverrides = session.flowOverrides || {};
    session.flOverrides   = session.flOverrides   || {};
    const pref = _prefillsForWp(idx);
    if (Number.isFinite(ias) && ias > 0 && ias !== pref.ias) {
      session.iasOverrides[idx] = ias;
    }
    if (Number.isFinite(flow) && flow >= 0 && flow !== pref.flow) {
      session.flowOverrides[idx] = flow;
    }
    if (Number.isFinite(fl) && fl > 0 && fl !== pref.fl) {
      session.flOverrides[idx] = fl;
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
    _renderIsaBox();  // Workflow live-threats-cleanup: ISA en Estado actual
    _renderTable(rows);
    _renderEval(rows);
    _renderThreats(rows);
    _updateMapOverlay();
    // F2.4: auto-refresh METAR/TAF destino si falta poco para llegar.
    // Fire-and-forget — no bloquea el render.
    _maybeRefreshDestMet(rows);
    // F2.5: refresh SIGMETs (max cada 20 min) + recompute cross-check
    // contra la ruta restante.
    _maybeRefreshSigmets();
    // F2.6: cross-check TSAs activas en este instante.
    _recomputeActiveTSACrossings();
    // OLA2 TTS: detectores one-shot DESPUES de tener los datos
    // refrescados. Cada uno guarda el ultimo estado para no repetir.
    _ttsCheckFuelThresholds(rows);
    _ttsCheckSigmets();
    _ttsCheckTSAs();
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
  // Workflow live-overrides-marker-diagnose bug 2: helper para
  // interpolar la posicion de la aeronave a lo largo de la polilinea
  // entre currentIdx y nextReal segun fraccion de tiempo en el leg.
  // Antes el marker estaba estatico en coords[currentIdx] entre
  // confirmaciones — durante minutos quedaba inmovil aunque el avion
  // si avanzara fisicamente. Ahora interpola posicion-en-leg.
  function _interpolateAlongLeg(fromIdx, toIdx, fraction) {
    if (!session || !Array.isArray(session.coords)) return null;
    const coords = session.coords;
    if (fromIdx < 0 || toIdx >= coords.length || fromIdx >= toIdx) {
      const c = coords[fromIdx];
      return (c && Number.isFinite(c.lat)) ? [c.lat, c.lon] : null;
    }
    const f = Math.max(0, Math.min(1, fraction));
    // Distancia acumulada del sub-segmento [fromIdx, toIdx].
    let totalKm = 0;
    for (let k = fromIdx + 1; k <= toIdx; k++) {
      const lk = Number(coords[k].legDistKm) || 0;
      totalKm += lk;
    }
    if (totalKm <= 0) {
      const c = coords[fromIdx];
      return (c && Number.isFinite(c.lat)) ? [c.lat, c.lon] : null;
    }
    const targetKm = totalKm * f;
    let acc = 0;
    for (let k = fromIdx + 1; k <= toIdx; k++) {
      const lk = Number(coords[k].legDistKm) || 0;
      if (acc + lk >= targetKm || k === toIdx) {
        const remaining = Math.max(0, targetKm - acc);
        const t = lk > 0 ? (remaining / lk) : 0;
        const a = coords[k - 1], b = coords[k];
        if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
        const lat = a.lat + (b.lat - a.lat) * t;
        const lon = a.lon + (b.lon - a.lon) * t;
        return [lat, lon];
      }
      acc += lk;
    }
    const c = coords[toIdx];
    return (c && Number.isFinite(c.lat)) ? [c.lat, c.lon] : null;
  }

  // Computa la posicion estimada del avion AHORA basada en
  // actualPassTimes[currentIdx] + ETA[nextReal] + Date.now().
  // Devuelve { latlng, fraction, overdue } o null si no hay session
  // activa o no se puede estimar.
  function _estimateLivePosition() {
    if (!session || !session.started || !Array.isArray(session.coords) || session.coords.length < 1) return null;
    const idx = Math.max(0, Math.min(session.currentIdx | 0, session.coords.length - 1));
    // nextReal = primer WP NO-sub a partir de idx+1.
    let nextReal = -1;
    for (let k = idx + 1; k < session.coords.length; k++) {
      if (!session.coords[k].isSub && !session.coords[k].isClimbDescentSub) {
        nextReal = k; break;
      }
    }
    if (nextReal < 0) {
      // En destino o no hay siguiente — marker en currentIdx.
      const c = session.coords[idx];
      return (c && Number.isFinite(c.lat))
        ? { latlng: [c.lat, c.lon], fraction: 1, overdue: false }
        : null;
    }
    const passT = session.actualPassTimes && session.actualPassTimes[idx];
    if (!Number.isFinite(passT)) {
      // Sin timestamp de paso en currentIdx (sesion edge), marker en idx.
      const c = session.coords[idx];
      return (c && Number.isFinite(c.lat))
        ? { latlng: [c.lat, c.lon], fraction: 0, overdue: false }
        : null;
    }
    // ETA al nextReal: del cache _recalc si esta vigente; si no,
    // calculo barato sumando _legTimeMinAt.
    let etaNext = null;
    try {
      const rows = _recalc();
      if (rows && rows[nextReal] && Number.isFinite(rows[nextReal].liveEta)) {
        etaNext = rows[nextReal].liveEta;
      }
    } catch (_) {}
    if (!Number.isFinite(etaNext) || etaNext <= passT) {
      const c = session.coords[idx];
      return (c && Number.isFinite(c.lat))
        ? { latlng: [c.lat, c.lon], fraction: 0, overdue: false }
        : null;
    }
    const now = Date.now();
    const totalMs = etaNext - passT;
    const elapsedMs = now - passT;
    const f = Math.max(0, Math.min(1, elapsedMs / totalMs));
    const latlng = _interpolateAlongLeg(idx, nextReal, f);
    if (!latlng) return null;
    return { latlng, fraction: f, overdue: elapsedMs > totalMs * 1.2 };
  }

  function _updateMapOverlay() {
    const mv = window.TSAgestor && window.TSAgestor.mapView;
    if (!mv || typeof mv.setLiveMarker !== 'function') return;
    // BUG#7 (audit v2): mantener sync el flag de supresion del plan
    // original en el mapa con session.rtbEngaged.
    if (typeof mv.suppressFlightPlan === 'function') {
      mv.suppressFlightPlan(!!(session && session.rtbEngaged));
    }
    if (!session || !session.started || !session.coords || session.coords.length < 1) {
      mv.clearLiveOverlay && mv.clearLiveOverlay();
      return;
    }
    const idx = Math.max(0, Math.min(session.currentIdx | 0, session.coords.length - 1));
    // Marker en posicion estimada (interpolacion temporal en el leg
    // current -> next). Sin esto el marker se quedaba estatico en el
    // ultimo WP confirmado durante minutos.
    const est = _estimateLivePosition();
    if (est && est.latlng) {
      mv.setLiveMarker(est.latlng);
    } else {
      const c = session.coords[idx];
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
        mv.setLiveMarker([c.lat, c.lon]);
      } else {
        mv.setLiveMarker(null);
      }
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
    _logEvent('start', { startMs });
    _saveSession();
    // OLA4: push inmediato (transicion critica — empieza la operativa).
    try {
      const ls = window.TSAgestor && window.TSAgestor.liveSync;
      if (ls && typeof ls.pushNow === 'function') ls.pushNow({ reason: 'start' });
    } catch (_) {}
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
    // Legacy single-range overrides (sesiones pre-refactor per-WP).
    if (session.overrides) {
      const lov = session.overrides;
      const parts = [];
      if (Number.isFinite(lov.ias))  parts.push(`IAS ${lov.ias} kt`);
      if (Number.isFinite(lov.flow)) parts.push(`Flow ${lov.flow}/h`);
      if (Number.isFinite(lov.fl))   parts.push(`FL${lov.fl}`);
      if (parts.length) {
        events.push({
          time: session.actualPassTimes[lov.fromIdx] || null,
          type: 'Override',
          detail: `Desde WP #${(lov.fromIdx | 0) + 1}: ${parts.join(', ')}`,
        });
      }
    }
    // Per-WP override maps (post-refactor v266): emite un event por
    // cada WP donde el operador cambio algun parametro.
    const collectIdx = new Set();
    ['iasOverrides', 'flowOverrides', 'flOverrides'].forEach(k => {
      const m = session[k];
      if (!m) return;
      Object.keys(m).forEach(ki => { collectIdx.add(parseInt(ki, 10)); });
    });
    Array.from(collectIdx).filter(Number.isFinite).sort((a, b) => a - b).forEach(idx => {
      const parts = [];
      const iasV  = session.iasOverrides  && session.iasOverrides[idx];
      const flowV = session.flowOverrides && session.flowOverrides[idx];
      const flV   = session.flOverrides   && session.flOverrides[idx];
      if (Number.isFinite(iasV))  parts.push(`IAS ${iasV} kt`);
      if (Number.isFinite(flowV)) parts.push(`Flow ${flowV}/h`);
      if (Number.isFinite(flV))   parts.push(`FL${flV}`);
      if (parts.length) {
        events.push({
          time: session.actualPassTimes[idx] || null,
          type: 'Override',
          detail: `WP #${(idx | 0) + 1}: ${parts.join(', ')}`,
        });
      }
    });
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

    // OLA3: incluir el eventLog estructurado tal cual — el AAR PDF
    // lo renderiza como timeline objetiva. El array `events` legacy
    // (curado para presentacion) se conserva por compatibilidad con
    // exportLiveDelta de versiones previas.
    const eventLog = Array.isArray(session.eventLog)
      ? session.eventLog.slice()
      : [];

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
      eventLog,
      session: JSON.parse(JSON.stringify(session)),
    };
  }

  async function _saveFlown() {
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
    // Audit M1 (major): antes el toast "persistido" se mostraba ANTES
    // de await finalize() — si el backend estaba offline o devolvia 5xx,
    // el operador veia OK verde pero el sync nunca llegaba. Ahora
    // await el finalize y distinguimos:
    //   - sync OK            -> toast success verde (local + backend)
    //   - sync FAIL / offline -> toast WARN ambar (local OK, backend pendiente)
    //   - sync disabled      -> toast success verde (sin mencion de sync)
    let syncStatus = 'disabled';
    try {
      const ls = window.TSAgestor && window.TSAgestor.liveSync;
      if (ls && typeof ls.isConfigured === 'function' && ls.isConfigured()) {
        try {
          await ls.finalize();
          syncStatus = (ls.getStatus && ls.getStatus().kind === 'auth-fail') ? 'auth-fail' : 'ok';
        } catch (_) { syncStatus = 'fail'; }
      }
    } catch (_) {}
    const baseMsg = `"${name}" persistido. Visible en Plan → Planes guardados (seccion AAR) y en el preflight Live al resetear la sesion.`;
    if (syncStatus === 'fail') {
      _showToast({
        id: 'aar-result', level: 'warn',
        title: '✓ Guardado local · ⚠ sync pendiente',
        message: baseMsg + ' Backend no respondio — el guardado local esta OK pero el dispatch no ha recibido la finalizacion. Pulsa el chip de sync para reintentar.',
        autoDismissMs: 12000,
      });
    } else if (syncStatus === 'auth-fail') {
      _showToast({
        id: 'aar-result', level: 'warn',
        title: '✓ Guardado local · 🔒 sync auth fail',
        message: baseMsg + ' Token de unidad rechazado por el backend — reconfigura en Ajustes para sincronizar.',
        autoDismissMs: 12000,
      });
    } else {
      _showToast({
        id: 'aar-result', level: 'success',
        title: '✓ Vuelo realizado guardado',
        message: baseMsg,
        autoDismissMs: 10000,
      });
    }
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
    // Audit M2 (major): reentry guard. Doble-tap en touchscreen (caso
    // realista post-vuelo) arrancaba dos exports paralelos con mismo
    // filename. withExportLock deshabilita el boton mientras corre.
    const btn = document.getElementById('btn-live-pdf-aar');
    const runner = async () => {
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
    };
    if (typeof pdf.withExportLock === 'function') {
      await pdf.withExportLock(btn, runner);
    } else {
      await runner();
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
    // OLA2: chip de calibracion OAT activa.
    _renderCalibrationChip();
  }

  function _renderCalibrationChip() {
    const statusCard = document.querySelector('.live-status-card');
    if (!statusCard) return;
    let chip = document.getElementById('live-calibration-chip');
    if (!session || !session.calibration ||
        !Number.isFinite(session.calibration.oatDeltaC)) {
      if (chip) chip.remove();
      return;
    }
    const cal = session.calibration;
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'live-calibration-chip';
      chip.className = 'live-calibration-chip';
      chip.title = 'Click para borrar la calibracion';
      chip.addEventListener('click', () => {
        if (confirm('¿Borrar la calibracion OAT/QNH actual?')) _clearCalibration();
      });
      const head = statusCard.querySelector('.live-card-head');
      if (head) head.appendChild(chip);
    }
    const ageMin = Math.floor((Date.now() - cal.calibratedAt) / 60000);
    const sign = cal.oatDeltaC >= 0 ? '+' : '';
    chip.innerHTML =
      `📡 Cal. OAT ${sign}${cal.oatDeltaC.toFixed(1)}°C` +
      (Number.isFinite(cal.qnhHpa) ? ` · QNH ${cal.qnhHpa}` : '') +
      ` <span class="dim">(${ageMin}m)</span>`;
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
      // Test report: marcar visualmente las celdas que estan
      // affectadas por override en vuelo, para que el operador vea
      // de un vistazo qué valores son del plan vs del override
      // recien aplicado. Asterisco + clase para el styling.
      const flCellCls  = r.flOverridden  ? ' live-cell-override' : '';
      const iasCellCls = r.iasOverridden ? ' live-cell-override' : '';
      const flMark  = r.flOverridden  ? '<span class="live-override-mark" title="Override de FL activo">✱</span> ' : '';
      const iasMark = r.iasOverridden ? '<span class="live-override-mark" title="Override de IAS activo">✱</span> ' : '';
      const fuelInputCls = 'live-fuel-input' + (r.fuelRestOverridden ? ' live-fuel-overridden' : '') +
                          (fuelClass ? ' ' + fuelClass : '');
      const fuelCell = `<td><input type="number" class="${fuelInputCls}" data-idx="${r.i}" value="${Number.isFinite(r.fuelRest) ? Math.round(r.fuelRest) : ''}" step="10" placeholder="edit" title="Combustible restante en este WP — click para editar (valor real medido)"></td>`;
      // Columna Consumo (combustible consumido en este tramo).
      // Origen y los WPs sin previo conocido -> "—".
      const consTxt = Number.isFinite(r.fuelConsumedLeg)
        ? Math.round(r.fuelConsumedLeg)
        : '—';
      const consCell = `<td class="live-fuel-consumed" title="Combustible consumido en este tramo${r.liveHoldMin > 0 ? ' (incluye el hold)' : ''}">${consTxt}</td>`;
      tr.innerHTML =
        `<td>${displayN}</td>` +
        `<td><b>${r.name}</b>${subBadge}${holdTxt}</td>` +
        `<td class="${flCellCls}">${flMark}${flTxt}</td>` +
        `<td class="${iasCellCls}">${iasMark}${iasTxt}</td>` +
        `<td>${tasTxt}</td>` +
        `<td>${gsTxt}</td>` +
        `<td>${windTxt}</td>` +
        `<td>${_fmtTime(r.planEta)}</td>` +
        `<td><b>${_fmtTime(r.liveEta)}</b></td>` +
        `<td class="${deltaClass}">${_fmtDelta(r.delta)}</td>` +
        consCell +
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

  // ── OLA2: Render Amenazas (threats timeline unificado) ────────────
  // Consolida en una sola card las fuentes que antes vivian dispersas
  // por la card de Evaluacion + toasts: SIGMETs cruzando la ruta,
  // TSAs activas en este momento, desviaciones ISA significativas,
  // estado RTB no viable, antiguedad del viento, conflictos del plan
  // que aun no se han atravesado. Cada item es un chip con nivel de
  // urgencia (now/30m/1h/info) y un dataset que el operador puede
  // expandir al clicarlo (popup con info).
  // Workflow live-threats-cleanup: refactor del panel Amenazas.
  // Cambios clave:
  //   - ISA dev por WP -> ELIMINADO (cubierto por _renderIsaBox)
  //   - TSA activa dedup por id
  //   - Conflicto TSA dedup por tsa.id (mas cercano gana)
  //   - SIGMET filtrado por ETA <= 2h
  //   - Fuel BINGO/JOKER en transicion (latch _lastFuelStatusShown)
  //   - Viento antiguo umbral 45 min (era 30)
  //   - Bucketing attend / monitor con badges duales en header
  function _sigmetCrossEta(c) {
    if (!c || !Array.isArray(c.segments) || !c.segments.length) return null;
    const seg = c.segments[0];
    const fromIdx = Number.isFinite(seg.fromIdx) ? seg.fromIdx
                  : (Number.isFinite(seg.toIdx) ? seg.toIdx - 1 : null);
    if (fromIdx == null) return null;
    return (session && session.plannedEtas) ? session.plannedEtas[fromIdx] : null;
  }
  function _renderThreats(rows) {
    const ul        = document.getElementById('live-threats-list');
    const ulMon     = document.getElementById('live-threats-list-monitor');
    const wrapMon   = document.getElementById('live-threats-monitor-wrap');
    const cntMon    = document.getElementById('live-threats-monitor-count');
    const badgeAttend  = document.getElementById('live-threats-attend-badge');
    const badgeMonitor = document.getElementById('live-threats-monitor-badge');
    if (!ul) return;
    ul.innerHTML = '';
    if (ulMon) ulMon.innerHTML = '';
    if (!session) {
      if (badgeAttend)  { badgeAttend.textContent = '0 atender'; badgeAttend.classList.add('is-empty'); }
      if (badgeMonitor) badgeMonitor.textContent = '0 monitorizar';
      if (wrapMon) wrapMon.hidden = true;
      return;
    }
    const threats = [];
    const nowMs = Date.now();
    const fmtMin = (ms) => {
      if (!Number.isFinite(ms)) return '—';
      const min = Math.round(ms / 60000);
      if (min <= 0) return 'ahora';
      if (min < 60) return 'en ' + min + ' min';
      const h = Math.floor(min / 60), m = min % 60;
      return 'en ' + h + 'h' + (m ? ' ' + m + 'min' : '');
    };
    const urgencyOf = (etaMs) => {
      if (!Number.isFinite(etaMs)) return 'info';
      const minTo = (etaMs - nowMs) / 60000;
      if (minTo <= 5)  return 'now';
      if (minTo <= 30) return 'high';
      if (minTo <= 60) return 'med';
      return 'low';
    };
    const orderUrgency = { now: 0, high: 1, med: 2, low: 3, info: 4 };
    const orderSeverity = { danger: 0, warn: 1, info: 2 };
    const orderCategory = { tsaActive: 0, sigmet: 1, tsaConflict: 2, fuel: 3, wind: 4, other: 5 };

    // 1) TSA activa AHORA — dedup por id.
    if (Array.isArray(_activeTSAcrossings)) {
      const seen = new Set();
      _activeTSAcrossings.forEach(c => {
        const tid = (c.tsa && (c.tsa.id || c.tsa.name)) || '';
        if (!tid || seen.has(tid)) return;
        seen.add(tid);
        const name = c.tsa && c.tsa.name || 'TSA';
        const ends = c.activeUntil ? _fmtTime(c.activeUntil) : null;
        threats.push({
          urgency: 'now',
          severity: 'danger',
          category: 'tsaActive',
          label: '🛑 TSA activa: ' + name,
          detail: 'Cruza tu ruta restante. ' + (ends ? 'Activa hasta ' + ends + 'Z.' : ''),
          subtext: ends ? 'hasta ' + ends + 'Z' : '',
        });
      });
    }

    // 2) SIGMETs cruzando ruta — filtra por ETA <= 2h.
    if (Array.isArray(_sigmetCrossings)) {
      _sigmetCrossings.forEach(c => {
        const tipo = (c.sig && (c.sig.hazard || c.sig.icaoId || c.sig.type)) || 'SIGMET';
        const validTo = c.sig && c.sig.validTimeTo ? new Date(c.sig.validTimeTo).getTime() : null;
        const fl1 = (c.sig && c.sig.altitudeLow1) || '';
        const fl2 = (c.sig && c.sig.altitudeHi1) || '';
        const altTxt = (fl1 || fl2) ? ' · FL' + fl1 + '-' + fl2 : '';
        const crossEta = _sigmetCrossEta(c);
        // Filtro: si la ETA del cruce supera 2h, saltamos (queda en
        // _renderEval para awareness, no aqui en attend).
        const TWO_HRS_MS = 2 * 60 * 60 * 1000;
        if (Number.isFinite(crossEta) && (crossEta - nowMs) > TWO_HRS_MS) return;
        // severity segun hazard.
        const haz = String(tipo || '');
        const severe = /TS|SEV TURB|SEV ICE|VA/i.test(haz) ? 'danger' : 'warn';
        threats.push({
          urgency: urgencyOf(crossEta),
          severity: severe,
          category: 'sigmet',
          label: '⚠ SIGMET ' + tipo + altTxt,
          detail: c.sig && c.sig.rawSigmet ? c.sig.rawSigmet : 'SIGMET cruzando ruta restante',
          subtext: validTo ? 'Válido hasta ' + _fmtTime(validTo) : '',
        });
      });
    }

    // 3) Conflictos del plan — usa CLUSTERS (workflow tsa-conflict-redesign).
    //    Una "zona caliente" = un cluster (TSAs solapadas en mismo
    //    along-track range). El operador ve 1 chip por zona, no N por
    //    TSA. Si hay multiples TSAs en el cluster (cluster.severity ===
    //    'overlap'), se indica en el label.
    const plan = _getPlan();
    if (plan && Array.isArray(plan.conflictClusters) && plan.conflictClusters.length) {
      plan.conflictClusters.forEach(cl => {
        // Filtra clusters cuya zona ya quedo atras del currentIdx.
        // currentIdx en session.coords -> cumDistKm para comparar.
        const curCoord = session.coords[session.currentIdx];
        const curKm = (curCoord && Number.isFinite(curCoord.cumDistKm)) ? curCoord.cumDistKm : 0;
        if (cl.rangoKm[1] < curKm) return;
        const tStart = cl.tStartMin instanceof Date ? cl.tStartMin.getTime() : null;
        const tEnd   = cl.tEndMax   instanceof Date ? cl.tEndMax.getTime()   : null;
        const urg = urgencyOf(tStart);
        const nTsa = cl.tsas.length;
        const repName = (cl.tsas[0] && cl.tsas[0].tsa && cl.tsas[0].tsa.name) || 'TSA';
        const label = nTsa > 1
          ? `⚠ Zona caliente: ${repName} + ${nTsa - 1} TSA(s) solapada(s)`
          : `⚠ Conflicto TSA: ${repName}`;
        const detail = nTsa > 1
          ? `Cluster ${cl.id} · ${nTsa} TSAs en zona ${cl.rangoNm[0].toFixed(0)}-${cl.rangoNm[1].toFixed(0)} NM. ` +
            cl.tsas.map(t => t.tsa && t.tsa.name).filter(Boolean).join(', ') +
            `. Cruce ${fmtMin((tStart||0) - nowMs)}.`
          : `Cruce planificado del área ${fmtMin((tStart||0) - nowMs)}.`;
        threats.push({
          urgency: urg,
          severity: urg === 'now' ? 'danger' : 'warn',
          category: 'tsaConflict',
          label, detail,
          subtext: tStart ? _fmtTime(tStart) + 'Z' : '',
        });
      });
    }

    // 4) Fuel BINGO/JOKER — solo en TRANSICION (latch).
    if (Array.isArray(rows) && rows.length) {
      const cur = rows[Math.min(session.currentIdx | 0, rows.length - 1)];
      const status = (cur && cur.fuelStatus) || 'ok';
      if (status !== _lastFuelStatusShown) {
        if (status === 'bingo') {
          threats.push({
            urgency: 'now', severity: 'danger', category: 'fuel',
            label: '⛽ BINGO alcanzado',
            detail: 'Combustible restante igual o inferior al BINGO configurado. Diversión imminente — considera diversión o RTB.',
            subtext: '',
          });
        } else if (status === 'joker') {
          threats.push({
            urgency: 'high', severity: 'warn', category: 'fuel',
            label: '⛽ JOKER alcanzado',
            detail: 'Combustible restante igual o inferior al JOKER configurado. Revisa opciones de diversión.',
            subtext: '',
          });
        }
        _lastFuelStatusShown = status;
      }
    }

    // 5) Viento antiguo (umbral 45 min).
    if (session.refetched && Number.isFinite(session.refetched.fetchedAt)) {
      const ageMin = Math.floor((nowMs - session.refetched.fetchedAt) / 60000);
      if (ageMin >= 45) {
        threats.push({
          urgency: 'med', severity: 'warn', category: 'wind',
          label: '⌛ Viento refetched hace ' + ageMin + ' min',
          detail: 'GS y consumo del log usan datos meteo antiguos. Pulsa "Refresh viento" para reanalizar.',
          subtext: '',
        });
      }
    }

    // Sort por [urgency, severity, category].
    threats.sort((a, b) => {
      const du = (orderUrgency[a.urgency] || 9) - (orderUrgency[b.urgency] || 9);
      if (du) return du;
      const ds = (orderSeverity[a.severity] || 9) - (orderSeverity[b.severity] || 9);
      if (ds) return ds;
      return (orderCategory[a.category] || 9) - (orderCategory[b.category] || 9);
    });

    // Bucketing: attend (urg <= med && severity !== info) vs monitor.
    const attendList  = [];
    const monitorList = [];
    threats.forEach(t => {
      const isAttend = (orderUrgency[t.urgency] <= orderUrgency.med) && t.severity !== 'info';
      (isAttend ? attendList : monitorList).push(t);
    });

    // Render attend.
    if (!attendList.length) {
      ul.innerHTML = '<li class="dim">Sin amenazas que requieran atención.</li>';
    } else {
      attendList.forEach(t => {
        const li = document.createElement('li');
        li.className = 'live-threat live-threat-' + t.urgency;
        li.setAttribute('data-cat', t.category);
        const subtext = t.subtext ? '<span class="live-threat-sub dim"> · ' + t.subtext + '</span>' : '';
        li.innerHTML = '<span class="live-threat-label"><b>' + t.label + '</b>' + subtext + '</span>';
        if (t.detail) li.title = t.detail;
        ul.appendChild(li);
      });
    }

    // Render monitor.
    if (ulMon) {
      monitorList.forEach(t => {
        const li = document.createElement('li');
        li.className = 'live-threat live-threat-' + t.urgency;
        li.setAttribute('data-cat', t.category);
        const subtext = t.subtext ? '<span class="live-threat-sub dim"> · ' + t.subtext + '</span>' : '';
        li.innerHTML = '<span class="live-threat-label"><b>' + t.label + '</b>' + subtext + '</span>';
        if (t.detail) li.title = t.detail;
        ulMon.appendChild(li);
      });
    }

    // Badges.
    if (badgeAttend) {
      badgeAttend.textContent = attendList.length + ' atender';
      badgeAttend.classList.toggle('is-empty', attendList.length === 0);
    }
    if (badgeMonitor) {
      badgeMonitor.textContent = monitorList.length + ' monitorizar';
    }
    if (wrapMon) {
      wrapMon.hidden = monitorList.length === 0;
      if (cntMon) cntMon.textContent = String(monitorList.length);
    }
  }

  // Workflow live-threats-cleanup: render del recuadro ISA del WP/leg
  // actual. Sustituye los multiples chips ISA por-WP y el bullet de
  // _renderEval. Usa: geom.isaTempC + geom.densityAltitudeFt +
  // meteoApi.lookupWindAt + session.calibration / refetched.legOat.
  function _renderIsaBox() {
    const box = document.getElementById('live-isa-box');
    if (!box) return;
    if (!session || !Array.isArray(session.coords) || !session.coords.length) {
      box.hidden = true; return;
    }
    const geom = window.TSAgestor && window.TSAgestor.geom;
    if (!geom || typeof geom.isaTempC !== 'function' ||
        typeof geom.densityAltitudeFt !== 'function') {
      box.hidden = true; return;
    }
    const idx = session.currentIdx | 0;
    const legIdx = Math.min(idx + 1, session.coords.length - 1);
    const fl = (session.coords[legIdx] && Number.isFinite(session.coords[legIdx].fl))
             ? session.coords[legIdx].fl : 100;
    const wpName = (session.coords[legIdx] && session.coords[legIdx].name) || ('#' + (legIdx + 1));
    const altFt = fl * 100;
    const isaC  = geom.isaTempC(altFt);
    const daIsa = geom.densityAltitudeFt(altFt, isaC);

    // OAT real: cal radio > re-lookup ETA en windsHourly > refetched cache
    let oatActual = null, src = 'sin datos';
    if (session.calibration && Number.isFinite(session.calibration.oatDeltaC)) {
      oatActual = isaC + session.calibration.oatDeltaC;
      src = '📡 cal radio';
    } else if (session.windsHourly && Array.isArray(session.windsHourly)) {
      const startIdx = session.windsHourlyStartIdx | 0;
      const ph = session.windsHourly[legIdx - startIdx];
      const etaMs = (session.plannedEtas && session.plannedEtas[legIdx]) || Date.now();
      const meteoApi = window.TSAgestor && window.TSAgestor.meteoApi;
      if (ph && meteoApi && typeof meteoApi.lookupWindAt === 'function') {
        try {
          const w = meteoApi.lookupWindAt(ph, new Date(etaMs), fl);
          if (w && Number.isFinite(w.temperatureC)) {
            oatActual = w.temperatureC;
            src = 'modelo (re-lookup ETA)';
          }
        } catch (_) {}
      }
    }
    if (oatActual == null && session.refetched && Array.isArray(session.refetched.legOat)) {
      const startIdx = session.refetched.startIdx | 0;
      const o = session.refetched.legOat[legIdx - startIdx];
      if (Number.isFinite(o)) { oatActual = o; src = 'modelo (refetch)'; }
    }

    const flEl   = document.getElementById('live-isa-fl');
    const expEl  = document.getElementById('live-isa-oat-expected');
    const oatEl  = document.getElementById('live-isa-oat-actual');
    const srcEl  = document.getElementById('live-isa-oat-src');
    const dEl    = document.getElementById('live-isa-delta');
    const bEl    = document.getElementById('live-isa-badge');
    const daEl   = document.getElementById('live-isa-da');
    const dDelta = document.getElementById('live-isa-da-delta');
    const foot   = document.getElementById('live-isa-foot');

    if (flEl)  flEl.textContent = 'FL' + String(fl).padStart(3, '0') + ' · ' + wpName;
    if (expEl) expEl.textContent = (isaC >= 0 ? '+' : '') + Math.round(isaC) + '°C';

    if (oatActual == null) {
      if (oatEl)  oatEl.textContent = '—';
      if (srcEl)  srcEl.textContent = _refetchInFlight ? 'actualizando…' : src;
      if (dEl)    { dEl.textContent = '—'; dEl.className = 'live-isa-delta'; }
      if (bEl)    { bEl.textContent = 'N/A'; bEl.dataset.level = 'ok'; }
      if (daEl)   daEl.textContent = Math.round(daIsa).toLocaleString() + ' ft';
      if (dDelta) dDelta.textContent = '(ISA)';
      box.dataset.level = 'ok';
      if (foot)   foot.textContent = 'Sin OAT refetched. Pulsa ⟳ Refresh viento.';
      box.hidden = false;
      return;
    }

    const dT   = oatActual - isaC;
    const absD = Math.abs(dT);
    const da   = geom.densityAltitudeFt(altFt, oatActual);
    const daDelta = da - daIsa;

    if (oatEl) oatEl.textContent = (oatActual >= 0 ? '+' : '') + Math.round(oatActual) + '°C';
    if (srcEl) srcEl.textContent = src;
    const sign = dT >= 0 ? '+' : '';
    if (dEl) {
      dEl.textContent = sign + dT.toFixed(1) + '°C';
      dEl.className = 'live-isa-delta ' +
        (dT > 0.5 ? 'is-warm' : dT < -0.5 ? 'is-cold' : '');
      if (absD > 8) { dEl.classList.add('is-hot'); dEl.classList.remove('is-warm'); }
    }
    let lvl = 'ok', label = 'ISA';
    if (absD > 8)      { lvl = 'bad';  label = 'DEV ' + sign + Math.round(dT); }
    else if (absD > 3) { lvl = 'warn'; label = 'Δ' + sign + Math.round(dT); }
    if (bEl)  { bEl.dataset.level = lvl; bEl.textContent = label; }
    box.dataset.level = lvl;
    if (daEl) daEl.textContent = Math.round(da).toLocaleString() + ' ft';
    const daSign = daDelta >= 0 ? '+' : '';
    if (dDelta) dDelta.textContent = '(' + daSign + Math.round(daDelta).toLocaleString() + ' ft vs ISA)';

    if (foot) {
      if (lvl === 'bad') {
        foot.textContent = '⚠ Desviación fuerte: revisa TAS/consumo del leg en el log.';
      } else if (lvl === 'warn') {
        foot.textContent = 'Atmósfera ' + (dT > 0 ? 'más cálida' : 'más fría') +
                           ' que ISA — TAS/DA ya ajustados en el plan.';
      } else {
        foot.textContent = 'Atmósfera estándar ±3°C. Plan calibrado.';
      }
    }
    box.hidden = false;
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

    // Workflow live-threats-cleanup: ISA dev YA NO se renderiza aqui.
    // El recuadro #live-isa-box (Estado actual) es la fuente unica de
    // la lente ISA en runtime. session.refetched.isaDeviations sigue
    // poblandose para AAR/timeline/export (buildFlownSnapshot).

    // Workflow live-threats-cleanup: F2.6 (TSAs activas) y F2.5
    // (SIGMETs) YA NO se renderizan aqui — son redundantes con el
    // panel Amenazas refactorizado (dedup por id + bucketing
    // attend/monitor + ordenacion por urgencia). _activeTSAcrossings
    // y _sigmetCrossings siguen poblandose; el render unificado vive
    // en _renderThreats(rows).

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
    // Test report: si hay un toast wp-alert abierto para este target,
    // leer y aplicar los inputs (IAS / flow / FL / fuel) ANTES de
    // dismissar. Antes el operador editaba la IAS en el toast pero al
    // pulsar "Estoy en proximo WP" (en lugar del boton Confirmar del
    // toast) los inputs se perdian y se aplicaba el IAS del plan.
    // Ambos botones (advance externo + Confirmar interno) ahora
    // tienen el mismo comportamiento si el toast esta abierto.
    try {
      const openToast = document.querySelector('.live-toast[data-toast-id="wp-alert"]');
      if (openToast) {
        const toastIdx = parseInt(openToast.dataset.targetIdx, 10);
        // Workflow live-overrides-marker-diagnose bug 1: guard relajado.
        // Antes era toastIdx === next (estricto). Tras _refetchWinds
        // que muta coords[] (anyade/quita sub-WPs por cambio FL/IAS),
        // los indices se desplazan: targetIdx viejo puede no coincidir
        // exactamente con el next recien computado, aunque ambos se
        // refieran al MISMO WP semantico que el operador edito.
        // Acepta cualquier toastIdx en el rango [currentIdx+1, next]
        // (todos los WPs que se confirman con este advance). Tambien
        // acepta si toastIdx == next o == coords[next].name match.
        const inRange = Number.isFinite(toastIdx) &&
                        toastIdx > session.currentIdx &&
                        toastIdx <= next;
        if (inRange) {
          const iasEl  = document.getElementById('live-alert-ias');
          const flowEl = document.getElementById('live-alert-flow');
          const flEl   = document.getElementById('live-alert-fl');
          const fuelEl = document.getElementById('live-alert-fuel');
          const ias  = iasEl  ? parseFloat(iasEl.value)  : NaN;
          const flow = flowEl ? parseFloat(flowEl.value) : NaN;
          const fl   = flEl   ? parseFloat(flEl.value)   : NaN;
          const fuel = fuelEl ? parseFloat(fuelEl.value) : NaN;
          // Per-WP override maps: aplica al WP "next" (al que se acaba
          // de mover), no al targetIdx desfasado. Asi el rango edicion
          // del toast cae siempre en el WP correcto post-refetch.
          // Workflow override-prior-wp-loss: compara contra los valores
          // del prefill (mismos que _showWpAlert metio en los inputs).
          // Sin tocar nada el toast -> ias === pref.ias -> NO escribe.
          session.iasOverrides  = session.iasOverrides  || {};
          session.flowOverrides = session.flowOverrides || {};
          session.flOverrides   = session.flOverrides   || {};
          const pref = _prefillsForWp(next);
          if (Number.isFinite(ias) && ias > 0 && ias !== pref.ias) {
            session.iasOverrides[next] = ias;
          }
          if (Number.isFinite(flow) && flow >= 0 && flow !== pref.flow) {
            session.flowOverrides[next] = flow;
          }
          if (Number.isFinite(fl) && fl > 0 && fl !== pref.fl) {
            session.flOverrides[next] = fl;
          }
          if (Number.isFinite(fuel)) {
            session.fuelOverrides[next] = Math.max(0, fuel);
          }
        } else if (Number.isFinite(toastIdx)) {
          console.warn('[livePlan] advance: toast targetIdx', toastIdx,
                       'fuera de rango (currentIdx+1=' + (session.currentIdx + 1) +
                       ', next=' + next + ') — inputs del toast descartados.');
        }
      }
    } catch (_) {}
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
    // OLA2 cleanup 4: bumpea el epoch para invalidar cualquier
    // _refetchWinds en vuelo. El refetch fue lanzado con startIdx
    // antiguo, y aplicar sus legTimes/winds a la session post-advance
    // las metia en indices desfasados (la ETA del WP siguiente
    // referencia un leg que ahora es "el actual"). El propio _advance
    // dispara _refetchWinds despues con startIdx actualizado.
    _sessionEpoch++;
    _logEvent('advance', {
      toIdx: next,
      name: session.coords[next] && session.coords[next].name,
    });
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
    // OLA2 cleanup 3: si hay overrides cuyo fromIdx > currentIdx nuevo,
    // los descartamos — fueron metidos cuando el operador estaba mas
    // adelante y el rango ya no aplica al estado actual.
    if (session.overrides && Number.isFinite(session.overrides.fromIdx) &&
        session.overrides.fromIdx > session.currentIdx + 1) {
      session.overrides = null;
    }
    // Per-WP maps: limpiar entradas con idx > currentIdx (eran del
    // futuro al que el operador ya no piensa ir desde aqui).
    ['iasOverrides', 'flowOverrides', 'flOverrides'].forEach(mapKey => {
      const m = session[mapKey];
      if (!m) return;
      Object.keys(m).forEach(k => {
        const ki = parseInt(k, 10);
        if (Number.isFinite(ki) && ki > session.currentIdx) {
          delete m[ki];
        }
      });
    });
    // OLA2 cleanup 3: refetched.startIdx puede haber quedado por
    // delante de currentIdx — los legTimes/winds son aun validos para
    // legs >= startIdx, pero las ETAs intermedias asumian timing
    // distinto. Invalidamos para que el proximo _refetchWinds reescriba
    // con el nuevo currentIdx; mientras tanto el log cae al lp.gs
    // cacheado (mejor que mostrar ETAs derivadas de timing antiguo).
    if (session.refetched && Number.isFinite(session.refetched.startIdx) &&
        session.refetched.startIdx > session.currentIdx) {
      session.refetched = null;
    }
    // OLA2 cleanup 4: bumpea epoch — mismo motivo que _advance.
    _sessionEpoch++;
    _logEvent('back', {
      toIdx: session.currentIdx,
      name: session.coords[session.currentIdx] && session.coords[session.currentIdx].name,
    });
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
    _logEvent('hold', {
      idx, mins: n, totalMins: session.liveHolds[idx],
      name: session.coords[idx] && session.coords[idx].name,
    });
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
      iasOverrides:  Object.assign({}, session.iasOverrides  || {}),
      flowOverrides: Object.assign({}, session.flowOverrides || {}),
      flOverrides:   Object.assign({}, session.flOverrides   || {}),
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

    // Parámetros del retorno: per-WP override en el currentIdx (lookup
    // en maps post-refactor v266); si no hay, fallback al plan inicial.
    const effIasRtbBuild  = _effOverride(session.currentIdx, 'ias');
    const effFlowRtbBuild = _effOverride(session.currentIdx, 'flow');
    const ias  = (effIasRtbBuild  != null) ? effIasRtbBuild  : (_planIasFromPlan() || 120);
    const flow = (effFlowRtbBuild != null) ? effFlowRtbBuild : session.fuelOpts.fuelFlow;

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
    _logEvent('rtb-engage', {
      returnLegs: returnCoords.length - 1,
      distNM: cumNm,
      initialFuelAtEngage: initialFuel,
    });
    // OLA4: transicion critica -> push inmediato.
    try {
      const ls = window.TSAgestor && window.TSAgestor.liveSync;
      if (ls && typeof ls.pushNow === 'function') ls.pushNow({ reason: 'rtb' });
    } catch (_) {}
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
    session.iasOverrides    = snap.iasOverrides  || {};
    session.flowOverrides   = snap.flowOverrides || {};
    session.flOverrides     = snap.flOverrides   || {};
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
    _logEvent('rtb-cancel', null);
    // OLA4: push inmediato.
    try {
      const ls = window.TSAgestor && window.TSAgestor.liveSync;
      if (ls && typeof ls.pushNow === 'function') ls.pushNow({ reason: 'rtb' });
    } catch (_) {}
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
  // Test report: panel "AJUSTES EN VUELO" debe escribir en las per-WP
  // maps (iasOverrides/flowOverrides/flOverrides) — el legacy
  // session.overrides single-range quedaba IGNORADO porque
  // _effOverride prioriza las maps. Si el toast wp-alert habia
  // poblado las maps, las escrituras del panel no tenian efecto.
  //
  // Semantica del panel: "aplica a partir del proximo WP". Se
  // implementa con:
  //   (a) iasOverrides[fromIdx] = ias (entry nueva en fromIdx)
  //   (b) Borrar entries posteriores (k > fromIdx) para que el nuevo
  //       override aplique a TODOS los WPs futuros, sobreescribiendo
  //       overrides que el toast hubiera puesto en WPs adelantados
  //       respecto al currentIdx.
  //   (c) Limpiar session.overrides legacy para evitar fuentes duales.
  function _applyOverrides() {
    if (!session) return;
    const ias  = parseFloat(document.getElementById('live-override-ias').value);
    const flow = parseFloat(document.getElementById('live-override-flow').value);
    const fl   = parseFloat(document.getElementById('live-override-fl').value);
    const fromIdx = Math.min(session.currentIdx + 1, session.coords.length - 1);

    session.iasOverrides  = session.iasOverrides  || {};
    session.flowOverrides = session.flowOverrides || {};
    session.flOverrides   = session.flOverrides   || {};

    function applyKey(map, key, val, valid) {
      if (!valid) return;
      // Borra entradas posteriores que harian shadow del nuevo override.
      Object.keys(map).forEach(k => {
        const ki = parseInt(k, 10);
        if (Number.isFinite(ki) && ki > fromIdx) delete map[ki];
      });
      // Pone la nueva entry en fromIdx.
      map[fromIdx] = val;
    }
    applyKey(session.iasOverrides,  'ias',  ias,  Number.isFinite(ias)  && ias  > 0);
    applyKey(session.flowOverrides, 'flow', flow, Number.isFinite(flow) && flow >= 0);
    applyKey(session.flOverrides,   'fl',   fl,   Number.isFinite(fl)   && fl   > 0);

    // Limpiar session.overrides legacy (single-range) para evitar
    // fuente dual con las maps.
    session.overrides = null;

    _logEvent('override-apply-panel', {
      fromIdx,
      ias:  Number.isFinite(ias)  && ias  > 0  ? ias  : null,
      flow: Number.isFinite(flow) && flow >= 0 ? flow : null,
      fl:   Number.isFinite(fl)   && fl   > 0  ? fl   : null,
    });
    _saveSession();
    _refresh();
  }
  function _clearOverrides() {
    if (!session) return;
    _logEvent('override-clear', null);
    // Limpia las per-WP maps (entradas con idx > currentIdx) y el
    // legacy. Conserva entries en WPs ya pasados (semantica
    // historica).
    ['iasOverrides', 'flowOverrides', 'flOverrides'].forEach(mapKey => {
      const m = session[mapKey];
      if (!m) return;
      Object.keys(m).forEach(k => {
        const ki = parseInt(k, 10);
        if (Number.isFinite(ki) && ki > session.currentIdx) delete m[ki];
      });
    });
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
      // OLA4: resetea sessionId remoto (nuevo plan -> nueva session
      // logica en el backend, con sessionId distinto).
      try {
        const ls = window.TSAgestor && window.TSAgestor.liveSync;
        if (ls && typeof ls.resetSessionId === 'function') ls.resetSessionId();
      } catch (_) {}
    },
    // OLA4: snapshot defensivo de la session actual (FIX-8).
    // liveSync usa esto como UNICO punto de lectura. structuredClone
    // si esta disponible (mas robusto), fallback JSON.parse(stringify).
    getSessionSnapshot: () => {
      if (!session) return null;
      try {
        if (typeof structuredClone === 'function') return structuredClone(session);
      } catch (_) {}
      try {
        return JSON.parse(JSON.stringify(session));
      } catch (e) {
        console.warn('[livePlan] getSessionSnapshot fallo:', e && e.message);
        return null;
      }
    },
    // F1.5 Dispatch metrics: aggregado para que liveSync._buildBody
    // pueda enviar en meta los valores que el operador en cabina ve
    // ahora mismo — fuel restante, ETA al proximo WP, ETA a destino
    // (RTB). Reutiliza _recalc() para evitar duplicar logica de
    // legtime + fuel propagation.
    getLiveMetrics: () => {
      if (!session) return null;
      try {
        const rows = _recalc();
        if (!Array.isArray(rows) || !rows.length) return null;
        const ci = session.currentIdx | 0;
        // Fuel restante = fuelRest del row currentIdx (ya incluye
        // overrides + propagation).
        const fuelRest = (rows[ci] && Number.isFinite(rows[ci].fuelRest))
          ? rows[ci].fuelRest
          : null;
        // Proximo WP real (salta sub-legs).
        let nextIdx = null;
        for (let i = ci + 1; i < rows.length; i++) {
          if (!rows[i].isSub) { nextIdx = i; break; }
        }
        const etaNextWp = (nextIdx != null && Number.isFinite(rows[nextIdx].liveEta))
          ? rows[nextIdx].liveEta
          : null;
        const nextWpName = (nextIdx != null) ? rows[nextIdx].name : null;
        // ETA destino = liveEta del ultimo WP.
        const lastIdx = rows.length - 1;
        const etaDestination = (Number.isFinite(rows[lastIdx].liveEta))
          ? rows[lastIdx].liveEta
          : null;
        return {
          fuelRest,
          fuelStatus:    rows[ci] && rows[ci].fuelStatus,
          fuelUnit:      session.fuelOpts && session.fuelOpts.unit,
          etaNextWp,
          nextWpName,
          etaDestination,
          destination:   rows[lastIdx].name,
        };
      } catch (e) {
        console.warn('[livePlan] getLiveMetrics fallo:', e && e.message);
        return null;
      }
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
