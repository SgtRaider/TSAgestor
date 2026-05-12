// Pestanya NOTAMs — consulta NOTAMs por aerodromo (origen / destino del
// plan o ICAOs introducidos a mano), los clasifica por severidad mirando
// el Q-code y patrones de texto, y los pinta en tres cubetas:
//   1) Showstoppers: aerodromo cerrado, pista cerrada, ILS U/S si IFR...
//   2) Avisos: limitaciones que pueden afectar (TWY cerrada, FUEL, etc).
//   3) Info: el resto.
//
// El Q-code de un NOTAM (linea "Q) FIR/QXXYY/...") es la mejor pista:
//   Q<FIR>/Q<subj 2L><cond 2L>/...
//
// Subjects relevantes:
//   M+R = Movement area > Runway     (pista)
//   M+A = Movement area > Aerodrome  (aerodromo en general)
//   M+T = Movement area > Taxiway    (calle de rodaje)
//   M+D = Movement area > Apron      (plataforma)
//   F+A = Facility > Aerodrome       (servicios del aeropuerto)
//   F+U = Facility > Fuel
//   I+C = Instrument > ILS
//   I+F = Instrument > FAF / approach
//
// Conditions:
//   LC = closed                 (showstopper si afecta a pista/aerodromo)
//   LX = closed to commercial
//   LT = limited
//   LF = forecast (todavia no activo)
//   AS = available for service  (info)
//   CC = completed              (info, asunto cerrado)
//   U/S aparece en texto plano

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.notamView = (function () {
  'use strict';

  const $  = sel => document.querySelector(sel);

  // Subjects que pueden ser showstoppers si la condicion es de cierre.
  const SHOWSTOPPER_SUBJECTS = new Set(['MR', 'MA']);
  // Subjects que generan aviso (no impide volar pero hay que mirar).
  const WARNING_SUBJECTS    = new Set(['MT', 'MD', 'MK', 'MS', 'FA', 'FU', 'IC', 'IF', 'IS', 'NB', 'NN', 'NV']);
  // Condiciones que indican cierre/limitacion.
  const CLOSED_CONDITIONS    = new Set(['LC', 'LX']);
  const LIMITED_CONDITIONS   = new Set(['LT', 'LP', 'LR', 'LU']);

  // Patrones de texto que sobreponen al Q-code (algunos NOTAMs son raw):
  //   AD CLSD       -> aerodromo cerrado
  //   RWY ... CLSD  -> pista cerrada
  //   APRON ... CLSD -> plataforma cerrada
  const RX_AD_CLSD     = /\b(?:AD|AERODROME)\s+CLSD\b/i;
  const RX_RWY_CLSD    = /\bRWY\s+[A-Z0-9\/]+\s+CLSD\b/i;
  const RX_ALL_RWY_CLSD = /\bALL\s+RWYS?\s+CLSD\b/i;
  const RX_TWY_CLSD    = /\bTWY\s+[A-Z0-9]+\s+CLSD\b/i;
  const RX_ILS_US      = /\bILS\b[^.]{0,40}\b(?:U\/?S|UNSERVICEABLE|UNAVBL|OUT\s+OF\s+SERVICE)\b/i;
  const RX_FUEL        = /\b(?:FUEL|JET\s*A1?)\b[^.]{0,40}\b(?:NOT\s+AVBL|UNAVBL|U\/?S)\b/i;

  // Parsea el Q-code del raw text. Devuelve { subject, condition } o null.
  function parseQCode(raw) {
    if (!raw) return null;
    // Linea Q) suele empezar con "Q) FIR/Qxxyy/..." pero a veces los
    // NOTAMs vienen con saltos colapsados. Buscamos el patron donde quiera.
    const m = String(raw).match(/Q\)\s*[A-Z]{4}\/Q([A-Z]{2})([A-Z]{2})\//);
    if (!m) return null;
    return { subject: m[1], condition: m[2] };
  }

  // Extrae los campos visibles de un NOTAM (raw text formato ICAO).
  //   E)  cuerpo principal
  //   F)  lower limit
  //   G)  upper limit
  function parseFields(raw) {
    if (!raw) return {};
    const out = {};
    // E) puede tener varias lineas hasta F) o final. Mismo para F) y G).
    const grab = (letter, nextLetters) => {
      const re = new RegExp(`${letter}\\)\\s*([\\s\\S]*?)(?:\\s+(?:${nextLetters.join('|')})\\)|$)`, 'i');
      const m = raw.match(re);
      return m ? m[1].trim() : '';
    };
    out.body  = grab('E', ['F', 'G']);
    out.lower = grab('F', ['G']);
    out.upper = grab('G', []);
    return out;
  }

  // Clasifica un NOTAM. Devuelve { severity, reasons[] }.
  //   severity: 'showstopper' | 'warning' | 'info'
  //   reasons:  array de descripciones legibles del porque.
  function classifyNotam(notam) {
    const raw = String(notam.text || notam.raw || notam.E || '');
    const q = parseQCode(raw);
    const reasons = [];
    let severity = 'info';

    if (q) {
      if (SHOWSTOPPER_SUBJECTS.has(q.subject) && CLOSED_CONDITIONS.has(q.condition)) {
        severity = 'showstopper';
        if (q.subject === 'MA') reasons.push('Aeródromo cerrado (Q' + q.subject + q.condition + ')');
        else if (q.subject === 'MR') reasons.push('Pista cerrada (Q' + q.subject + q.condition + ')');
      } else if (SHOWSTOPPER_SUBJECTS.has(q.subject) && LIMITED_CONDITIONS.has(q.condition)) {
        severity = 'warning';
        reasons.push('Pista/aeródromo limitado (Q' + q.subject + q.condition + ')');
      } else if (WARNING_SUBJECTS.has(q.subject) && (CLOSED_CONDITIONS.has(q.condition) || LIMITED_CONDITIONS.has(q.condition))) {
        severity = 'warning';
        const label = ({
          MT: 'Calle de rodaje', MD: 'Plataforma', MK: 'Parking', MS: 'Stand',
          FA: 'Servicio del AD', FU: 'Combustible',
          IC: 'ILS', IF: 'Aproximación instr.', IS: 'STAR',
          NB: 'NDB', NN: 'NDB', NV: 'VOR',
        })[q.subject] || ('Q' + q.subject);
        reasons.push(label + (CLOSED_CONDITIONS.has(q.condition) ? ' cerrado' : ' limitado'));
      }
    }

    // Patrones de texto: pueden subir la severidad si Q-code no la habia
    // marcado, pero NO la bajan.
    if (RX_AD_CLSD.test(raw) || RX_ALL_RWY_CLSD.test(raw)) {
      severity = 'showstopper';
      if (!reasons.length) reasons.push('Aeródromo / todas las pistas cerradas (texto)');
    } else if (RX_RWY_CLSD.test(raw) && severity !== 'showstopper') {
      severity = 'showstopper';
      reasons.push('Pista cerrada (texto)');
    } else if (RX_ILS_US.test(raw) && severity === 'info') {
      severity = 'warning';
      reasons.push('ILS fuera de servicio');
    } else if (RX_FUEL.test(raw) && severity === 'info') {
      severity = 'warning';
      reasons.push('Combustible no disponible');
    } else if (RX_TWY_CLSD.test(raw) && severity === 'info') {
      severity = 'warning';
      reasons.push('Calle de rodaje cerrada');
    }

    return { severity, reasons };
  }

  // ── UI ───────────────────────────────────────────────────────────────

  let _state = {
    aerodromes: [],         // ICAOs consultados
    notams: [],             // array bruto recibido
    classified: [],         // [{notam, severity, reasons}]
    loading: false,
    error: null,
  };

  function setStatus(msg, kind) {
    const el = $('#notam-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  }

  // Renderiza un NOTAM individual en formato card.
  function renderNotamCard(item) {
    const n = item.notam;
    const raw = String(n.text || n.raw || '');
    const fields = parseFields(raw);
    const q = parseQCode(raw);
    const reasonChips = (item.reasons || []).map(r =>
      `<span class="notam-reason">${escapeHTML(r)}</span>`).join('');
    const reasonsBlock = item.reasons && item.reasons.length
      ? `<div class="notam-reasons">${reasonChips}</div>` : '';
    const qcodeBlock = q
      ? `<span class="notam-meta-chip">Q${escapeHTML(q.subject)}${escapeHTML(q.condition)}</span>` : '';
    const limitsBlock = (fields.lower || fields.upper)
      ? `<span class="notam-meta-chip">${escapeHTML(fields.lower || '?')} – ${escapeHTML(fields.upper || '?')}</span>` : '';
    return `
      <div class="notam-card notam-card-${item.severity}">
        <div class="notam-head">
          <span class="notam-id"><b>${escapeHTML(n.notamId || n.id || '—')}</b></span>
          <span class="notam-ad">${escapeHTML(n.icaoLocation || n.location || '')}</span>
          <span class="notam-window">${fmtDate(n.fromDate || n.startValidity)} → ${fmtDate(n.toDate || n.endValidity)}</span>
        </div>
        ${reasonsBlock}
        <div class="notam-body">${escapeHTML(fields.body || raw).replace(/\n/g, '<br>')}</div>
        <div class="notam-meta">
          ${qcodeBlock}
          ${limitsBlock}
        </div>
      </div>`;
  }

  // Pinta las tres cubetas.
  function renderBuckets() {
    const root = $('#notam-results');
    if (!root) return;
    if (_state.error) {
      root.innerHTML = `<div class="notam-empty error"><b>Error al cargar NOTAMs:</b> ${escapeHTML(_state.error)}</div>`;
      return;
    }
    if (_state.loading) {
      root.innerHTML = '<div class="notam-empty"><i>Cargando NOTAMs…</i></div>';
      return;
    }
    if (!_state.classified.length) {
      root.innerHTML = '<div class="notam-empty">No hay NOTAMs activos para los aeródromos consultados.</div>';
      return;
    }
    const showstoppers = _state.classified.filter(i => i.severity === 'showstopper');
    const warnings    = _state.classified.filter(i => i.severity === 'warning');
    const infos       = _state.classified.filter(i => i.severity === 'info');

    const bucket = (title, items, cls) => {
      if (!items.length) return '';
      return `
        <section class="notam-bucket notam-bucket-${cls}">
          <h3>${title} <span class="badge">${items.length}</span></h3>
          ${items.map(renderNotamCard).join('')}
        </section>`;
    };
    root.innerHTML = [
      bucket('🚨 Showstoppers', showstoppers, 'showstopper'),
      bucket('⚠ Avisos', warnings, 'warning'),
      bucket('ℹ Informativos', infos, 'info'),
    ].join('');
  }

  // Convierte la lista bruta de NOTAMs en clasificada (cacheada en _state).
  function reclassify() {
    _state.classified = _state.notams.map(n => {
      const c = classifyNotam(n);
      return { notam: n, severity: c.severity, reasons: c.reasons };
    });
    // Showstoppers primero, luego warnings, info al final. Dentro de cada
    // cubeta, los mas recientes (fromDate descendente) arriba.
    _state.classified.sort((a, b) => {
      const sevW = { showstopper: 0, warning: 1, info: 2 };
      const ds = sevW[a.severity] - sevW[b.severity];
      if (ds !== 0) return ds;
      const ta = new Date(a.notam.fromDate || a.notam.startValidity || 0).getTime();
      const tb = new Date(b.notam.fromDate || b.notam.startValidity || 0).getTime();
      return tb - ta;
    });
  }

  // ── Carga via Autorouter ──────────────────────────────────────────────

  async function loadFor(icaoList) {
    const mapi = window.TSAgestor && window.TSAgestor.meteoApi;
    if (!mapi || !mapi.fetchNotamsForAerodromes) {
      _state.error = 'meteoApi.fetchNotamsForAerodromes no disponible';
      renderBuckets(); return;
    }
    _state.aerodromes = icaoList.slice();
    _state.loading = true;
    _state.error = null;
    renderBuckets();
    setStatus('Consultando NOTAMs de ' + icaoList.join(', ') + ' …', 'loading');
    try {
      const data = await mapi.fetchNotamsForAerodromes(icaoList);
      _state.notams = Array.isArray(data) ? data : [];
      reclassify();
      _state.loading = false;
      setStatus(_state.notams.length + ' NOTAMs · ' +
        _state.classified.filter(i => i.severity === 'showstopper').length + ' showstoppers, ' +
        _state.classified.filter(i => i.severity === 'warning').length + ' avisos.', 'ok');
    } catch (e) {
      _state.loading = false;
      const msg = String((e && e.message) || e);
      if (msg === 'SERVER_NO_CREDS' || msg === 'TOKEN_REJECTED' || msg === 'NO_CREDS') {
        _state.error = 'No hay credenciales Autorouter configuradas en el servidor. ' +
          'Pide al admin que ponga AUTOROUTER_USER / AUTOROUTER_PASS en Cloudflare Pages.';
      } else {
        _state.error = msg;
      }
    }
    renderBuckets();
  }

  function getCurrentPlanIcaos() {
    const app = window.TSAgestor && window.TSAgestor.app;
    if (app && app.getPlanIcaos) return app.getPlanIcaos();
    const o = (document.getElementById('plan-origin') || {}).value;
    const d = (document.getElementById('plan-dest')   || {}).value;
    const out = [];
    if (o && /^[A-Z]{4}$/i.test(String(o).trim())) out.push(String(o).trim().toUpperCase());
    if (d && /^[A-Z]{4}$/i.test(String(d).trim())) out.push(String(d).trim().toUpperCase());
    return out;
  }

  // Llamada cuando la pestanya se activa. Si los ICAOs del plan han
  // cambiado, recarga; si no, deja el resultado cacheado.
  function onTabOpen() {
    const planIcaos = getCurrentPlanIcaos();
    const input = $('#notam-icaos');
    if (input && !input.value && planIcaos.length) {
      input.value = planIcaos.join(' ');
    }
    // No autoloadeamos al primer abierto: requiere boton explicito para
    // no malgastar quota de Autorouter cada vez que el usuario navega.
  }

  function _wireUI() {
    const btn = $('#btn-notam-load');
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', () => {
        const raw = ($('#notam-icaos') || {}).value || '';
        const list = raw.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{4}$/.test(s));
        if (!list.length) {
          setStatus('Introduce al menos un ICAO valido (4 letras).', 'error');
          return;
        }
        loadFor(list);
      });
    }
    const btnPlan = $('#btn-notam-from-plan');
    if (btnPlan && !btnPlan._wired) {
      btnPlan._wired = true;
      btnPlan.addEventListener('click', () => {
        const icaos = getCurrentPlanIcaos();
        if (!icaos.length) {
          setStatus('No hay origen/destino en el plan de vuelo.', 'error');
          return;
        }
        const input = $('#notam-icaos');
        if (input) input.value = icaos.join(' ');
        loadFor(icaos);
      });
    }
  }

  return {
    classifyNotam,
    parseQCode,
    parseFields,
    onTabOpen: function () { _wireUI(); onTabOpen(); },
    loadFor,
  };
})();
