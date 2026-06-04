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

  const STORAGE_KEY = 'tsagestor_live_session';

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

  function init() {
    if (!_wired) {
      _wireUI();
      _wired = true;
    }
    _startClock();
    _loadSession();
    _maybeShowContent();
  }

  // ── Inicializacion de sesion a partir del plan calculado ───────────
  function _buildSessionFromPlan(force) {
    const plan = _getPlan();
    if (!plan || !plan.coords || plan.coords.length < 2) return null;

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

    session = {
      planId,
      coords: coordsAll,
      plannedEtas,
      plannedFuelRest,
      legPlan,
      fuelOpts: {
        initialFuel:     Number(fuelOpts.initialFuel)     || 0,
        fuelFlow:        Number(fuelOpts.fuelFlow)        || 0,
        joker:           Number.isFinite(fuelOpts.joker)  ? fuelOpts.joker : null,
        bingo:           Number.isFinite(fuelOpts.bingo)  ? fuelOpts.bingo : null,
        unit:            fuelOpts.unit || 'lb',
        defaultSpeedKt:  Number.isFinite(fuelOpts.defaultSpeedKt) ? fuelOpts.defaultSpeedKt : null,
      },
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
    _saveSession();
    return session;
  }

  function _hashPlan(plan) {
    const sig = plan.coords.map(c => `${c.name}@${c.fl}`).join(',') +
                '|' + (plan.departureUTC || '') +
                '|' + ((plan.fuelOpts && plan.fuelOpts.defaultSpeedKt) || '') +
                '|' + ((plan.fuelOpts && plan.fuelOpts.fuelFlow) || '');
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
      if (raw) session = JSON.parse(raw);
    } catch (_) { session = null; }
  }
  function _saveSession() {
    if (!session) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch (_) {}
  }
  function _clearSession() {
    session = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
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
    // Aplica overrides de IAS (escala por TAS / GS estimado)
    const ov = session.overrides;
    if (ov && Number.isFinite(ov.ias) && ov.ias > 0 && ov.fromIdx != null && ov.fromIdx <= idx) {
      const planIas = lp.ias || _planIasFromPlan() || 120;
      timeMin = timeMin * (planIas / ov.ias);
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
  function _recalc() {
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
          // Suma leg times de knownIdx+1 hasta i
          let t = session.actualPassTimes[knownIdx];
          for (let k = knownIdx + 1; k <= i; k++) {
            t += _legTimeMinAt(k) * 60000;
            // Holds vivos en k (excluyendo el knownIdx ya pasado)
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
        tas:  lp ? lp.tas : null,
        gs:   lp ? lp.gs  : null,
        wind: lp ? lp.wind : null,
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
    if (baseIdx >= 0) {
      rest = Number(overrides[baseIdx]);
    } else {
      // Empieza desde initialFuel en idx 0
      rest = session.fuelOpts.initialFuel || 0;
      baseIdx = 0;
    }
    const flowOv = session.overrides;
    for (let k = baseIdx + 1; k <= i; k++) {
      const lp = session.legPlan[k];
      let legFuel = lp ? lp.legFuel : 0;
      // Si hay override de flow que aplica a este leg, recalcula
      if (flowOv && Number.isFinite(flowOv.flow) && flowOv.flow >= 0 &&
          flowOv.fromIdx != null && flowOv.fromIdx <= k) {
        const planFlow = lp ? lp.flow : 0;
        if (planFlow > 0) legFuel = legFuel * (flowOv.flow / planFlow);
      }
      // Holds vivos en este k anyaden tiempo y por tanto combustible
      const holdMin = Number(session.liveHolds[k]) || 0;
      if (holdMin > 0) {
        const holdFlow = (flowOv && Number.isFinite(flowOv.flow) && flowOv.fromIdx != null && flowOv.fromIdx <= k)
          ? flowOv.flow : (lp ? lp.flow : session.fuelOpts.fuelFlow);
        legFuel += (holdMin / 60) * holdFlow;
      }
      rest -= legFuel;
    }
    return rest;
  }

  // ── Vuelta a base (RTB) ────────────────────────────────────────────
  function _evalRTB() {
    if (!session) return null;
    const curr = session.currentIdx;
    if (curr <= 0) return { distanceNM: 0, minutes: 0, fuelNeeded: 0, ok: true };
    const coords = session.coords;
    let distKM = 0;
    for (let k = 1; k <= curr; k++) {
      const A = coords[k - 1], B = coords[k];
      distKM += _greatCircleKM(A.lat, A.lon, B.lat, B.lon);
    }
    const distNM = distKM / 1.852;
    const ov = session.overrides;
    const ias = (ov && Number.isFinite(ov.ias)) ? ov.ias : (_planIasFromPlan() || 120);
    const gs = ias;
    const hours = distNM / Math.max(gs, 30);
    const minutes = hours * 60;
    const flow = (ov && Number.isFinite(ov.flow)) ? ov.flow : session.fuelOpts.fuelFlow;
    const fuelNeeded = hours * flow;
    const rows = _recalc();
    const currentRow = rows[curr];
    const fuelNow = currentRow ? currentRow.fuelRest : 0;
    const bingo = session.fuelOpts.bingo || 0;
    const fuelAfterRtb = fuelNow - fuelNeeded;
    const ok = fuelAfterRtb >= bingo;
    return { distanceNM: distNM, minutes, fuelNeeded, fuelNow, fuelAfterRtb, bingo, ok };
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
  // los tiempos de leg con el viento nuevo. Sin red -> ignorado.
  async function _refetchWinds() {
    if (!session || !session.started) return;
    if (_refetchInFlight) return;
    const startIdx = session.currentIdx;
    if (startIdx >= session.coords.length - 1) return;
    const meteo = window.TSAgestor && window.TSAgestor.meteoApi;
    if (!meteo || !meteo.fetchWindsAloft || !meteo.lookupWindAt) return;

    const remaining = session.coords.slice(startIdx);
    const points = remaining.map(c => ({ lat: c.lat, lon: c.lon }));
    _refetchInFlight = true;
    try {
      const result = await meteo.fetchWindsAloft(points);
      const ph = result && result.pointsHourly;
      if (!ph || !ph.length) { _refetchInFlight = false; return; }
      // Para cada leg de startIdx+1..N, computa nuevo legTimeMin usando
      // el viento al FL del waypoint final del leg.
      const legTimes = [0]; // padding para que legTimes[k - startIdx] sea el de leg k
      let etaMs = session.actualPassTimes[startIdx] || session.proposedStartTime || Date.now();
      for (let k = startIdx + 1; k < session.coords.length; k++) {
        const localIdx = k - startIdx;
        const phPrev = ph[localIdx - 1];
        const phCurr = ph[localIdx];
        const lp = session.legPlan[k];
        const fl = session.coords[k].fl || 100;
        let legTimeMin = lp ? lp.legTimeMin : 0;
        if (lp && Number.isFinite(lp.tas) && Number.isFinite(lp.legNM) && lp.legNM > 0) {
          const wB = phCurr ? meteo.lookupWindAt(phCurr, etaMs, fl) : null;
          if (wB && Number.isFinite(wB.windSpeedKt) && Number.isFinite(wB.windDir)) {
            // headwind = -windSpeed * cos(windDir - track). Sin track
            // facil, asumimos peor caso direccional con cos=cos((dir - bearing)).
            // Para simplificar usamos el bearing del leg.
            const bearing = _bearingDeg(session.coords[k - 1], session.coords[k]);
            const hw = -wB.windSpeedKt * Math.cos((wB.windDir - bearing) * Math.PI / 180);
            const gs = Math.max(30, lp.tas + hw);
            legTimeMin = (lp.legNM / gs) * 60;
          }
        }
        legTimes[localIdx] = legTimeMin;
        etaMs += legTimeMin * 60000;
      }
      session.refetched = { startIdx, legTimes };
      _saveSession();
      _refresh();
    } catch (e) {
      console.warn('[livePlan] refetch winds fallo:', e && e.message ? e.message : e);
    } finally {
      _refetchInFlight = false;
    }
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
    });
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
    const d = new Date();
    const txt = String(d.getUTCHours()).padStart(2, '0') + ':' +
                String(d.getUTCMinutes()).padStart(2, '0') + ':' +
                String(d.getUTCSeconds()).padStart(2, '0');
    // Hay dos relojes en la UI (preflight + en-vuelo).
    const a = document.getElementById('live-clock-utc');
    const b = document.getElementById('live-clock-utc-2');
    if (a) a.textContent = txt;
    if (b) b.textContent = txt;
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
      _refresh();
    } else {
      preflight.classList.add('hidden');
      content.classList.remove('hidden');
      if (tableWrap) tableWrap.classList.remove('hidden');
      _refresh();
    }
  }

  function _refresh() {
    if (!session) return;
    const rows = _recalc();
    _renderStatus(rows);
    _renderTable(rows);
    _renderEval(rows);
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
    // Refetch inmediato para tener vientos frescos al arrancar
    _refetchWinds();
    _maybeShowContent();
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

  function _renderStatus(rows) {
    const $ = id => document.getElementById(id);
    if (!session) return;
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
  }

  // ── Render: tabla log live ─────────────────────────────────────────
  function _renderTable(rows) {
    const tbody = document.querySelector('#live-log-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.className = (r.isCurrent ? 'live-row-current'
                   : r.isPast    ? 'live-row-past'
                                 : 'live-row-future') +
                   (r.isSub ? ' live-row-sub' : '');
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
      const fuelCell = `<td><input type="number" class="${fuelInputCls}" data-idx="${r.i}" value="${Number.isFinite(r.fuelRest) ? Math.round(r.fuelRest) : ''}" step="10" title="Combustible restante en este WP (editable)"></td>`;
      tr.innerHTML =
        `<td>${r.i + 1}</td>` +
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
      li.textContent = `${rtb.ok ? '✓' : '⚠'} RTB: ${rtb.distanceNM.toFixed(0)} NM · ${Math.round(rtb.minutes)} min · necesita ${_fmtFuel(rtb.fuelNeeded)} (margen sobre BINGO: ${_fmtFuel(rtb.fuelAfterRtb - rtb.bingo)})`;
      ul.appendChild(li);
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
    if (session.currentIdx >= session.coords.length - 1) return;
    session.currentIdx++;
    session.actualPassTimes[session.currentIdx] = Date.now();
    _saveSession();
    _refresh();
    // Refetch viento para el resto del vuelo (async, no bloqueante)
    _refetchWinds();
  }
  function _back() {
    if (!session) return;
    if (session.currentIdx <= 0) return;
    delete session.actualPassTimes[session.currentIdx];
    session.currentIdx--;
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
  function _showRtbInline() {
    if (!session) return;
    const r = _evalRTB();
    if (!r) { alert('No hay datos suficientes para evaluar RTB.'); return; }
    if (r.distanceNM === 0) { alert('Ya estás en origen.'); return; }
    const txt =
      `Vuelta a base desde WP ${session.currentIdx + 1}:\n\n` +
      `Distancia (inversa por waypoints): ${r.distanceNM.toFixed(0)} NM\n` +
      `Tiempo estimado: ${Math.round(r.minutes)} min\n` +
      `Combustible necesario: ${_fmtFuel(r.fuelNeeded)}\n` +
      `Combustible ahora: ${_fmtFuel(r.fuelNow)}\n` +
      `Quedaría al llegar: ${_fmtFuel(r.fuelAfterRtb)}\n` +
      `BINGO: ${_fmtFuel(r.bingo)}\n\n` +
      (r.ok ? '✓ FACTIBLE (margen sobre BINGO).' : '⚠ NO FACTIBLE con BINGO actual.');
    alert(txt);
  }
  function _resetSession() {
    if (!confirm('Resetear la sesión live al estado inicial? Se pierden todos los pasos, holds, overrides y correcciones de combustible.')) return;
    _clearSession();
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
    session.fuelOverrides[idx] = newRemaining;
    _saveSession();
    _refresh();
  }

  return {
    init,
    onTabOpen: _maybeShowContent,
    refresh: _refresh,
  };
})();
