// Modo Live: sigue un plan calculado durante el vuelo. El operador
// marca el paso por cada waypoint con "Estoy en proximo WP"; la app
// lee el reloj UTC y recalcula ETAs y combustible restante para los
// waypoints futuros. Permite anadir holds en vivo, modificar IAS /
// Flow / FL para los tramos restantes, y evaluar la vuelta a base.
//
// Estado en window.TSAgestor.livePlan.session, persistido en
// localStorage bajo la clave tsagestor_live_session.
//
// Dependencias:
//   - window.TSAgestor.app.getLastPlan() devuelve state.lastPlan
//     (la app lo expone via TSAgestor.app cuando hay plan calculado).

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.livePlan = (function () {
  'use strict';

  const STORAGE_KEY = 'tsagestor_live_session';

  // Estado de la sesion live. null = sin sesion activa.
  // {
  //   planId: hash basico del plan (para detectar cambios)
  //   coords: [{name, lat, lon, fl, originalIdx}]   // solo WPs reales
  //   plannedEtas: [msUTC]                          // ETA planificada por WP
  //   plannedFuelRest: [number]                     // combustible restante planificado por WP
  //   currentIdx: number                            // WP actual (0 = origen)
  //   actualPassTimes: { idx: msUTC }               // tiempo REAL de paso por WP
  //   liveHolds: { idx: minutes }                   // holds anadidos en vivo
  //   overrides: { fromIdx, ias|null, flow|null, fl|null } | null
  //   fuelOpts: { initialFuel, fuelFlow, joker, bingo, unit }
  //   totalDistNM: number
  // }
  let session = null;
  let clockInterval = null;
  let _wired = false;

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
  function _startSession(force) {
    const plan = _getPlan();
    if (!plan || !plan.coords || plan.coords.length < 2) return null;

    // Filtra solo waypoints "reales" (sin sub-legs de ascenso/descenso
    // ni holds sinteticos). Estos son los que el operador puede marcar.
    const realIdxMap = [];
    const realCoords = [];
    plan.coords.forEach((c, i) => {
      if (c.isClimbDescentSub || c.isHold) return;
      realIdxMap.push(i);
      realCoords.push({
        name: c.name, lat: c.lat, lon: c.lon,
        fl: Number.isFinite(c.fl) ? c.fl : null,
        originalIdx: i,
      });
    });
    if (realCoords.length < 2) return null;

    // ETA planificada y combustible restante por WP real, leyendo del
    // log de combustible (fuel.legs). Cada fila tiene etaUTC y remaining.
    const plannedEtas = [];
    const plannedFuelRest = [];
    const legs = (plan.fuel && plan.fuel.legs) || [];
    let lastEtaMs = null, lastRemaining = null;
    realIdxMap.forEach((origIdx) => {
      const leg = legs.find(l => l.index === origIdx);
      if (leg) {
        lastEtaMs = leg.etaUTC ? new Date(leg.etaUTC).getTime() : lastEtaMs;
        if (Number.isFinite(leg.remaining)) lastRemaining = leg.remaining;
      }
      plannedEtas.push(lastEtaMs);
      plannedFuelRest.push(lastRemaining);
    });

    // Distancia acumulada total desde el log
    const totalDistNM = legs.reduce((s, l) => s + (Number(l.legDistNM) || 0), 0);

    const planId = _hashPlan(plan);
    const fuelOpts = plan.fuelOpts || {};
    const departureMs = plan.departureUTC ? new Date(plan.departureUTC).getTime()
                                          : (plannedEtas[0] || Date.now());

    const prev = session;
    // Si recargamos con MISMO planId y hay sesion previa, conserva el
    // estado live (paso por WP, holds, overrides) — recovery total.
    const keep = (force !== true) && prev && prev.planId === planId;
    session = {
      planId,
      coords: realCoords,
      plannedEtas,
      plannedFuelRest,
      currentIdx: keep ? prev.currentIdx : 0,
      actualPassTimes: keep ? Object.assign({}, prev.actualPassTimes)
                            : { 0: departureMs },
      liveHolds: keep ? Object.assign({}, prev.liveHolds) : {},
      overrides: keep ? prev.overrides : null,
      fuelOpts: {
        initialFuel: Number(fuelOpts.initialFuel) || 0,
        fuelFlow:    Number(fuelOpts.fuelFlow)    || 0,
        joker:       Number.isFinite(fuelOpts.joker) ? fuelOpts.joker : null,
        bingo:       Number.isFinite(fuelOpts.bingo) ? fuelOpts.bingo : null,
        unit:        fuelOpts.unit || 'lb',
      },
      totalDistNM,
    };
    _saveSession();
    return session;
  }

  function _hashPlan(plan) {
    // Hash basico: coords + departure + IAS + Flow. Si algo cambia, el
    // plan se considera distinto y reseteamos la sesion live.
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

  // ── Recalculo ──────────────────────────────────────────────────────
  // Para cada WP construye:
  //   liveEta: ms UTC reales (paso registrado o estimado desde el ultimo conocido)
  //   delta: liveEta - plannedEta (ms)
  //   fuelRest: combustible restante estimado en ese WP
  //   status: 'past' | 'current' | 'future'; banderas joker / bingo
  function _recalc() {
    if (!session) return [];
    const coords = session.coords;
    const planEtas = session.plannedEtas;
    const planFuel = session.plannedFuelRest;
    const curr = session.currentIdx;
    const ov = session.overrides;

    // Encuentra el ultimo paso registrado <= idx (para extrapolar desde alli)
    function lastKnownLE(idx) {
      for (let k = idx; k >= 0; k--) {
        if (session.actualPassTimes[k] != null) return k;
      }
      return null;
    }

    const rows = [];
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      const planEta = planEtas[i];
      let liveEta;
      const passT = session.actualPassTimes[i];

      if (passT != null) {
        liveEta = passT;
      } else {
        const knownIdx = lastKnownLE(i);
        if (knownIdx == null || planEta == null || planEtas[knownIdx] == null) {
          liveEta = planEta;
        } else {
          const knownActual = session.actualPassTimes[knownIdx];
          const knownPlanned = planEtas[knownIdx];
          const plannedDelta = planEta - knownPlanned;
          // Factor de overrides: si IAS override esta activo y aplica
          // a partir de fromIdx <= i, escalamos el tiempo planificado
          // por (plan_ias / override_ias). Sin plan_ias conocido,
          // sin escala.
          let factor = 1;
          if (ov && Number.isFinite(ov.ias) && ov.ias > 0 && ov.fromIdx != null && ov.fromIdx <= i) {
            const planIas = (session.fuelOpts && session.fuelOpts.defaultSpeedKt) ||
                            _planIasFromPlan() || 120;
            factor = planIas / ov.ias;
          }
          liveEta = knownActual + plannedDelta * factor;
        }
      }

      // Suma holds vivos acumulados desde el ultimo paso registrado
      // hasta WP i (inclusive).
      const knownIdx = lastKnownLE(i);
      let holdMsAfter = 0;
      const fromHoldIdx = knownIdx != null ? knownIdx : 0;
      for (let k = fromHoldIdx; k <= i; k++) {
        const m = Number(session.liveHolds[k]);
        if (Number.isFinite(m) && m > 0) {
          // Si k es el WP origen del ultimo paso conocido (paso ya
          // registrado), el hold AHI ya esta incluido en la realidad.
          // El hold solo desplaza ETAs FUTURAS, asi que cuenta para
          // k > knownIdx o k == i si i > knownIdx.
          if (knownIdx == null || k > knownIdx) holdMsAfter += m * 60000;
        }
      }
      if (passT == null) liveEta += holdMsAfter;

      // Combustible restante: usa el planificado como base, ajusta por
      // overrides de flow.
      let fuelRest = planFuel[i];
      if (ov && Number.isFinite(ov.flow) && ov.flow >= 0 && ov.fromIdx != null && ov.fromIdx <= i) {
        const planFlow = session.fuelOpts.fuelFlow;
        if (planFlow > 0) {
          const planUsed = (session.fuelOpts.initialFuel || 0) - (planFuel[i] || 0);
          const planUsedUpToOverride = (session.fuelOpts.initialFuel || 0) - (planFuel[ov.fromIdx] || 0);
          const planUsedFromOverride = planUsed - planUsedUpToOverride;
          const adjFromOverride = planUsedFromOverride * (ov.flow / planFlow);
          fuelRest = (session.fuelOpts.initialFuel || 0) - (planUsedUpToOverride + adjFromOverride);
        }
      }
      // Resta combustible extra consumido por holds vivos (al flow base)
      const flowForHolds = (ov && Number.isFinite(ov.flow) && ov.fromIdx != null && ov.fromIdx <= i)
        ? ov.flow : session.fuelOpts.fuelFlow;
      let holdFuelExtra = 0;
      for (let k = 0; k <= i; k++) {
        const m = Number(session.liveHolds[k]);
        if (Number.isFinite(m) && m > 0) holdFuelExtra += (m / 60) * flowForHolds;
      }
      fuelRest = (fuelRest || 0) - holdFuelExtra;

      const joker = session.fuelOpts.joker;
      const bingo = session.fuelOpts.bingo;
      let fuelStatus = 'ok';
      if (Number.isFinite(bingo) && fuelRest <= bingo) fuelStatus = 'bingo';
      else if (Number.isFinite(joker) && fuelRest <= joker) fuelStatus = 'joker';

      rows.push({
        i,
        name: c.name,
        fl: c.fl,
        planEta,
        liveEta,
        delta: (planEta != null && liveEta != null) ? (liveEta - planEta) : null,
        fuelRest,
        fuelStatus,
        passReal: passT != null,
        isCurrent: i === curr,
        isPast: i < curr,
        liveHoldMin: Number(session.liveHolds[i]) || 0,
      });
    }
    return rows;
  }

  function _planIasFromPlan() {
    const plan = _getPlan();
    if (!plan || !plan.fuel || !plan.fuel.legs) return null;
    const firstLeg = plan.fuel.legs.find(l => Number.isFinite(l.legIAS));
    return firstLeg ? firstLeg.legIAS : null;
  }

  // ── Vuelta a base (RTB) ────────────────────────────────────────────
  // Calcula tiempo + combustible para volver desde la posicion actual
  // (interpretada como WP currentIdx) hasta el origen (WP 0) siguiendo
  // los waypoints en orden inverso.
  function _evalRTB() {
    if (!session) return null;
    const curr = session.currentIdx;
    if (curr <= 0) return { distanceNM: 0, minutes: 0, fuelNeeded: 0, ok: true };

    // Distancia inversa = suma de distancias entre WPs 0..curr en orden directo
    const coords = session.coords;
    let distKM = 0;
    for (let k = 1; k <= curr; k++) {
      const A = coords[k - 1], B = coords[k];
      distKM += _greatCircleKM(A.lat, A.lon, B.lat, B.lon);
    }
    const distNM = distKM / 1.852;

    // Velocidad para el RTB: usa override IAS si existe, sino plan IAS
    const ov = session.overrides;
    const ias = (ov && Number.isFinite(ov.ias)) ? ov.ias
              : (_planIasFromPlan() || 120);
    // TAS approximation: IAS sin correccion (ISA assumption a media cota).
    // Para RTB es suficiente.
    const gs = ias; // sin viento — peor caso conservador
    const hours = distNM / Math.max(gs, 30);
    const minutes = hours * 60;

    const flow = (ov && Number.isFinite(ov.flow)) ? ov.flow : session.fuelOpts.fuelFlow;
    const fuelNeeded = hours * flow;

    // Combustible disponible AHORA segun el log live
    const rows = _recalc();
    const currentRow = rows[curr];
    const fuelNow = currentRow ? currentRow.fuelRest : 0;
    const bingo = session.fuelOpts.bingo || 0;
    const fuelAfterRtb = fuelNow - fuelNeeded;
    const ok = fuelAfterRtb >= bingo;

    return { distanceNM: distNM, minutes, fuelNeeded, fuelNow, fuelAfterRtb, bingo, ok };
  }

  // Haversine en km
  function _greatCircleKM(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ── UI wire / render ───────────────────────────────────────────────
  function _wireUI() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.id === 'btn-live-advance') { _advance(); return; }
      if (t.id === 'btn-live-back')    { _back(); return; }
      if (t.id === 'btn-live-hold')    { _addHold(); return; }
      if (t.id === 'btn-live-rtb')     { _showRtbInline(); return; }
      if (t.id === 'btn-live-reset')   { _resetSession(); return; }
      if (t.id === 'btn-live-apply-overrides') { _applyOverrides(); return; }
      if (t.id === 'btn-live-clear-overrides') { _clearOverrides(); return; }
    });
  }

  function _startClock() {
    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(_tick, 1000);
    _tick();
  }
  function _tick() {
    const el = document.getElementById('live-clock-utc');
    if (el) {
      const d = new Date();
      el.textContent =
        String(d.getUTCHours()).padStart(2, '0') + ':' +
        String(d.getUTCMinutes()).padStart(2, '0') + ':' +
        String(d.getUTCSeconds()).padStart(2, '0');
    }
  }

  function _maybeShowContent() {
    const noPlan = document.getElementById('live-no-plan');
    const content = document.getElementById('live-content');
    const tableWrap = document.getElementById('live-log-table-wrap');
    if (!noPlan || !content) return;
    const plan = _getPlan();
    if (!plan || !plan.coords || plan.coords.length < 2) {
      noPlan.classList.remove('hidden');
      content.classList.add('hidden');
      if (tableWrap) tableWrap.classList.add('hidden');
      return;
    }
    noPlan.classList.add('hidden');
    content.classList.remove('hidden');
    if (tableWrap) tableWrap.classList.remove('hidden');
    if (!session || session.planId !== _hashPlan(plan)) _startSession();
    _refresh();
  }

  function _refresh() {
    if (!session) return;
    const rows = _recalc();
    _renderStatus(rows);
    _renderTable(rows);
    _renderEval(rows);
  }

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

  function _renderStatus(rows) {
    const curr = session.currentIdx;
    const next = curr < session.coords.length - 1 ? curr + 1 : null;
    const last = session.coords.length - 1;

    const currRow = rows[curr];
    const nextRow = next != null ? rows[next] : null;
    const destRow = rows[last];

    const $ = id => document.getElementById(id);
    if ($('live-current-wp')) {
      const c = session.coords[curr];
      const flTxt = Number.isFinite(c.fl) ? ` · FL${String(c.fl).padStart(3, '0')}` : '';
      $('live-current-wp').textContent = `#${curr + 1} · ${c.name}${flTxt}`;
    }
    if ($('live-current-time')) {
      $('live-current-time').textContent = currRow ? _fmtTime(currRow.liveEta) + ' UTC' : '—';
    }
    if ($('live-next-wp')) {
      $('live-next-wp').textContent = nextRow
        ? `#${next + 1} · ${nextRow.name}`
        : 'Destino alcanzado';
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
      $('live-fuel-remaining').className = currRow && currRow.fuelStatus === 'bingo' ? 'live-fuel-bingo'
                                       : currRow && currRow.fuelStatus === 'joker' ? 'live-fuel-joker' : '';
    }

    // Buttons disabled state
    const advBtn = $('btn-live-advance');
    if (advBtn) advBtn.disabled = (next == null);
    const backBtn = $('btn-live-back');
    if (backBtn) backBtn.disabled = (curr <= 0);
  }

  function _renderTable(rows) {
    const tbody = document.querySelector('#live-log-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.className = r.isCurrent ? 'live-row-current'
                   : r.isPast    ? 'live-row-past'
                                 : 'live-row-future';
      const deltaClass = (r.delta == null) ? ''
                      : (r.delta > 60000)   ? 'live-delta-late'
                      : (r.delta < -60000)  ? 'live-delta-early' : 'live-delta-on';
      const fuelClass = r.fuelStatus === 'bingo' ? 'live-fuel-bingo'
                      : r.fuelStatus === 'joker' ? 'live-fuel-joker' : '';
      const flTxt = Number.isFinite(r.fl) ? `FL${String(r.fl).padStart(3, '0')}` : '—';
      const stateTxt = r.passReal ? 'paso real'
                     : r.isCurrent ? 'actual'
                     : r.isPast    ? 'pasado'
                                   : 'pendiente';
      const holdTxt = r.liveHoldMin > 0 ? ` · hold ${r.liveHoldMin}'` : '';
      tr.innerHTML =
        `<td>${r.i + 1}</td>` +
        `<td><b>${r.name}</b>${holdTxt}</td>` +
        `<td>${flTxt}</td>` +
        `<td>${_fmtTime(r.planEta)}</td>` +
        `<td><b>${_fmtTime(r.liveEta)}</b></td>` +
        `<td class="${deltaClass}">${_fmtDelta(r.delta)}</td>` +
        `<td class="${fuelClass}">${_fmtFuel(r.fuelRest)}</td>` +
        `<td>${stateTxt}</td>`;
      tbody.appendChild(tr);
    });
    const info = document.getElementById('live-log-info');
    if (info && session) {
      const curr = session.currentIdx;
      info.textContent = `WP ${curr + 1} / ${session.coords.length} · ${session.totalDistNM.toFixed(0)} NM total`;
    }
  }

  function _renderEval(rows) {
    const ul = document.getElementById('live-eval-list');
    if (!ul) return;
    ul.innerHTML = '';
    if (!session) return;

    const last = session.coords.length - 1;
    const destRow = rows[last];

    // Eval 1: combustible al destino
    if (destRow && destRow.fuelRest != null) {
      const bingo = session.fuelOpts.bingo;
      const joker = session.fuelOpts.joker;
      let cls = 'ok', txt = '';
      if (Number.isFinite(bingo) && destRow.fuelRest <= bingo) {
        cls = 'bad';
        txt = `⚠ Combustible AL DESTINO ${_fmtFuel(destRow.fuelRest)} ≤ BINGO ${_fmtFuel(bingo)} — abortar`;
      } else if (Number.isFinite(joker) && destRow.fuelRest <= joker) {
        cls = 'warn';
        txt = `⚠ Combustible al destino ${_fmtFuel(destRow.fuelRest)} ≤ JOKER ${_fmtFuel(joker)} — revisar`;
      } else {
        cls = 'ok';
        txt = `✓ Combustible suficiente al destino (${_fmtFuel(destRow.fuelRest)} restantes)`;
      }
      const li = document.createElement('li');
      li.className = 'live-eval-' + cls;
      li.textContent = txt;
      ul.appendChild(li);
    }

    // Eval 2: RTB desde posicion actual
    const rtb = _evalRTB();
    if (rtb && rtb.distanceNM > 0) {
      const li = document.createElement('li');
      li.className = 'live-eval-' + (rtb.ok ? 'ok' : 'bad');
      li.textContent = `${rtb.ok ? '✓' : '⚠'} Vuelta a base: ${rtb.distanceNM.toFixed(0)} NM · ${Math.round(rtb.minutes)} min · necesita ${_fmtFuel(rtb.fuelNeeded)} (margen sobre BINGO: ${_fmtFuel(rtb.fuelAfterRtb - rtb.bingo)})`;
      ul.appendChild(li);
    }

    // Eval 3: retraso acumulado
    if (destRow && destRow.delta != null) {
      const min = Math.round(destRow.delta / 60000);
      if (Math.abs(min) >= 1) {
        const li = document.createElement('li');
        li.className = min > 0 ? 'live-eval-warn' : 'live-eval-ok';
        li.textContent = `${min > 0 ? '⏱' : '✓'} ETA destino ${min > 0 ? min + ' min de retraso' : Math.abs(min) + ' min adelanto'}`;
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
    if (!session) return;
    if (session.currentIdx >= session.coords.length - 1) return;
    session.currentIdx++;
    session.actualPassTimes[session.currentIdx] = Date.now();
    _saveSession();
    _refresh();
  }
  function _back() {
    if (!session) return;
    if (session.currentIdx <= 0) return;
    // Borra el paso real del WP actual y retrocede.
    delete session.actualPassTimes[session.currentIdx];
    session.currentIdx--;
    _saveSession();
    _refresh();
  }
  function _addHold() {
    if (!session) return;
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
      `Quedaria al llegar: ${_fmtFuel(r.fuelAfterRtb)}\n` +
      `BINGO: ${_fmtFuel(r.bingo)}\n\n` +
      (r.ok ? '✓ FACTIBLE (margen sobre BINGO).' : '⚠ NO FACTIBLE con BINGO actual.');
    alert(txt);
  }
  function _resetSession() {
    if (!confirm('Resetear la sesión live al inicio del plan? Se pierden todos los pasos registrados, holds y overrides.')) return;
    _clearSession();
    const plan = _getPlan();
    if (plan) _startSession(true);
    _refresh();
  }
  function _applyOverrides() {
    if (!session) return;
    const ias  = parseFloat(document.getElementById('live-override-ias').value);
    const flow = parseFloat(document.getElementById('live-override-flow').value);
    const fl   = parseFloat(document.getElementById('live-override-fl').value);
    const fromIdx = Math.min(session.currentIdx + 1, session.coords.length - 1);
    session.overrides = {
      fromIdx,
      ias:  Number.isFinite(ias)  && ias  > 0 ? ias  : null,
      flow: Number.isFinite(flow) && flow >= 0 ? flow : null,
      fl:   Number.isFinite(fl)   && fl   > 0 ? fl   : null,
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

  // API publica para b1Layout._moveSection
  return {
    init,
    onTabOpen: _maybeShowContent,
    refresh: _refresh,
  };
})();
