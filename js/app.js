// Controlador principal: navegación por pestañas, estado, wiring de UI.
//
// Visibilidad en Mapa / Corte / PDF = TSAs SELECCIONADAS ∩ TSAs QUE PASAN EL FILTRO.

(function () {
  'use strict';

  const { parser, filters, mapView, crossSection, pdfExport, scheduleFmt, flightPlan, geom, meteoApi, settings, savedPlans } = window.TSAgestor;

  // Mapeo entre IDs del formulario Plan y dot-paths de settings.plan.*
  const PLAN_INPUT_TO_SETTING = {
    'plan-origin':       'plan.origin',
    'plan-dest':         'plan.destination',
    'plan-fl':           'plan.flightLevel',
    'plan-speed':        'plan.speedKt',
    'plan-fuel-initial': 'plan.fuelInitial',
    'plan-fuel-flow':    'plan.fuelFlow',
    'plan-fuel-unit':    'plan.fuelUnit',
    'plan-joker':        'plan.joker',
    'plan-bingo':        'plan.bingo',
  };

  function applySettingsToPlanForm() {
    if (!settings) return;
    Object.keys(PLAN_INPUT_TO_SETTING).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const v = settings.get(PLAN_INPUT_TO_SETTING[id], el.defaultValue);
      if (v !== undefined && v !== null) el.value = v;
    });
  }

  const state = {
    tsas: [],                                                 // todas las parseadas
    selected: new Set(),                                       // ids seleccionadas por el usuario
    filter: { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '' },
    mapReady: false,
    lastPlan: null,                                            // último plan calculado
    planWPsLoaded: false,
    drawnVia: null,                                            // ruta dibujada como [{name,lat,lon}], si la hay
    crossClouds: null,                                         // nubes Open-Meteo muestreadas en los waypoints del plan
    legendOpen: false,                                         // toggle de la leyenda flotante de TSAs en el mapa
    layersControlOpen: true,                                   // toggle del selector de capas Leaflet (visible por defecto)
  };

  // ── Utilidades DOM ───────────────────────────────────────────────────

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function setStatus(msg, type) {
    const el = $('#parse-status');
    el.textContent = msg || '';
    el.className = 'status ' + (type || 'info');
  }

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── Conjunto visible = seleccionadas ∩ pasa-filtro ──────────────────

  function getVisible() {
    return state.tsas.filter(t =>
      state.selected.has(t.id) && filters.matches(t, state.filter)
    );
  }

  // ── Tabs ─────────────────────────────────────────────────────────────

  function switchTab(name) {
    // Si dejamos la pestaña de mapa con el modo dibujo activo, lo
    // cancelamos -- el banner se queda visible si no, y al volver
    // cualquier clic en el mapa anyade un waypoint inesperado.
    if (name !== 'map' && mapView && mapView.cancelDrawingRoute) {
      mapView.cancelDrawingRoute();
      hideDrawBanner();
    }
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-content').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'map') {
      ensureMap();
      // El contenedor #map puede tener tamaño 0×0 hasta que el navegador
      // hace layout. Esperamos un tick, llamamos invalidateSize para que
      // Leaflet remida y SOLO ENTONCES encajamos los bounds (a TSAs, plan
      // o vista por defecto de Iberia).
      setTimeout(() => {
        mapView.invalidateSize();
        const visible = getVisible();
        if (visible.length > 0) {
          mapView.render(visible);
        }
        if (state.lastPlan) {
          mapView.renderFlightPlan(state.lastPlan);
        }
        if (visible.length === 0 && !state.lastPlan) {
          mapView.fitToDefault();
        }
      }, 50);
    }
    if (name === 'cross') renderCross();
    if (name === 'plan') initPlanTab();
    if (name === 'notams') {
      if (window.TSAgestor.notamView && window.TSAgestor.notamView.onTabOpen) {
        window.TSAgestor.notamView.onTabOpen();
      }
    }
    if (name === 'export') refreshExportUI();
    if (name === 'settings') initSettingsTab();
  }

  // ── Pestaña Ajustes ─────────────────────────────────────────────────

  let _settingsWired = false;

  function initSettingsTab() {
    if (!settings) return;
    // Sincroniza UI con valores actuales (cada vez que se entra).
    document.querySelectorAll('#tab-settings [data-setting]').forEach(input => {
      const path = input.dataset.setting;
      const v = settings.get(path);
      if (input.type === 'range') {
        const pct = Math.round((Number(v) || 0) * 100);
        input.value = pct;
        const out = input.parentElement.querySelector('.settings-value');
        if (out) out.textContent = pct + ' %';
      } else if (v !== undefined && v !== null) {
        input.value = v;
      }
    });
    if (_settingsWired) return;
    _settingsWired = true;
    document.querySelectorAll('#tab-settings [data-setting]').forEach(input => {
      input.addEventListener('input', () => {
        const path = input.dataset.setting;
        if (input.type === 'range') {
          const pct = Number(input.value);
          const out = input.parentElement.querySelector('.settings-value');
          if (out) out.textContent = pct + ' %';
          settings.set(path, pct / 100);
        } else if (input.type === 'number') {
          settings.set(path, Number(input.value));
        } else {
          settings.set(path, input.value);
        }
      });
    });
    $('#btn-settings-show-welcome').addEventListener('click', () => {
      sessionStorage.removeItem('tsagestor_welcome_accepted');
      alert('El aviso de seguridad se mostrará la próxima vez que cargues la web.');
    });
    $('#btn-settings-reset').addEventListener('click', () => {
      if (!confirm('¿Restaurar todos los ajustes a valores de fábrica?')) return;
      settings.reset();
      initSettingsTab();          // re-sincroniza inputs
      applySettingsToPlanForm();  // refleja en form de plan también
      if (state.mapReady && mapView.applyOpacities) mapView.applyOpacities();
    });
  }

  // ── Agrupamiento visual de TSAs por nombre similar ──────────────────
  // Agrupa TSAs con mismo prefijo de nombre (todo antes del ultimo token),
  // misma banda vertical (lower/upper labels iguales) y mismo schedule.
  // Asi TSA CORREDOR SUR 4, 5, 6 -> "TSA CORREDOR SUR 4-6" cuando los
  // sufijos son consecutivos, o "TSA CORREDOR SUR 4, 6, 8" cuando no lo
  // son. Solo afecta a la VISUALIZACION en la lista de Cargar y la
  // leyenda del mapa -- el state.tsas y la seleccion siguen siendo por
  // TSA individual.
  function groupTSAsByName(tsas) {
    const buckets = new Map();
    const order = [];
    for (const t of tsas) {
      const lastSpace = t.name.lastIndexOf(' ');
      let prefix, suffix;
      if (lastSpace < 0 || lastSpace === t.name.length - 1) {
        prefix = t.name; suffix = null;
      } else {
        prefix = t.name.slice(0, lastSpace);
        suffix = t.name.slice(lastSpace + 1);
      }
      // Solo agrupamos si el prefijo tiene >=2 tokens. "TSA" solo no
      // identifica nada -- agruparia TSAs sin relacion (ANDEVALO, GOLFO,
      // TRUJILLO...). El prefijo debe llevar al menos un nombre propio
      // ademas de "TSA".
      const prefixTokens = prefix.split(/\s+/).filter(Boolean);
      const canGroup = suffix != null && prefixTokens.length >= 2;
      // CLAVE DE AGRUPACION:
      //   - NotamHub (TSA con campo _source === 'notamhub'): la dedup
      //     en convertTSAsToInternal ya colapso las TSAs identicas
      //     por (name + vertical). Aqui solo nos queda agrupar hermanas
      //     de familia (TSA TALAVERA LOW SOUTH 1, 2) que pueden venir
      //     de NOTAMs distintos (parent_notam_id distinto). Por eso
      //     agrupamos por (prefix + vertical) sin schedule ni parent.
      //   - Parser PDF clasico: conservamos el criterio antiguo
      //     (prefix + vertical + firma de schedules) para no agrupar
      //     TSAs con ventanas distintas que vienen de NOTAMs distintos
      //     del mismo boletin.
      let key;
      if (!canGroup) {
        key = '__single__|' + t.id;
      } else if (t._source === 'notamhub') {
        key = prefix + '||' + (t.vertical.lowerLabel || '') + '||' +
              (t.vertical.upperLabel || '');
      } else {
        const schedSig = (t.schedules || []).map(s => {
          const sa = s.startUTC instanceof Date ? s.startUTC.getTime() : Date.parse(s.startUTC);
          const sb = s.endUTC   instanceof Date ? s.endUTC.getTime()   : Date.parse(s.endUTC);
          return sa + '-' + sb;
        }).join(',');
        key = prefix + '||' + (t.vertical.lowerLabel || '') + '||' +
              (t.vertical.upperLabel || '') + '||SCH:' + schedSig;
      }
      if (!buckets.has(key)) {
        buckets.set(key, { prefix, suffixes: [], tsas: [] });
        order.push(key);
      }
      const g = buckets.get(key);
      g.tsas.push(t);
      if (canGroup) g.suffixes.push(suffix);
    }
    return order.map(k => buckets.get(k));
  }

  // Formatea el nombre del grupo: "TSA CORREDOR SUR 4-6" si los sufijos
  // son consecutivos (numeros o letras), "TSA MILIS A, C, E" si no.
  function formatGroupName(g) {
    if (g.tsas.length === 1) return g.tsas[0].name;
    if (!g.suffixes.length) return g.prefix;
    // Ordena suffixes numericamente si son numeros, alfabeticamente si letras.
    const sorted = g.suffixes.slice().sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
    const allNumeric = sorted.every(s => /^\d+$/.test(s));
    const allLetters = sorted.every(s => /^[A-Z]$/.test(s));
    let consecutive = false;
    if (allNumeric && sorted.length >= 2) {
      consecutive = sorted.every((s, i) => i === 0 || Number(s) === Number(sorted[i - 1]) + 1);
    } else if (allLetters && sorted.length >= 2) {
      consecutive = sorted.every((s, i) => i === 0 || s.charCodeAt(0) === sorted[i - 1].charCodeAt(0) + 1);
    }
    if (consecutive) return `${g.prefix} ${sorted[0]}–${sorted[sorted.length - 1]}`;
    return `${g.prefix} ${sorted.join(', ')}`;
  }

  // ── Tabla de TSAs ────────────────────────────────────────────────────

  function renderTable() {
    const tbody = $('#tsa-table tbody');
    tbody.innerHTML = '';

    const groups = groupTSAsByName(state.tsas);
    // Diagnostico: cuantos grupos vs TSAs sueltas. Si NotamHub no esta
    // agrupando bien, aqui salen muchos grupos de 1 elemento (singletons).
    if (state.tsas.length > 0) {
      const multi  = groups.filter(g => g.tsas.length > 1).length;
      const singl  = groups.filter(g => g.tsas.length === 1).length;
      console.info(`[group] ${state.tsas.length} TSAs -> ${groups.length} grupos ` +
                   `(${multi} multi · ${singl} sueltas).` +
                   (state.tsas[0] && state.tsas[0]._parentNotam
                     ? ` Source: NotamHub (parent_notam_id presente).`
                     : ''));
      // Si la mayoria son singletons con NotamHub, dump del primer
      // singleton "TSA <X>" para ver porque no se agrupa.
      if (state.tsas[0] && state.tsas[0]._parentNotam && singl > multi * 2) {
        const sample = groups.filter(g => g.tsas.length === 1).slice(0, 3);
        console.warn('[group] Demasiados singletons. Muestras:',
          sample.map(g => ({
            name: g.tsas[0].name,
            parent: g.tsas[0]._parentNotam,
            vertical: g.tsas[0].vertical.lowerLabel + '/' + g.tsas[0].vertical.upperLabel,
            nSchedules: (g.tsas[0].schedules || []).length,
          })));
      }
    }
    for (const g of groups) {
      if (g.tsas.length === 1) {
        // Singleton: fila normal sin decoracion de grupo.
        tbody.appendChild(buildTsaRow(g.tsas[0], { isGroupMember: false }));
        continue;
      }
      // Grupo: cabecera con checkbox maestro + boton expand + miembros
      // ocultos por defecto.
      const groupId = 'grp-' + g.tsas.map(t => t.id).join('_');
      const memberIds = g.tsas.map(t => t.id);
      const nSel = memberIds.filter(id => state.selected.has(id)).length;
      const allInFilter = g.tsas.every(t => filters.matches(t, state.filter));
      const someInFilter = g.tsas.some(t => filters.matches(t, state.filter));
      const masterState = nSel === memberIds.length ? 'checked'
                        : nSel === 0 ? '' : 'indeterminate';
      const trHead = document.createElement('tr');
      trHead.className = 'tsa-row tsa-row-group' +
        (allInFilter ? '' : (someInFilter ? '' : ' out-of-filter')) +
        (nSel === memberIds.length ? ' selected' : '');
      trHead.dataset.groupId = groupId;
      trHead.dataset.memberIds = memberIds.join(',');
      // Schedule comun -> resumen unico.
      const tref = g.tsas[0];
      const schedHTML = `
        <details class="sched-details">
          <summary>${escapeHTML(scheduleFmt.summary(tref.schedules))}</summary>
          <div class="sched-list">${scheduleFmt.listHTML(tref.schedules)}</div>
        </details>`;
      trHead.innerHTML = `
        <td class="col-check">
          <input type="checkbox" class="tsa-group-check" data-group-id="${escapeHTML(groupId)}"${masterState === 'checked' ? ' checked' : ''}>
        </td>
        <td>
          <button type="button" class="tsa-group-toggle" aria-expanded="false" title="Ver/ocultar TSAs del grupo">▸</button>
          <b>${escapeHTML(formatGroupName(g))}</b>
          <span class="tsa-group-count">${g.tsas.length}</span>
        </td>
        <td>${tref.format}</td>
        <td>${escapeHTML(tref.vertical.lowerLabel)}</td>
        <td>${escapeHTML(tref.vertical.upperLabel)}</td>
        <td><span class="dim">${g.tsas.length} TSAs</span></td>
        <td>${schedHTML}</td>
      `;
      tbody.appendChild(trHead);
      // Set indeterminate manualmente (no se puede via atributo HTML).
      const cb = trHead.querySelector('.tsa-group-check');
      if (cb) cb.indeterminate = (masterState === 'indeterminate');

      // Miembros (ocultos por defecto, se desvelan al pulsar el toggle).
      for (const t of g.tsas) {
        const tr = buildTsaRow(t, { isGroupMember: true, groupId });
        tr.classList.add('hidden');
        tbody.appendChild(tr);
      }
    }

    $('#tsa-count').textContent = state.tsas.length;
    $('#tsa-table-wrap').classList.toggle('hidden', state.tsas.length === 0);
    refreshSelectionUI();
  }

  function buildTsaRow(t, opts) {
    opts = opts || {};
    const inFilter  = filters.matches(t, state.filter);
    const isSelected = state.selected.has(t.id);
    const schedHTML = `
      <details class="sched-details">
        <summary>${escapeHTML(scheduleFmt.summary(t.schedules))}</summary>
        <div class="sched-list">${scheduleFmt.listHTML(t.schedules)}</div>
      </details>`;
    const tr = document.createElement('tr');
    tr.className = 'tsa-row' + (inFilter ? '' : ' out-of-filter') +
      (isSelected ? ' selected' : '') +
      (opts.isGroupMember ? ' tsa-row-member' : '');
    tr.dataset.id = t.id;
    if (opts.groupId) tr.dataset.groupId = opts.groupId;
    // Si es miembro de grupo, sangramos el nombre y omitimos el prefijo
    // duplicado (el prefijo ya esta en la cabecera del grupo).
    const displayName = opts.isGroupMember
      ? escapeHTML(t.name)
      : `<b>${escapeHTML(t.name)}</b>`;
    tr.innerHTML = `
      <td class="col-check">
        <input type="checkbox" class="tsa-check" data-id="${escapeHTML(t.id)}"${isSelected ? ' checked' : ''}>
      </td>
      <td${opts.isGroupMember ? ' class="tsa-name-indent"' : ''}>${displayName}</td>
      <td>${t.format}</td>
      <td>${escapeHTML(t.vertical.lowerLabel)}</td>
      <td>${escapeHTML(t.vertical.upperLabel)}</td>
      <td>${t.polygon.length}</td>
      <td>${schedHTML}</td>
    `;
    return tr;
  }

  function refreshSelectionUI() {
    const total     = state.tsas.length;
    const selected  = state.selected.size;
    const visible   = getVisible().length;
    const inFilter  = state.tsas.filter(t => filters.matches(t, state.filter)).length;

    $('#selection-summary').textContent =
      total === 0 ? '' :
      `${selected} seleccionadas · ${visible} visibles (${inFilter} en filtro)`;

    const masterCb = $('#tsa-select-all-cb');
    if (masterCb) {
      masterCb.checked       = total > 0 && selected === total;
      masterCb.indeterminate = selected > 0 && selected < total;
    }

    $('#filter-summary').textContent =
      total === 0
        ? ''
        : `${visible} visibles · ${selected}/${total} seleccionadas · ${filters.summaryText(state.filter)}`;
  }

  // ── Carga de archivo ─────────────────────────────────────────────────

  // Ordena state.tsas in-place por distancia desde el aeropuerto origen
  // (toma el ICAO del settings plan.origin, default LEBZ). Si no encontramos
  // las coords del aeropuerto, deja el orden tal cual. Si una TSA no tiene
  // centroid, la enviamos al final.
  function sortTSAsByOriginProximity() {
    if (!state.tsas || state.tsas.length < 2) return;
    const aw = window.TSAgestor && window.TSAgestor.airways;
    const originIcao = String((settings && settings.get('plan.origin', 'LEBZ')) || 'LEBZ').toUpperCase();
    const origin = aw && aw.waypoints && aw.waypoints[originIcao];
    if (!origin || !Array.isArray(origin) || origin.length < 2) {
      console.info(`[sort] No hay coords para ${originIcao}; orden por proximidad omitido.`);
      return;
    }
    if (!geom || !geom.greatCircleDistance) return;
    const distOf = (t) => {
      if (!t.centroid || !Array.isArray(t.centroid)) return Infinity;
      return geom.greatCircleDistance(origin, t.centroid);
    };
    state.tsas.sort((a, b) => distOf(a) - distOf(b));
    console.info(`[sort] TSAs ordenadas por proximidad a ${originIcao} ` +
                 `(${origin[0].toFixed(2)},${origin[1].toFixed(2)}). ` +
                 `Mas cercana: ${state.tsas[0].name} (${(distOf(state.tsas[0])/1852).toFixed(0)} NM).`);
  }

  async function handleFile(file) {
    if (!file) return;
    setStatus(`Procesando ${file.name}…`, 'info');
    try {
      const tsas = await parser.parseFile(file);
      state.tsas = tsas;
      sortTSAsByOriginProximity();
      state.selected = new Set(tsas.map(t => t.id)); // por defecto todas
      state.filter = readFilter();
      if (tsas.length === 0) {
        setStatus('No se han encontrado TSAs en el documento.', 'error');
      } else {
        setStatus(`${tsas.length} TSAs detectadas.`, 'ok');
      }
      $('#filter-bar').classList.remove('hidden');
      ensureMap();
      renderAll();
    } catch (err) {
      console.error(err);
      setStatus('Error al procesar el archivo: ' + err.message, 'error');
    }
  }

  // datetime-local devuelve "YYYY-MM-DDTHH:MM" sin tz; el campo es UTC
  // por contrato, asi que anyadimos 'Z' para que JS no lo interprete
  // como hora local. null si el string esta vacio.
  function parseUtcInput(iso) {
    if (!iso) return null;
    const d = new Date(iso + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }

  // Carga TSAs directamente desde NotamHub (API ICARO nacional). Acepta
  // punto en el tiempo (atIso) o rango (atIso + atToIso). Si solo se
  // pasa atTo, lo ignoramos y usamos punto. Si solo at, snapshot
  // puntual. Si ambos, rango con `at_to` -> TSAs solapando la ventana.
  async function handleNotamHubLoad(atIso, atToIso) {
    const nh = window.TSAgestor && window.TSAgestor.notamHub;
    if (!nh) { setNotamHubStatus('notamHub no disponible.', 'error'); return; }
    const atDate = parseUtcInput(atIso) || new Date();
    const atToDate = parseUtcInput(atToIso);
    const usingRange = !!(atToDate && atToDate.getTime() > atDate.getTime());
    const queryParams = usingRange ? { at: atDate, atTo: atToDate } : { at: atDate };
    setNotamHubStatus(usingRange
      ? `Consultando NotamHub (rango ${atDate.toISOString().slice(0,16)}Z → ${atToDate.toISOString().slice(0,16)}Z)…`
      : `Consultando NotamHub (punto ${atDate.toISOString().slice(0,16)}Z)…`,
      'loading');
    try {
      const apiList = await nh.fetchActiveTSAs(queryParams);
      if (!Array.isArray(apiList)) {
        setNotamHubStatus(
          'Respuesta inesperada del API (no es array): ' + JSON.stringify(apiList).slice(0, 200) +
          ' — abre F12 → Console para detalles.', 'error');
        return;
      }
      if (apiList.length === 0) {
        setNotamHubStatus(
          'El API devolvió 0 TSAs para el rango/hora pedido. ' +
          'Comprueba que las fechas son UTC y que el token está autorizado.', 'warn');
        return;
      }
      const tsas = nh.convertTSAsToInternal(apiList, atDate);
      state.tsas = tsas;
      sortTSAsByOriginProximity();
      state.selected = new Set(state.tsas.map(t => t.id));
      state.filter = readFilter();
      $('#filter-bar').classList.remove('hidden');
      ensureMap();
      renderAll();
      if (!tsas.length) {
        const sample = apiList[0];
        setNotamHubStatus(
          `El API devolvió ${apiList.length} TSAs pero ninguna se pudo convertir. ` +
          `Primera entrada: ${JSON.stringify(sample).slice(0, 250)} — abre F12 → Console.`,
          'error');
        return;
      }
      const whenLabel = usingRange
        ? `${atDate.toISOString().slice(0, 16).replace('T', ' ')}Z → ${atToDate.toISOString().slice(0, 16).replace('T', ' ')}Z`
        : `${atDate.toISOString().slice(0, 16).replace('T', ' ')}Z`;
      setNotamHubStatus(`${tsas.length} TSAs ${usingRange ? 'en' : 'a'} ${whenLabel}. ` +
        `Fuente: NotamHub /tsas/active${usingRange ? ' (rango)' : ''}.`, 'ok');
      setStatus(`${tsas.length} TSAs cargadas desde NotamHub.`, 'ok');

      // Si el checkbox LPPC está marcado, anyadimos las areas portuguesas
      // que Autorouter publique. Las convertimos a TSA-like con
      // convertAutorouterNotamsToTSAs y las anyadimos a state.tsas.
      const includeLPPC = ($('#notamhub-include-lppc') || {}).checked;
      if (includeLPPC) {
        await augmentWithLPPCAreas();
      }
    } catch (e) {
      console.warn('[notamhub] error:', e);
      setNotamHubStatus('Error: ' + (e.message || e) + '. Abre F12 → Console para detalles.', 'error');
    }
  }

  async function augmentWithLPPCAreas() {
    const meteo = window.TSAgestor && window.TSAgestor.meteoApi;
    const nh    = window.TSAgestor && window.TSAgestor.notamHub;
    if (!meteo || !meteo.fetchNotamsForAerodromes || !nh || !nh.convertAutorouterNotamsToTSAs) {
      console.warn('[notamhub+lppc] dependencias no cargadas');
      return;
    }
    try {
      const baseMsg = $('#notamhub-status').textContent;
      setNotamHubStatus(baseMsg + ' · Consultando LPPC vía Autorouter…', 'loading');
      // Pedimos LPPC (FIR) y los aerodromos portugueses principales en
      // la misma query. Algunas activaciones militares de area se
      // publican con icaoLocation del aerodromo cercano en vez de la
      // FIR, asi traemos un superset y filtramos por Q-code.
      const LPPC_QUERY = [
        'LPPC',                                // FIR Lisboa
        'LPPT', 'LPFR', 'LPMA', 'LPPS',        // Lisboa, Faro, Madeira, Porto Santo
        'LPLA', 'LPPR', 'LPBR', 'LPBJ',        // Lajes, Porto, Braganca, Beja
        'LPCH', 'LPCO', 'LPMR', 'LPMT',        // Castelo Branco, Coimbra, Monte Real, Montijo
        'LPST', 'LPOV', 'LPVR',                // Sintra, Ovar, Vila Real
      ];
      const notams = await meteo.fetchNotamsForAerodromes(LPPC_QUERY);
      // Por ahora solo cargamos los MILITARES (Q-code R* o ids LP[RDT],
      // M-series, keywords MIL/EXERCISE/TRG). El resto de NOTAMs LPPC
      // siguen accesibles desde la pestanya NOTAMs sin pintar en mapa.
      const lppcTsas = nh.convertAutorouterNotamsToTSAs(notams, {
        namePrefix: 'LPPC',
        onlyMilitary: true,
      });
      if (!lppcTsas.length) {
        setNotamHubStatus(baseMsg +
          ` · Autorouter devolvió ${notams.length} NOTAMs LPPC (FIR + aerodromos), ninguno militar con área parseable. ` +
          `Mira F12 → Console para histograma Q-subject.`, 'warn');
        return;
      }
      // Anyadimos a state.tsas (sin duplicar por id).
      const existingIds = new Set(state.tsas.map(t => t.id));
      let added = 0;
      for (const t of lppcTsas) {
        if (!existingIds.has(t.id)) { state.tsas.push(t); added++; }
      }
      // Seleccionadas todas las nuevas tambien.
      for (const t of lppcTsas) state.selected.add(t.id);
      sortTSAsByOriginProximity();   // reordena con las LPPC anyadidas
      renderAll();
      setNotamHubStatus(baseMsg + ` · +${added} áreas LPPC añadidas.`, 'ok');
    } catch (e) {
      console.warn('[notamhub+lppc] error:', e);
      const baseMsg = $('#notamhub-status').textContent.split(' · ')[0];
      setNotamHubStatus(baseMsg + ' · ⚠ LPPC vía Autorouter falló: ' + (e.message || e), 'warn');
    }
  }

  function setNotamHubStatus(msg, kind) {
    const el = $('#notamhub-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function wireUpload() {
    const fileInput = $('#file-input');
    const dropzone = $('#dropzone');

    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      handleFile(f);
      fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(ev =>
      dropzone.addEventListener(ev, e => {
        e.preventDefault();
        dropzone.classList.add('drag-over');
      })
    );
    ['dragleave', 'drop'].forEach(ev =>
      dropzone.addEventListener(ev, e => {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
      })
    );
    dropzone.addEventListener('drop', e => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    // NotamHub (API ICARO): boton "Cargar TSAs activas" + presets.
    const btnNH      = $('#btn-notamhub-load');
    const inputAt    = $('#notamhub-at');
    const inputAtTo  = $('#notamhub-at-to');
    if (btnNH) {
      btnNH.addEventListener('click', () => {
        const v   = inputAt   && inputAt.value   ? inputAt.value   : '';
        const v2  = inputAtTo && inputAtTo.value ? inputAtTo.value : '';
        handleNotamHubLoad(v, v2);
      });
    }
    // Presets: now / next6 / next24 / next48 / next7d / clear. Rellenan
    // los inputs at + at_to en UTC.
    const pad = n => String(n).padStart(2, '0');
    const toUtcInput = (d) =>
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    document.querySelectorAll('[data-notamhub-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.notamhubPreset;
        const now = new Date();
        if (preset === 'clear') {
          if (inputAt)   inputAt.value   = '';
          if (inputAtTo) inputAtTo.value = '';
          return;
        }
        if (preset === 'now') {
          if (inputAt)   inputAt.value   = toUtcInput(now);
          if (inputAtTo) inputAtTo.value = '';
          return;
        }
        const hours = { next6: 6, next24: 24, next48: 48, next7d: 24 * 7 }[preset];
        if (!hours) return;
        if (inputAt)   inputAt.value   = toUtcInput(now);
        if (inputAtTo) inputAtTo.value = toUtcInput(new Date(now.getTime() + hours * 3600 * 1000));
      });
    });
  }

  // ── Selección ────────────────────────────────────────────────────────

  function wireSelection() {
    // Delegación para los checkboxes de fila (incluye master de grupo).
    $('#tsa-table tbody').addEventListener('change', e => {
      const groupCb = e.target.closest('.tsa-group-check');
      if (groupCb) {
        // Master de grupo: marca/desmarca todos los miembros.
        const headRow = groupCb.closest('tr');
        const memberIds = (headRow.dataset.memberIds || '').split(',').filter(Boolean);
        const newState = groupCb.checked;
        for (const id of memberIds) {
          if (newState) state.selected.add(id);
          else state.selected.delete(id);
          // Refleja en los checkboxes hijos si estan en DOM.
          const child = $('#tsa-table tbody').querySelector(`.tsa-check[data-id="${cssEsc(id)}"]`);
          if (child) {
            child.checked = newState;
            const row = child.closest('tr');
            if (row) row.classList.toggle('selected', newState);
          }
        }
        headRow.classList.toggle('selected', newState);
        groupCb.indeterminate = false;
        refreshSelectionUI();
        renderViews();
        return;
      }
      const cb = e.target.closest('.tsa-check');
      if (!cb) return;
      const id = cb.dataset.id;
      if (cb.checked) state.selected.add(id);
      else state.selected.delete(id);
      const row = cb.closest('tr');
      if (row) row.classList.toggle('selected', cb.checked);
      // Si pertenece a un grupo, actualizar el master del grupo (check /
      // indeterminate / unchecked) sin disparar otro change.
      const groupId = row && row.dataset.groupId;
      if (groupId) syncGroupMasterCheckbox(groupId);
      refreshSelectionUI();
      renderViews();
    });

    // Boton expand/collapse de un grupo: muestra u oculta sus miembros.
    $('#tsa-table tbody').addEventListener('click', e => {
      const btn = e.target.closest('.tsa-group-toggle');
      if (!btn) return;
      const headRow = btn.closest('tr');
      if (!headRow) return;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      btn.textContent = expanded ? '▸' : '▾';
      const groupId = headRow.dataset.groupId;
      const memberRows = $$('#tsa-table tbody .tsa-row-member[data-group-id="' + cssEsc(groupId) + '"]');
      for (const r of memberRows) r.classList.toggle('hidden', expanded);
    });

    $('#tsa-select-all-cb').addEventListener('change', e => {
      if (e.target.checked) selectAll();
      else selectNone();
    });

    $('#btn-select-all').addEventListener('click', selectAll);
    $('#btn-select-none').addEventListener('click', selectNone);
  }

  // Sincroniza el estado checked/indeterminate del master de un grupo
  // segun el numero de miembros seleccionados.
  function syncGroupMasterCheckbox(groupId) {
    const headRow = $('#tsa-table tbody').querySelector(`tr.tsa-row-group[data-group-id="${cssEsc(groupId)}"]`);
    if (!headRow) return;
    const memberIds = (headRow.dataset.memberIds || '').split(',').filter(Boolean);
    const nSel = memberIds.filter(id => state.selected.has(id)).length;
    const cb = headRow.querySelector('.tsa-group-check');
    if (!cb) return;
    cb.checked = (nSel === memberIds.length);
    cb.indeterminate = (nSel > 0 && nSel < memberIds.length);
    headRow.classList.toggle('selected', cb.checked);
  }

  // Escapa un valor para usar dentro de selector CSS [attr="..."].
  function cssEsc(s) { return String(s || '').replace(/(["\\])/g, '\\$1'); }

  function selectAll() {
    state.selected = new Set(state.tsas.map(t => t.id));
    renderTable();
    renderViews();
  }

  function selectNone() {
    state.selected = new Set();
    renderTable();
    renderViews();
  }

  // ── Filtro ───────────────────────────────────────────────────────────

  function readFilter() {
    return {
      dateFrom: $('#filter-date-from').value,
      dateTo:   $('#filter-date-to').value,
      timeFrom: $('#filter-time-from').value,
      timeTo:   $('#filter-time-to').value,
    };
  }

  function applyFilter() {
    state.filter = readFilter();
    renderAll();
  }

  function clearFilter() {
    $('#filter-date-from').value = '';
    $('#filter-date-to').value = '';
    $('#filter-time-from').value = '';
    $('#filter-time-to').value = '';

    // Limpiar también descarga el NOTAM: vacía TSAs, oculta la barra de filtro
    // y la tabla, y limpia el estado y el mapa.
    state.tsas = [];
    state.selected = new Set();
    state.filter = readFilter();
    $('#filter-bar').classList.add('hidden');
    setStatus('', 'info');
    renderAll();
  }

  // ── Mapa ─────────────────────────────────────────────────────────────

  function ensureMap() {
    if (state.mapReady) return;
    mapView.init('map');
    if (mapView.setWaypointClickHandler) {
      mapView.setWaypointClickHandler(addWaypointToVia);
    }
    state.mapReady = true;
  }

  // Toggle de la leyenda flotante de TSAs en el mapa. Al activar, anyade
  // un control Leaflet en la esquina top-right con la lista de TSAs
  // visibles + horario; al desactivar, lo retira sin tocar el mapa.
  function toggleMapLegend() {
    ensureMap();
    state.legendOpen = !state.legendOpen;
    const btn = $('#btn-map-legend');
    btn.setAttribute('aria-pressed', String(state.legendOpen));
    btn.classList.toggle('is-active', state.legendOpen);
    if (mapView.setLegendVisible) {
      mapView.setLegendVisible(state.legendOpen, getVisible());
    }
  }

  // Toggle del selector de capas Leaflet (TMA/CTR/aerovias/meteo) que vive
  // en la esquina superior izquierda del mapa. Visible por defecto.
  function toggleMapLayersControl() {
    ensureMap();
    state.layersControlOpen = !state.layersControlOpen;
    const btn = $('#btn-map-layers');
    btn.setAttribute('aria-pressed', String(state.layersControlOpen));
    btn.classList.toggle('is-active', state.layersControlOpen);
    if (mapView.setLayersControlVisible) {
      mapView.setLayersControlVisible(state.layersControlOpen);
    }
  }

  // Anyade un codigo de waypoint al final del campo Via del plan, evitando
  // duplicar el ultimo token. Lo dispara el click sobre un marcador de
  // waypoint en cualquiera de las capas zonales del mapa.
  function addWaypointToVia(code) {
    if (!code) return;
    const inp = $('#plan-via');
    if (!inp) return;
    const cur = (inp.value || '').trim();
    const tokens = cur ? cur.split(/[\s,]+/).filter(Boolean) : [];
    if (tokens[tokens.length - 1] === code) return;
    tokens.push(code);
    inp.value = tokens.join(' ');
    state.drawnVia = null;  // invalida una posible ruta dibujada previa
    inp.classList.add('flash');
    setTimeout(() => inp.classList.remove('flash'), 500);
    showMapToast(`+ ${code} añadido a la Vía`);
  }

  // Mensaje flotante breve sobre el mapa (autodesaparece). Util para feedback
  // de acciones rapidas (anyadir waypoint a la Via desde el mapa).
  let mapToastTimer = null;
  function showMapToast(msg) {
    let el = $('#map-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'map-toast';
      el.className = 'map-toast';
      const mapEl = document.getElementById('map');
      if (mapEl) mapEl.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('visible');
    if (mapToastTimer) clearTimeout(mapToastTimer);
    mapToastTimer = setTimeout(() => el.classList.remove('visible'), 1600);
  }

  // ── Corte transversal ────────────────────────────────────────────────

  function renderCross() {
    const svg = $('#cross-svg');
    const empty = $('#cross-empty');
    const btn = $('#btn-download-cross');
    const info = $('#cross-info');

    const visible = getVisible();
    const opts = {
      plan: state.lastPlan || null,
      clouds: state.crossClouds || null,
    };
    let res;
    try {
      res = crossSection.render(svg, visible, opts);
    } catch (e) {
      console.error('[cross] render falló:', e);
      res = { ok: false, error: e.message };
    }
    if (res.ok) {
      empty.classList.add('hidden');
      svg.style.display = 'block';
      btn.disabled = false;
      const planTag = opts.plan ? ' · plan' : '';
      const cloudTag = opts.clouds ? ' · nubes' : '';
      info.textContent =
        `${res.extremes.A} → ${res.extremes.B} · ${res.distance.toFixed(1)} km · ` +
        `${res.panels} panel${res.panels === 1 ? '' : 'es'} · solapes: ${res.overlapCount}` +
        planTag + cloudTag;
    } else {
      empty.classList.remove('hidden');
      svg.style.display = 'none';
      btn.disabled = true;
      if (res.error) {
        info.textContent = 'Error renderizando corte (ver consola): ' + res.error;
      } else if (state.lastPlan) {
        info.textContent = 'Renderizando con el plan de vuelo…';
      } else if (visible.length === 0) {
        info.textContent = 'Calcula un plan o carga ≥2 TSAs para generar el corte';
      } else {
        info.textContent = 'Sólo 1 TSA visible y sin plan: necesitas ≥2 TSAs o un plan';
      }
    }
  }

  async function loadCrossClouds() {
    if (!meteoApi) { alert('Módulo meteo no disponible'); return; }
    if (!state.lastPlan || !state.lastPlan.coords || state.lastPlan.coords.length < 2) {
      alert('Necesitas un plan de vuelo calculado para muestrear nubes en la ruta.');
      return;
    }
    const btn = $('#btn-cross-clouds');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Cargando…';
    try {
      const pts = state.lastPlan.coords.map(c => ({ lat: c.lat, lon: c.lon }));
      state.crossClouds = await meteoApi.fetchCloudsForPoints(pts);
      $('#btn-cross-clouds-clear').disabled = false;
      renderCross();
    } catch (err) {
      console.error('[cross-clouds]', err);
      alert('No se pudo cargar la cobertura nubosa: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function clearCrossClouds() {
    state.crossClouds = null;
    $('#btn-cross-clouds-clear').disabled = true;
    renderCross();
  }

  // Resuelve los nombres devueltos por fetchGramet a {name,lat,lon} y los
  // envia a la capa del mapa. Para cada nombre busca primero en el catalogo
  // de aerovias (aeropuertos/NAVAIDs) y, si no aparece, intenta encontrar
  // un waypoint del plan con ese nombre.
  function pushGrametWaypointsToMap(names, strategy) {
    if (!names || !names.length) {
      mapView.clearGrametWaypoints();
      return;
    }
    const aw = window.TSAgestor.airways;
    const wpCatalog = (aw && aw.waypoints) || {};
    const planByName = new Map();
    if (state.lastPlan && state.lastPlan.coords) {
      for (const c of state.lastPlan.coords) {
        if (c.name && !planByName.has(c.name)) planByName.set(c.name, c);
      }
    }
    const items = [];
    for (const name of names) {
      let lat = null, lon = null, sourceName = null;
      const pt = wpCatalog[name];
      if (pt) {
        lat = pt[0]; lon = pt[1];
      } else if (planByName.has(name)) {
        const c = planByName.get(name);
        lat = c.lat; lon = c.lon; sourceName = name;
      }
      if (lat != null && lon != null) {
        items.push({ name, lat, lon, sourceName });
      }
    }
    mapView.setGrametWaypoints(items, { strategy });
  }

  async function loadGramet() {
    if (!meteoApi || !meteoApi.fetchGramet) {
      alert('Módulo meteo no disponible.');
      return;
    }
    if (!state.lastPlan) {
      alert('Necesitas un plan de vuelo calculado para generar el GRAMET.');
      return;
    }
    // Si el server-side tiene credenciales (AUTOROUTER_USER/PASS en env vars
    // de Cloudflare Pages), saltamos el modal y vamos directo a GRAMET.
    const serverAuth = meteoApi.checkServerAuth ? await meteoApi.checkServerAuth() : false;
    if (!serverAuth && !meteoApi.hasArCreds()) {
      showArLoginForm();
      return;
    }
    await actuallyFetchGramet();
  }

  async function actuallyFetchGramet() {
    const c = $('#gramet-container');
    const route = state.lastPlan.coords.map(co => co.name).join(' → ');
    const serverAuth = meteoApi.checkServerAuth ? await meteoApi.checkServerAuth() : false;
    const logoutBtn = serverAuth
      ? ''
      : `<button class="btn btn-ghost" type="button" id="btn-gramet-logout">Cerrar sesión Autorouter</button>`;
    c.innerHTML = `
      <div class="gramet-head">
        <h3>GRAMET — ${escapeHTML(state.lastPlan.origin)} → ${escapeHTML(state.lastPlan.destination)}</h3>
        <div class="gramet-actions">
          ${logoutBtn}
          <button class="btn btn-ghost" type="button" id="btn-gramet-close">Cerrar</button>
        </div>
      </div>
      <p class="hint">Ruta: ${escapeHTML(route)} · FL${state.lastPlan.flightLevel} · salida ${formatUTC(state.lastPlan.departureUTC)}</p>
      <div class="gramet-img-wrap">
        <div class="gramet-loading">Generando GRAMET…<br><span class="dim">puede tardar 10–30 s la primera vez</span></div>
      </div>
    `;
    c.classList.remove('hidden');
    c.querySelector('#btn-gramet-close').addEventListener('click', () => {
      c.classList.add('hidden');
      c.innerHTML = '';
      mapView.clearGrametWaypoints();
    });
    if (!serverAuth) {
      c.querySelector('#btn-gramet-logout').addEventListener('click', () => {
        meteoApi.clearStoredArAuth();
        c.classList.add('hidden');
        c.innerHTML = '';
        alert('Sesión de Autorouter cerrada. La próxima vez te pedirá las credenciales.');
      });
    }

    try {
      const result = await meteoApi.fetchGramet(state.lastPlan, 'png');
      const blob = result.blob;
      const url = URL.createObjectURL(blob);
      const wrap = c.querySelector('.gramet-img-wrap');
      const strategyLabel = {
        full:    { txt: 'Ruta completa', cls: 'gramet-strat-ok' },
        nearby:  { txt: 'Ruta aproximada (aeropuertos/NAVAIDs a ≤30 NM de la polilínea — ampliado a 60/100 NM si la ruta es offshore)', cls: 'gramet-strat-warn' },
        minimal: { txt: 'Solo origen → destino (gran círculo)', cls: 'gramet-strat-warn' },
      }[result.strategy] || { txt: result.strategy, cls: '' };
      const wpHtml = result.waypoints && result.waypoints.length
        ? result.waypoints.map(w => `<span class="gramet-wp">${escapeHTML(w)}</span>`).join(' → ')
        : '';
      wrap.innerHTML = `
        <div class="gramet-route ${strategyLabel.cls}">
          <div class="gramet-route-strategy">${escapeHTML(strategyLabel.txt)}</div>
          <div class="gramet-route-wps">${wpHtml}</div>
        </div>
        <img id="gramet-img" alt="GRAMET" src="${url}">
      `;
      // Añadimos enlace de descarga
      const dl = document.createElement('a');
      dl.href = url;
      dl.download = `gramet-${state.lastPlan.origin}-${state.lastPlan.destination}.png`;
      dl.className = 'btn btn-ghost';
      dl.textContent = 'Descargar PNG';
      const ref = c.querySelector('#btn-gramet-logout') || c.querySelector('#btn-gramet-close');
      c.querySelector('.gramet-actions').insertBefore(dl, ref);
      // Capa en el mapa con los waypoints efectivos enviados a Autorouter.
      ensureMap();
      pushGrametWaypointsToMap(result.waypoints, result.strategy);
    } catch (err) {
      console.error('[gramet]', err);
      const wrap = c.querySelector('.gramet-img-wrap');
      if (err.message === 'NO_CREDS') {
        showArLoginForm();
        return;
      }
      if (err.message === 'SERVER_NO_CREDS') {
        wrap.innerHTML = `<div class="plan-error">
          El servidor no tiene credenciales configuradas para Autorouter.
          <br><span class="dim">Configura <code>AUTOROUTER_USER</code> y <code>AUTOROUTER_PASS</code> en
          Cloudflare Pages → Settings → Environment Variables, y vuelve a desplegar.</span>
        </div>`;
        return;
      }
      if (err.message === 'BAD_CREDS' || err.message === 'TOKEN_REJECTED') {
        meteoApi.clearStoredArAuth();
        showArLoginForm('Credenciales rechazadas o tu cuenta no tiene acceso API habilitado.');
        return;
      }
      wrap.innerHTML = `<div class="plan-error">No se pudo generar el GRAMET: ${escapeHTML(err.message)}</div>`;
    }
  }

  function showArLoginForm(errorMsg) {
    const c = $('#gramet-container');
    c.classList.remove('hidden');
    c.innerHTML = `
      <div class="gramet-head"><h3>GRAMET — Acceso a Autorouter</h3></div>
      <p class="hint">
        El servicio GRAMET de autorouter.aero requiere cuenta y permiso API.
        Si no tienes una, regístrate en <a href="https://www.autorouter.aero" target="_blank" rel="noopener">autorouter.aero</a>
        y solicita acceso API enviando un ticket de soporte. Las credenciales se guardan
        en <code>sessionStorage</code> (se borran al cerrar el navegador).
      </p>
      ${errorMsg ? `<div class="plan-error">${escapeHTML(errorMsg)}</div>` : ''}
      <form id="ar-login-form" class="ar-login-form">
        <label>Email<input type="email" id="ar-email" required autocomplete="username"></label>
        <label>Contraseña<input type="password" id="ar-password" required autocomplete="current-password"></label>
        <div class="ar-login-actions">
          <button type="submit" class="btn btn-primary">Entrar y cargar GRAMET</button>
          <button type="button" class="btn btn-ghost" id="ar-cancel">Cancelar</button>
        </div>
      </form>
    `;
    const form = c.querySelector('#ar-login-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const email = c.querySelector('#ar-email').value.trim();
      const password = c.querySelector('#ar-password').value;
      if (!email || !password) return;
      meteoApi.setStoredArCreds(email, password);
      actuallyFetchGramet();
    });
    c.querySelector('#ar-cancel').addEventListener('click', () => {
      c.classList.add('hidden');
      c.innerHTML = '';
    });
  }

  async function downloadCrossPNG() {
    const svg = $('#cross-svg');
    try {
      const url = await crossSection.toPNGDataURL(svg, 2);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tsagestor-corte.png';
      a.click();
    } catch (err) {
      alert('No se pudo generar la imagen: ' + err.message);
    }
  }

  // ── Plan de vuelo ────────────────────────────────────────────────────

  function initPlanTab() {
    if (state.planWPsLoaded) return;
    const dl = $('#plan-wps');
    const names = (window.TSAgestor.airways && window.TSAgestor.airways.waypointNames) || {};
    for (const wp of flightPlan.listWaypoints()) {
      dl.appendChild(new Option(names[wp] || '', wp));
    }
    const dep = $('#plan-departure');
    if (!dep.value) {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      dep.value = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    }
    // Sobreescribe los defaults del HTML con los valores guardados en Ajustes.
    applySettingsToPlanForm();
    renderSavedPlansList();
    state.planWPsLoaded = true;
  }

  // ── Planes guardados ────────────────────────────────────────────────

  // Extrae las esperas (filas isHold) del plan actual como una lista
  // {afterIdx, afterName, holdMin}. afterIdx referencia el indice del
  // waypoint padre en la lista expandida; afterName se guarda como
  // fallback por si los indices se mueven al reconstruir el plan.
  function capturePlanHolds() {
    const holds = [];
    if (!state.lastPlan || !state.lastPlan.coords) return holds;
    const coords = state.lastPlan.coords;
    const overrides = (state.lastPlan.fuelOpts && state.lastPlan.fuelOpts.legOverrides) || [];
    for (let i = 1; i < coords.length; i++) {
      if (coords[i].isHold) {
        const ov = overrides[i] || {};
        holds.push({
          afterIdx: i - 1,
          afterName: coords[i - 1] ? coords[i - 1].name : null,
          holdMin: Number(ov.holdMin) || 0,
        });
      }
    }
    return holds;
  }

  // Captura los overrides editados a mano (velocidad y consumo por tramo)
  // de filas que NO sean holds. Los holds tienen su propio captureHolds.
  // Indexamos por posicion en coords sin holds, asi al recargar (tras
  // calcPlan que no tiene holds) podemos reaplicar directamente por idx.
  // El nombre del waypoint se guarda como verificacion: si la topologia
  // cambio (otras aerovias), saltamos el override.
  function capturePlanLegOverrides() {
    const out = [];
    if (!state.lastPlan || !state.lastPlan.coords) return out;
    const coords = state.lastPlan.coords;
    const ovs = (state.lastPlan.fuelOpts && state.lastPlan.fuelOpts.legOverrides) || [];
    let idxNoHold = -1;
    for (let i = 0; i < coords.length; i++) {
      if (coords[i].isHold) continue;
      idxNoHold++;
      const ov = ovs[i];
      if (!ov) continue;
      const clean = {};
      if (Number.isFinite(ov.speedKt))  clean.speedKt  = ov.speedKt;
      if (Number.isFinite(ov.fuelFlow)) clean.fuelFlow = ov.fuelFlow;
      if (Object.keys(clean).length === 0) continue;
      clean.idxNoHold = idxNoHold;
      clean.name      = coords[i].name;
      out.push(clean);
    }
    return out;
  }

  function capturePlanFormState() {
    // Snapshot de TSAs SELECCIONADAS para que el plan sea autocontenido:
    // al volver a cargarlo (mismo navegador o tras importar) se restauran
    // las TSAs con sus horarios/poligonos sin necesidad del PDF original.
    const sel = (state.tsas || []).filter(t => state.selected.has(t.id));
    return {
      origin:       $('#plan-origin').value.trim(),
      destination:  $('#plan-dest').value.trim(),
      flightLevel:  Number($('#plan-fl').value) || 0,
      speedKt:      Number($('#plan-speed').value) || 0,
      departureUTC: $('#plan-departure').value,
      via:          $('#plan-via').value,
      drawnVia:     state.drawnVia ? state.drawnVia.map(p => ({ name: p.name, lat: p.lat, lon: p.lon })) : null,
      fuelInitial:  Number($('#plan-fuel-initial').value) || 0,
      fuelFlow:     Number($('#plan-fuel-flow').value) || 0,
      fuelUnit:     $('#plan-fuel-unit').value,
      joker:        Number($('#plan-joker').value) || 0,
      bingo:        Number($('#plan-bingo').value) || 0,
      tsas:         sel.length ? sel : null,
      filter:       Object.assign({}, state.filter),
      holds:        capturePlanHolds(),
      legOverrides: capturePlanLegOverrides(),
    };
  }

  // Re-aplica los overrides de velocidad / consumo capturados por tramo
  // tras un calcPlan. Como aun no hay holds, los indices van directos.
  // Si la topologia cambio (otra aerovia, FL distinto que cambia sub-legs)
  // y el nombre no coincide, saltamos ese override.
  function applyPendingLegOverrides(list) {
    if (!list || !list.length) return;
    const plan = state.lastPlan;
    if (!plan || !plan.coords) return;
    plan.fuelOpts.legOverrides = plan.fuelOpts.legOverrides || [];
    for (const ov of list) {
      const i = Number(ov.idxNoHold);
      if (!Number.isFinite(i) || i < 0 || i >= plan.coords.length) continue;
      if (ov.name && plan.coords[i].name !== ov.name) continue;
      plan.fuelOpts.legOverrides[i] = plan.fuelOpts.legOverrides[i] || {};
      if (Number.isFinite(ov.speedKt))  plan.fuelOpts.legOverrides[i].speedKt  = ov.speedKt;
      if (Number.isFinite(ov.fuelFlow)) plan.fuelOpts.legOverrides[i].fuelFlow = ov.fuelFlow;
    }
  }

  // Re-inserta las esperas guardadas tras un calcPlan. Se ejecuta cuando
  // se carga (o importa) un plan que tenia holds: la lista se recibe
  // como `holds = [{afterIdx, afterName, holdMin}, ...]`. Procesamos en
  // orden inverso por afterIdx para que insertar uno no desplace los
  // siguientes en la cola.
  function applyPendingHolds(holds) {
    if (!holds || !holds.length) return;
    const plan = state.lastPlan;
    if (!plan || !plan.coords) return;
    const sorted = holds.slice().sort((a, b) =>
      (Number(b.afterIdx) || 0) - (Number(a.afterIdx) || 0));
    plan.fuelOpts.legOverrides = plan.fuelOpts.legOverrides || [];
    for (const h of sorted) {
      // Prefiere afterIdx si el nombre coincide (caso normal: misma
      // estructura tras calcPlan). Si no, cae al primer waypoint que
      // matche por nombre.
      let target = -1;
      if (Number.isFinite(h.afterIdx) && h.afterIdx >= 0 && h.afterIdx < plan.coords.length) {
        const c = plan.coords[h.afterIdx];
        if (c && !c.isHold && (!h.afterName || c.name === h.afterName)) {
          target = h.afterIdx;
        }
      }
      if (target < 0 && h.afterName) {
        target = plan.coords.findIndex(c => !c.isHold && c.name === h.afterName);
      }
      if (target < 0 || target >= plan.coords.length) continue;
      const ref = plan.coords[target];
      const holdCoord = {
        name: 'ESPERA en ' + (ref.name || ''),
        lat: ref.lat,
        lon: ref.lon,
        fl: ref.fl,
        airway: 'HOLD',
        tsa: null,
        isHold: true,
        cumDistKm: ref.cumDistKm,
        cumDistNM: ref.cumDistNM,
        legDistKm: 0,
        etaUTC: ref.etaUTC,
      };
      plan.coords.splice(target + 1, 0, holdCoord);
      plan.fuelOpts.legOverrides.splice(target + 1, 0, { holdMin: h.holdMin || 0 });
      if (Array.isArray(plan.fuelOpts.windsHourly)) {
        plan.fuelOpts.windsHourly.splice(target + 1, 0, plan.fuelOpts.windsHourly[target] || null);
      }
    }
    plan.fuel = flightPlan.buildFuelLog(plan.coords, plan.fuelOpts);
    renderFuelLog(plan.fuel);
    syncEtaUTCToCoords(plan);
    if (state.mapReady) mapView.renderFlightPlan(plan);
  }

  // Tras un roundtrip JSON.stringify/parse las fechas vienen como strings.
  // Las revive en cada schedule para que el resto del codigo siga
  // tratandolas como Date (calculo de ventana activa, conflictos, etc.).
  function reviveTsasFromJSON(tsas) {
    if (!Array.isArray(tsas)) return [];
    return tsas.map(t => {
      const out = Object.assign({}, t);
      if (Array.isArray(out.schedules)) {
        out.schedules = out.schedules.map(s => ({
          startUTC: s && s.startUTC ? (s.startUTC instanceof Date ? s.startUTC : new Date(s.startUTC)) : null,
          endUTC:   s && s.endUTC   ? (s.endUTC   instanceof Date ? s.endUTC   : new Date(s.endUTC))   : null,
          raw: s && s.raw,
        })).filter(s => s.startUTC && s.endUTC);
      }
      return out;
    });
  }

  function applyFilterToForm(f) {
    f = f || { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '' };
    $('#filter-date-from').value = f.dateFrom || '';
    $('#filter-date-to').value   = f.dateTo   || '';
    $('#filter-time-from').value = f.timeFrom || '';
    $('#filter-time-to').value   = f.timeTo   || '';
  }

  function applyPlanFormState(p) {
    if (!p) return;
    const setVal = (id, v) => { const el = $('#' + id); if (el && v != null && v !== '') el.value = v; };
    setVal('plan-origin',       p.origin);
    setVal('plan-dest',         p.destination);
    setVal('plan-fl',           p.flightLevel);
    setVal('plan-speed',        p.speedKt);
    setVal('plan-departure',    p.departureUTC);
    setVal('plan-via',          p.via);
    setVal('plan-fuel-initial', p.fuelInitial);
    setVal('plan-fuel-flow',    p.fuelFlow);
    setVal('plan-fuel-unit',    p.fuelUnit);
    setVal('plan-joker',        p.joker);
    setVal('plan-bingo',        p.bingo);
    state.drawnVia = (p.drawnVia && p.drawnVia.length) ? p.drawnVia : null;

    // Restaurar TSAs y filtro si el plan los trae (autocontenido).
    if (Array.isArray(p.tsas) && p.tsas.length) {
      state.tsas = reviveTsasFromJSON(p.tsas);
      sortTSAsByOriginProximity();
      state.selected = new Set(state.tsas.map(t => t.id));
      if (p.filter && typeof p.filter === 'object') {
        state.filter = Object.assign(
          { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '' }, p.filter
        );
        applyFilterToForm(state.filter);
      }
      $('#filter-bar').classList.remove('hidden');
      ensureMap();
      renderAll();
      setStatus(`${state.tsas.length} TSAs cargadas desde el plan.`, 'ok');
    }
  }

  function renderSavedPlansList() {
    if (!savedPlans) return;
    const container = $('#saved-plans-list');
    if (!container) return;
    const plans = savedPlans.list();
    if (!plans.length) {
      container.innerHTML = '<p class="hint" style="margin:0">No hay planes guardados todavía.</p>';
      return;
    }
    container.innerHTML = plans.map(p => {
      const meta = `${escapeHTML(p.origin || '?')} → ${escapeHTML(p.destination || '?')} · FL${p.flightLevel || '—'} · ${p.speedKt || '—'} kt`;
      const sub  = `Guardado: ${formatSavedDate(p.saved)}`;
      return `
        <div class="saved-plan">
          <div class="saved-plan-info">
            <b>${escapeHTML(p.name)}</b>
            <span class="dim">${meta}</span>
            <span class="dim">${sub}</span>
          </div>
          <div class="saved-plan-actions">
            <button class="btn btn-ghost" type="button" data-action="load"   data-name="${escapeHTML(p.name)}">Cargar</button>
            <button class="btn btn-ghost" type="button" data-action="export" data-name="${escapeHTML(p.name)}">Exportar</button>
            <button class="btn btn-ghost" type="button" data-action="del"    data-name="${escapeHTML(p.name)}">Borrar</button>
          </div>
        </div>`;
    }).join('');
  }

  function formatSavedDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (_) { return iso; }
  }

  function savePlanByName() {
    if (!savedPlans) return;
    const input = $('#saved-plan-name');
    const name = input.value.trim();
    if (!name) {
      alert('Indica un nombre para el plan antes de guardar.');
      input.focus();
      return;
    }
    if (savedPlans.has(name) && !confirm(`Ya existe un plan llamado "${name}". ¿Sobrescribir?`)) return;
    savedPlans.save(name, capturePlanFormState());
    input.value = '';
    renderSavedPlansList();
  }

  function loadPlanByName(name) {
    if (!savedPlans) return;
    const p = savedPlans.get(name);
    if (!p) return;
    applyPlanFormState(p);
    // Recalcula con los TSAs/meteo actuales. Despues, orden:
    //   1) reaplicar overrides de velocidad/consumo (idx en coords sin holds)
    //   2) reinyectar holds (que pueden anyadir entradas adicionales a
    //      legOverrides para los holdMin)
    //   3) reconstruir fuel log con todo aplicado.
    setTimeout(() => {
      calcPlan();
      const hasOverrides = Array.isArray(p.legOverrides) && p.legOverrides.length > 0;
      const hasHolds     = Array.isArray(p.holds) && p.holds.length > 0;
      if (!hasOverrides && !hasHolds) return;
      setTimeout(() => {
        if (hasOverrides) applyPendingLegOverrides(p.legOverrides);
        if (hasHolds) {
          applyPendingHolds(p.holds);   // ya hace buildFuelLog + renderFuelLog
        } else if (hasOverrides) {
          // Sin holds, rebuild para que los overrides se reflejen.
          const plan = state.lastPlan;
          if (plan && plan.coords) {
            plan.fuel = flightPlan.buildFuelLog(plan.coords, plan.fuelOpts);
            renderFuelLog(plan.fuel);
            syncEtaUTCToCoords(plan);
          }
        }
      }, 80);
    }, 50);
  }

  function deletePlanByName(name) {
    if (!savedPlans) return;
    if (!confirm(`¿Borrar el plan "${name}"?`)) return;
    savedPlans.remove(name);
    renderSavedPlansList();
  }

  function onSavedPlanListClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const name = btn.dataset.name;
    if (btn.dataset.action === 'load')         loadPlanByName(name);
    else if (btn.dataset.action === 'export')  exportPlanByName(name);
    else if (btn.dataset.action === 'del')     deletePlanByName(name);
  }

  // ── Export / import de planes guardados a JSON ─────────────────────

  // Sanitiza un nombre para usarlo como parte de un filename (espacios y
  // caracteres raros -> "_"). Mantiene letras/numeros/guion/punto.
  function sanitizeFilename(s) {
    return String(s || 'plan').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'plan';
  }

  // Descarga el plan dado en un .json autocontenido. Wrapping con _format
  // y _version para futura migracion si cambia el esquema interno.
  function exportPlanByName(name) {
    if (!savedPlans) return;
    const p = savedPlans.get(name);
    if (!p) { alert(`No se encuentra el plan "${name}".`); return; }
    const envelope = {
      _format: 'tsagestor-plan',
      _version: 1,
      exportedAt: new Date().toISOString(),
      plan: p,
    };
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 13);
    a.download = `tsagestor-plan-${sanitizeFilename(name)}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importPlanFromFile(file) {
    if (!savedPlans || !file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(reader.result); }
      catch (e) { alert('El archivo no es JSON válido: ' + e.message); return; }
      // Acepta envelope nuevo (_format) o un objeto plan plano (legacy).
      const plan = (parsed && parsed._format === 'tsagestor-plan' && parsed.plan) ? parsed.plan : parsed;
      if (!plan || typeof plan !== 'object' || (!plan.origin && !plan.destination && !plan.flightLevel)) {
        alert('El archivo no parece un plan exportado de TSAgestor.');
        return;
      }
      let name = String(plan.name || '').trim() || 'Plan importado';
      if (savedPlans.has(name)) {
        const ok = confirm(`Ya existe un plan llamado "${name}". ¿Sobrescribir? (Cancelar = guardar con otro nombre)`);
        if (!ok) {
          let i = 2;
          while (savedPlans.has(`${name} (${i})`)) i++;
          name = `${name} (${i})`;
        }
      }
      // Reusamos savedPlans.save() para que aplique nombre + fecha de guardado
      // y descartamos cualquier `name`/`saved` heredado.
      const data = Object.assign({}, plan);
      delete data.name; delete data.saved;
      savedPlans.save(name, data);
      renderSavedPlansList();
      alert(`Plan "${name}" importado correctamente.`);
    };
    reader.onerror = () => alert('No se pudo leer el archivo.');
    reader.readAsText(file, 'utf-8');
  }

  function onImportPlanFileChange(e) {
    const f = e.target.files && e.target.files[0];
    if (f) importPlanFromFile(f);
    e.target.value = ''; // permite re-seleccionar el mismo archivo despues
  }

  function calcPlan() {
    const origin = $('#plan-origin').value.trim();
    const destination = $('#plan-dest').value.trim();
    const fl = Number($('#plan-fl').value) || 350;
    const speedKt = Number($('#plan-speed').value) || 450;
    const depStr = $('#plan-departure').value;
    const departureUTC = depStr ? new Date(depStr + ':00Z') : new Date();
    // Si el usuario dibujó una ruta, los puntos enriquecidos prevalecen
    // sobre el contenido textual del campo Vía. En cuanto edite el campo,
    // state.drawnVia se invalida (ver wireSelection / cambio del input).
    let viaTokens;
    if (state.drawnVia && state.drawnVia.length) {
      viaTokens = state.drawnVia;
    } else {
      const viaRaw = $('#plan-via').value.trim();
      viaTokens = viaRaw ? viaRaw.split(/\s+/).filter(Boolean) : [];
    }

    if (!origin || !destination) {
      showPlanError('Indica origen y destino.');
      return;
    }

    const result = flightPlan.plan({
      origin, destination, flightLevel: fl, speedKt,
      departureUTC, tsas: getVisible(), via: viaTokens,
    });

    if (result.error) {
      showPlanError(result.error);
      state.lastPlan = null;
      if (state.mapReady) mapView.clearFlightPlan();
      return;
    }
    $('#plan-error').classList.add('hidden');

    // Cada recálculo del plan resetea los overrides por tramo (los waypoints
    // pueden haber cambiado). Los vientos cargados anteriormente también se
    // descartan (la ruta puede ser distinta y el FL puede haber cambiado).
    result.fuelOpts = {
      initialFuel:  $('#plan-fuel-initial').value,
      fuelFlow:     $('#plan-fuel-flow').value,
      speedKt,
      flightLevel:  fl,                                          // fallback para waypoints sin fl asignado
      jokerFuel:    $('#plan-joker').value,
      bingoFuel:    $('#plan-bingo').value,
      unit:         $('#plan-fuel-unit').value.trim() || 'kg',
      legOverrides: [],
      windsHourly:  null,
      windLevels:   null,                                        // niveles ISA disponibles tras fetch
      windSource:   null,
      departureUTC: result.departureUTC,
    };
    result.fuel = flightPlan.buildFuelLog(result.coords, result.fuelOpts);

    state.lastPlan = result;
    state.crossClouds = null;                                  // los puntos cambiaron
    $('#btn-cross-clouds-clear').disabled = true;
    renderPlanResults(result);
    ensureMap();
    mapView.renderFlightPlan(result);
    mapView.clearWeatherMarkers();
    $('#plan-meteo-content').innerHTML = '';
    $('#plan-meteo-count').textContent = '';
    renderCross();         // refresca el corte aunque no estemos en su pestaña
    refreshExportUI();
  }

  function showPlanError(msg) {
    const el = $('#plan-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    $('#plan-results').classList.add('hidden');
  }

  function clearPlan() {
    // Resultados y errores
    $('#plan-results').classList.add('hidden');
    $('#plan-error').classList.add('hidden');
    $('#plan-meteo-content').innerHTML = '';
    $('#plan-meteo-count').textContent = '';

    // Resetea los campos del formulario a los valores guardados en
    // Ajustes (o, si no, a los defaults del HTML).
    applySettingsToPlanForm();
    $('#plan-via').value = '';
    // Hora de salida → ahora UTC
    const dep = $('#plan-departure');
    if (dep) {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      dep.value = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    }

    // Estado interno
    state.lastPlan = null;
    state.drawnVia = null;
    state.crossClouds = null;
    $('#btn-cross-clouds-clear').disabled = true;

    // Capas del mapa relacionadas con plan/meteo
    if (state.mapReady) {
      mapView.clearFlightPlan();
      mapView.clearWeatherMarkers();
      mapView.clearGrametWaypoints();
    }

    // Panel GRAMET (si estaba abierto en pestaña Corte)
    const gc = $('#gramet-container');
    if (gc) {
      gc.classList.add('hidden');
      gc.innerHTML = '';
    }

    // Re-render del corte (ahora vacío) y resumen del export
    renderCross();
    refreshExportUI();
  }

  // ── Modo dibujo de ruta ─────────────────────────────────────────────

  function startDrawing() {
    const oRaw = $('#plan-origin').value.trim().toUpperCase();
    const dRaw = $('#plan-dest').value.trim().toUpperCase();
    if (!oRaw || !dRaw) {
      showPlanError('Indica origen y destino antes de dibujar la ruta.');
      return;
    }
    const wps = window.TSAgestor.airways && window.TSAgestor.airways.waypoints;
    const oPt = wps && wps[oRaw];
    const dPt = wps && wps[dRaw];
    if (!oPt || !dPt) {
      showPlanError('Origen o destino desconocido. Revisa los códigos antes de dibujar.');
      return;
    }
    $('#plan-error').classList.add('hidden');
    const fl = Number($('#plan-fl').value) || 350;
    ensureMap();
    switchTab('map');
    setTimeout(() => {
      mapView.invalidateSize();
      showDrawBanner();
      updateDrawCount(0);
      mapView.startDrawingRoute({
        origin: { name: oRaw, lat: oPt[0], lon: oPt[1] },
        destination: { name: dRaw, lat: dPt[0], lon: dPt[1] },
        // snapKm 3 -> radio pequeno (~1.5 NM): solo se imanta cuando
        // se clica EN el waypoint, no cerca. Ademas mapView solo aplica
        // el snap si al menos un overlay de aerovias esta activado.
        snapKm: 3,
        tsas: getVisible(),
        flightLevel: fl,
        onUpdate: pts => updateDrawCount(pts.length),
        onFinish: pts => finishDrawing(pts),
        onCancel: () => hideDrawBanner(),
      });
    }, 150);
  }

  function finishDrawing(points) {
    hideDrawBanner();
    // Guardamos los puntos enriquecidos para que flightPlan reciba la
    // posición exacta y el nombre original (TSA o waypoint), aunque el
    // campo de texto sólo muestre etiquetas legibles.
    state.drawnVia = points.map(p => ({
      name: p.name || (p.lat.toFixed(4) + ',' + p.lon.toFixed(4)),
      lat: p.lat,
      lon: p.lon,
    }));
    const display = state.drawnVia.map(p =>
      /^[A-Z]/.test(p.name) ? p.name : (p.lat.toFixed(4) + ',' + p.lon.toFixed(4))
    );
    $('#plan-via').value = display.join(' ');
    switchTab('plan');
    setTimeout(() => calcPlan(), 50);
  }

  function showDrawBanner() {
    $('#draw-banner').classList.remove('hidden');
  }
  function hideDrawBanner() {
    $('#draw-banner').classList.add('hidden');
  }
  function updateDrawCount(n) {
    $('#draw-banner-count').textContent = `${n} punto${n === 1 ? '' : 's'}`;
  }

  function renderPlanResults(p) {
    $('#plan-results').classList.remove('hidden');

    const summary = document.querySelector('.plan-summary');
    const directWarn = p.route.direct
      ? '<div class="plan-stat warn">⚠ Ruta directa: no se halló ruta por aerovías o resultaba >60 % más larga</div>'
      : '';
    summary.innerHTML = `
      <div class="plan-stat"><span class="lbl">Origen → Destino:</span> <b>${escapeHTML(p.origin)} → ${escapeHTML(p.destination)}</b></div>
      <div class="plan-stat"><span class="lbl">Distancia:</span> <b>${p.distanceNM.toFixed(1)} NM</b> <span class="dim">(${p.distanceKM.toFixed(0)} km)</span></div>
      <div class="plan-stat"><span class="lbl">Nivel:</span> <b>FL${p.flightLevel}</b></div>
      <div class="plan-stat"><span class="lbl">Velocidad:</span> <b>${p.speedKt} kt</b></div>
      <div class="plan-stat"><span class="lbl">Tiempo estimado:</span> <b>${formatDuration(p.timeMinutes)}</b></div>
      <div class="plan-stat"><span class="lbl">Salida UTC:</span> <b>${formatUTC(p.departureUTC)}</b></div>
      <div class="plan-stat"><span class="lbl">ETA UTC:</span> <b>${formatUTC(p.eta)}</b></div>
      ${directWarn}
    `;

    $('#plan-narrative-text').textContent = p.narrative;

    // Remarks: lista de TSAs sobrevoladas (sin duplicar en ida y vuelta).
    const remarks = (p.overflownTSAs || []).map(t => t.name);
    $('#plan-remarks-text').textContent = remarks.length ? remarks.join(', ') : '—';
    $('#plan-remarks-count').textContent = remarks.length;

    const ul = $('#plan-conflicts-list');
    ul.innerHTML = '';
    $('#plan-conflicts-count').textContent = p.conflicts.length;
    if (p.conflicts.length === 0) {
      const li = document.createElement('li');
      li.className = 'ok';
      li.textContent = 'Sin conflictos detectados a FL' + p.flightLevel + ' con la ventana de salida indicada.';
      ul.appendChild(li);
    } else {
      for (const c of p.conflicts) {
        const li = document.createElement('li');
        li.innerHTML = `
          <b>${escapeHTML(c.tsa.name)}</b> · ${escapeHTML(c.tsa.vertical.lowerLabel)} – ${escapeHTML(c.tsa.vertical.upperLabel)}
          <br><span class="dim">Segmento ${escapeHTML(wpDisplay(c.segment.from))} → ${escapeHTML(wpDisplay(c.segment.to))} (${escapeHTML(c.segment.airway || 'DCT')}) · paso aprox. ${formatUTC(c.tStart)} – ${formatUTC(c.tEnd)}</span>
        `;
        ul.appendChild(li);
      }
    }

    renderFuelLog(p.fuel);

    const tbody = $('#plan-coords-table tbody');
    tbody.innerHTML = '';
    const initialFL = p.flightLevel;
    // La tabla de ruta solo muestra waypoints reales. Las filas de espera
    // (isHold) son sinteticas y solo viven en el log de combustible.
    let displayIdx = 0;
    p.coords.forEach((c, i) => {
      if (c.isHold) return;
      displayIdx++;
      const tr = document.createElement('tr');
      const inTSA = !!c.tsa;
      const flText = c.fl != null
        ? (c.fl !== initialFL
            ? `<b class="fl-adj" title="Ajustado para librar TSA ${escapeHTML((c.tsa && c.tsa.name) || '')}">FL${c.fl}</b>`
            : `FL${c.fl}`)
        : '—';
      tr.className = inTSA ? 'in-tsa' : '';
      tr.innerHTML = `
        <td>${displayIdx}</td>
        <td><b>${escapeHTML(c.name)}</b></td>
        <td>${flText}</td>
        <td>${escapeHTML(c.airway)}</td>
        <td>${formatLat(c.lat)}</td>
        <td>${formatLon(c.lon)}</td>
        <td>${displayIdx === 1 ? '—' : (c.legDistKm / 1.852).toFixed(1)}</td>
        <td>${c.cumDistNM.toFixed(1)}</td>
        <td>${formatUTC(c.etaUTC)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Formatea el FL para mostrarlo junto al viento en la celda Wind del log.
  // Si flFrom == flTo, muestra " @FL250"; si difieren, " @FL080→FL250"
  // (waypoints en climb/descent o entrando a un sector TSA con FL adaptado).
  function formatWindFL(w) {
    if (!w || (w.flFrom == null && w.flTo == null)) return '';
    const fmt = fl => 'FL' + String(Math.round(fl)).padStart(3, '0');
    if (Number.isFinite(w.flFrom) && Number.isFinite(w.flTo) && w.flFrom !== w.flTo) {
      return ` @${fmt(w.flFrom)}→${fmt(w.flTo)}`;
    }
    const fl = Number.isFinite(w.flTo) ? w.flTo : w.flFrom;
    return ' @' + fmt(fl);
  }
  // Anyadido al tooltip: niveles ISA usados para interpolar el viento
  // y numero de sub-legs si el tramo cambia de FL >= 5000 ft.
  function windInterpHint(w) {
    if (!w) return '';
    let s = '';
    if (w.interpLo && w.interpHi) {
      s += w.interpLo === w.interpHi
        ? ` · viento ${w.interpLo} hPa`
        : ` · viento interp ${w.interpLo}↔${w.interpHi} hPa`;
    }
    if (w.nSubs && w.nSubs > 1) {
      s += ` · integrado en ${w.nSubs} sub-legs cada ≤5000 ft`;
    }
    return s;
  }

  function renderFuelLog(fuel) {
    if (!fuel) return;
    renderFuelSummary(fuel);

    const u = fuel.unit || '';
    const tbody = $('#plan-log-table tbody');
    tbody.innerHTML = '';
    for (const r of fuel.rows) {
      const tr = document.createElement('tr');
      tr.dataset.idx = String(r.index);
      tr.className = rowClass(r);
      const isFirst = r.index === 0;
      const isHold = !!r.isHold;
      // IAS / TAS / Flow:
      //   - IAS = input editable (velocidad indicada del piloto). El
      //     campo del override sigue siendo "speedKt" para compat con
      //     planes guardados.
      //   - TAS = calculada a partir de IAS + FL via geom.kiasToTAS
      //     (read-only). La muestra flightPlan en r.legSpeedKt.
      //   - Espera: ambas a "—". No hay TAS sin vuelo.
      const iasVal = Number.isFinite(r.legIAS) ? Math.round(r.legIAS) : '';
      const iasCell = (isFirst || isHold)
        ? '<td>—</td>'
        : `<td><input type="number" class="leg-input leg-vel" data-leg="${r.index}" data-field="speedKt" value="${iasVal}" min="50" max="900" step="5" title="Velocidad indicada (KIAS)"></td>`;
      const tasCell = (isFirst || isHold)
        ? '<td>—</td>'
        : `<td class="cell-tas" title="TAS calculada (tabla KIAS×altitud)">${Math.round(r.legSpeedKt)}</td>`;
      const flowCell = isFirst
        ? '<td>—</td>'
        : `<td><input type="number" class="leg-input leg-flow" data-leg="${r.index}" data-field="fuelFlow" value="${Math.round(r.legFuelFlow)}" min="0" step="10"></td>`;
      // Columna Espera:
      //   - Fila normal: boton "+E" para insertar una fila de hold despues.
      //   - Fila de hold: input editable + boton "✕" para borrarla.
      let holdCell;
      if (isHold) {
        const holdVal = Number.isFinite(r.holdMin) ? Math.round(r.holdMin) : 0;
        holdCell = `<td><input type="number" class="leg-input leg-hold" data-leg="${r.index}" data-field="holdMin" value="${holdVal}" min="0" max="999" step="1" title="Minutos de espera">
          <button type="button" class="btn-hold-del" data-leg="${r.index}" title="Eliminar espera">✕</button></td>`;
      } else {
        holdCell = `<td><button type="button" class="btn-hold-add" data-leg="${r.index}" title="Insertar fila de espera tras este waypoint">+ Espera</button></td>`;
      }
      const windText = isFirst || !r.wind
        ? '—'
        : `${String(Math.round(r.wind.dir)).padStart(3, '0')}/${Math.round(r.wind.speedKt)}` +
          formatWindFL(r.wind);
      const windCls = r.wind && r.wind.headwind > 5 ? 'wind-tail'
                    : r.wind && r.wind.headwind < -5 ? 'wind-head' : '';
      const windTooltip = r.wind && r.wind.atTime
        ? ` title="Pronóstico válido ${escapeHTML(r.wind.atTime)} · headwind ${r.wind.headwind > 0 ? '+' : ''}${Math.round(r.wind.headwind)} kt${windInterpHint(r.wind)}"`
        : '';
      const gsText = isFirst || r.legGS == null
        ? '—'
        : Math.round(r.legGS);
      const legTimeText = isFirst
        ? '—'
        : formatDuration(r.legTimeMin);
      // Filas de hold: marca visual + nombre con icono.
      if (isHold) tr.classList.add('hold-row');
      const nameHTML = isHold
        ? `<span class="hold-badge">⏱ ESPERA</span> <span class="dim">${escapeHTML(r.name.replace(/^ESPERA en\s+/, ''))}</span>`
        : `<b>${escapeHTML(r.name)}</b>`;
      tr.innerHTML = `
        <td>${r.index + 1}</td>
        <td>${nameHTML}</td>
        <td class="cell-leg-dist">${isFirst || isHold ? '—' : r.legDistNM.toFixed(1)}</td>
        ${iasCell}
        ${tasCell}
        <td class="cell-wind ${windCls}"${windTooltip}>${isHold ? '—' : windText}</td>
        <td class="cell-gs">${isHold ? '—' : gsText}</td>
        ${holdCell}
        <td class="cell-leg-time">${legTimeText}</td>
        <td class="cell-cum-time">${formatDuration(r.cumTimeMin)}</td>
        ${flowCell}
        <td class="cell-leg-fuel">${isFirst ? '—' : fmtFuel(r.legFuel) + ' ' + escapeHTML(u)}</td>
        <td class="cell-remaining"><b>${fmtFuel(r.remaining)} ${escapeHTML(u)}</b></td>
        <td class="cell-status">${statusLabel(r.status)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function renderFuelSummary(fuel) {
    const sumEl = $('#plan-log-summary');
    const u = fuel.unit || '';
    const finalCls = fuel.finalRemaining < 0 || (fuel.bingoFuel != null && fuel.finalRemaining <= fuel.bingoFuel)
      ? 'bingo'
      : (fuel.jokerFuel != null && fuel.finalRemaining <= fuel.jokerFuel ? 'joker' : 'ok');
    const warning = !fuel.reachesDestination
      ? '<span class="plan-log-warn"> ⚠ COMBUSTIBLE INSUFICIENTE para llegar al destino</span>'
      : '';
    sumEl.innerHTML = `
      <div class="plan-log-stat"><span class="lbl">Inicial:</span> <b>${fmtFuel(fuel.initialFuel)} ${escapeHTML(u)}</b></div>
      <div class="plan-log-stat"><span class="lbl">Consumo base:</span> <b>${fmtFuel(fuel.fuelFlow)} ${escapeHTML(u)}/h</b></div>
      <div class="plan-log-stat"><span class="lbl">Velocidad base:</span> <b>${fuel.defaultSpeedKt} kt</b></div>
      <div class="plan-log-stat"><span class="lbl">Total consumido:</span> <b>${fmtFuel(fuel.totalFuelUsed)} ${escapeHTML(u)}</b></div>
      <div class="plan-log-stat"><span class="lbl">Restante en destino:</span> <b class="${finalCls}">${fmtFuel(fuel.finalRemaining)} ${escapeHTML(u)}</b></div>
      <div class="plan-log-stat"><span class="lbl">Tiempo total:</span> <b>${formatDuration(fuel.totalTimeMin)}</b></div>
      ${fuel.hasWinds && fuel.windLevel ? `<div class="plan-log-stat"><span class="lbl">Vientos:</span> <b>FL${Math.round(fuel.windLevel.ft / 100)}</b> <span class="dim">(${fuel.windLevel.hPa} hPa · pronóstico Open-Meteo · look-up por ETA real de cada waypoint)</span></div>` : ''}
      ${fuel.jokerFuel != null ? `<div class="plan-log-stat"><span class="lbl">JOKER:</span> <b>${fmtFuel(fuel.jokerFuel)} ${escapeHTML(u)}</b>${fuel.firstJokerIdx != null ? ` <span class="dim">(en wpt #${fuel.firstJokerIdx + 1})</span>` : ''}</div>` : ''}
      ${fuel.bingoFuel != null ? `<div class="plan-log-stat"><span class="lbl">BINGO:</span> <b>${fmtFuel(fuel.bingoFuel)} ${escapeHTML(u)}</b>${fuel.firstBingoIdx != null ? ` <span class="dim">(en wpt #${fuel.firstBingoIdx + 1})</span>` : ''}</div>` : ''}
      ${warning}
    `;
  }

  function rowClass(r) {
    return r.status === 'bingo' ? 'row-bingo' : (r.status === 'joker' ? 'row-joker' : '');
  }
  function statusLabel(s) {
    return s === 'bingo' ? 'BINGO' : (s === 'joker' ? 'JOKER' : '—');
  }
  function fmtFuel(v) {
    return Math.round(v).toLocaleString('es-ES');
  }

  // Recompute en vivo cuando el usuario edita un input de Vel o Consumo en
  // la tabla. Actualiza sólo las celdas calculadas para no perder el foco.
  function onLegInputChange(e) {
    const inp = e.target;
    if (!inp.matches || !inp.matches('.leg-input')) return;
    const plan = state.lastPlan;
    if (!plan || !plan.fuelOpts) return;
    const idx = Number(inp.dataset.leg);
    const field = inp.dataset.field;
    const val = Number(inp.value);
    if (!Number.isFinite(val) || val < 0) return;
    plan.fuelOpts.legOverrides = plan.fuelOpts.legOverrides || [];
    plan.fuelOpts.legOverrides[idx] = plan.fuelOpts.legOverrides[idx] || {};
    plan.fuelOpts.legOverrides[idx][field] = val;
    plan.fuel = flightPlan.buildFuelLog(plan.coords, plan.fuelOpts);
    updateFuelLogInPlace(plan.fuel);
    syncEtaUTCToCoords(plan);
  }

  // Tras rebuild del fuel log, las ETAs cambian (cambio de velocidad /
  // hold / consumo afecta al tiempo de tramo). La tabla de waypoints
  // (#plan-coords-table) lee c.etaUTC, asi que hay que copiarlas desde
  // las filas recien construidas y refrescar las celdas en sitio para
  // no perder el foco del input que el usuario esta editando.
  function syncEtaUTCToCoords(plan) {
    if (!plan || !plan.fuel || !plan.coords) return;
    plan.fuel.rows.forEach((r, i) => {
      const c = plan.coords[i];
      if (c && r && r.etaUTC) c.etaUTC = r.etaUTC;
    });
    const wpBody = $('#plan-coords-table tbody');
    if (!wpBody) return;
    let row = 0;
    plan.coords.forEach((c) => {
      if (c.isHold) return;
      const tr = wpBody.rows[row++];
      if (tr && tr.cells && tr.cells[8]) tr.cells[8].textContent = formatUTC(c.etaUTC);
    });
  }

  // Inserta una fila de espera tras el waypoint `afterIdx`. La fila
  // sintetica clona la posicion (lat/lon, fl) del waypoint y arranca
  // con 15 min por defecto. Se reconstruye el log completo (filas y
  // numeracion) porque insertar afecta a indices y al mapa.
  function insertHoldRow(afterIdx) {
    const plan = state.lastPlan;
    if (!plan || !plan.coords) return;
    const ref = plan.coords[afterIdx];
    if (!ref) return;
    const DEFAULT_HOLD_MIN = 15;
    const holdCoord = {
      name: 'ESPERA en ' + (ref.name || ''),
      lat: ref.lat,
      lon: ref.lon,
      fl: ref.fl,
      airway: 'HOLD',
      tsa: null,
      isHold: true,
      cumDistKm: ref.cumDistKm,
      cumDistNM: ref.cumDistNM,
      legDistKm: 0,
      etaUTC: ref.etaUTC,
    };
    plan.coords.splice(afterIdx + 1, 0, holdCoord);
    plan.fuelOpts.legOverrides = plan.fuelOpts.legOverrides || [];
    plan.fuelOpts.legOverrides.splice(afterIdx + 1, 0, { holdMin: DEFAULT_HOLD_MIN });
    // Mantener vientos alineados: buildFuelLog descarta windsHourly si
    // su length != coords.length, asi que al insertar un coord hay que
    // insertar tambien una entrada en windsHourly (clonamos la del
    // waypoint anterior, que es la misma posicion fisica que el hold).
    if (Array.isArray(plan.fuelOpts.windsHourly)) {
      const cloned = plan.fuelOpts.windsHourly[afterIdx] || null;
      plan.fuelOpts.windsHourly.splice(afterIdx + 1, 0, cloned);
    }
    // Re-render completo: hay que recrear filas e indices, no basta in-place.
    plan.fuel = flightPlan.buildFuelLog(plan.coords, plan.fuelOpts);
    renderFuelLog(plan.fuel);
    syncEtaUTCToCoords(plan);
    // Refrescar el mapa (la polilinea/lista de waypoints no cambia, pero
    // recalculamos por consistencia con el resto del flujo).
    if (state.mapReady) mapView.renderFlightPlan(plan);
  }

  function removeHoldRow(idx) {
    const plan = state.lastPlan;
    if (!plan || !plan.coords || !plan.coords[idx] || !plan.coords[idx].isHold) return;
    plan.coords.splice(idx, 1);
    if (plan.fuelOpts.legOverrides) plan.fuelOpts.legOverrides.splice(idx, 1);
    if (Array.isArray(plan.fuelOpts.windsHourly)) {
      plan.fuelOpts.windsHourly.splice(idx, 1);
    }
    plan.fuel = flightPlan.buildFuelLog(plan.coords, plan.fuelOpts);
    renderFuelLog(plan.fuel);
    syncEtaUTCToCoords(plan);
    if (state.mapReady) mapView.renderFlightPlan(plan);
  }

  function onHoldButtonClick(e) {
    const addBtn = e.target.closest('.btn-hold-add');
    if (addBtn) {
      const idx = Number(addBtn.dataset.leg);
      if (Number.isFinite(idx)) insertHoldRow(idx);
      return;
    }
    const delBtn = e.target.closest('.btn-hold-del');
    if (delBtn) {
      const idx = Number(delBtn.dataset.leg);
      if (Number.isFinite(idx)) removeHoldRow(idx);
    }
  }

  // Refresca los valores calculados sin tocar los inputs ni recrear filas.
  function updateFuelLogInPlace(fuel) {
    renderFuelSummary(fuel);
    const u = fuel.unit || '';
    const tbody = $('#plan-log-table tbody');
    fuel.rows.forEach(r => {
      const tr = tbody.querySelector(`tr[data-idx="${r.index}"]`);
      if (!tr) return;
      tr.className = rowClass(r);
      const isFirst = r.index === 0;
      const tdLegTime = tr.querySelector('.cell-leg-time');
      const tdCumTime = tr.querySelector('.cell-cum-time');
      const tdLegFuel = tr.querySelector('.cell-leg-fuel');
      const tdRem     = tr.querySelector('.cell-remaining');
      const tdStatus  = tr.querySelector('.cell-status');
      const tdWind    = tr.querySelector('.cell-wind');
      const tdGS      = tr.querySelector('.cell-gs');
      if (tdLegTime) tdLegTime.textContent = isFirst ? '—' : formatDuration(r.legTimeMin);
      if (tdCumTime) tdCumTime.textContent = formatDuration(r.cumTimeMin);
      if (tdLegFuel) tdLegFuel.textContent = isFirst ? '—' : fmtFuel(r.legFuel) + ' ' + u;
      if (tdRem)     tdRem.innerHTML = `<b>${fmtFuel(r.remaining)} ${u ? escapeHTML(u) : ''}</b>`;
      if (tdStatus)  tdStatus.textContent = statusLabel(r.status);
      if (tdWind) {
        tdWind.textContent = (isFirst || !r.wind) ? '—'
          : `${String(Math.round(r.wind.dir)).padStart(3, '0')}/${Math.round(r.wind.speedKt)}` +
            formatWindFL(r.wind);
        tdWind.className = 'cell-wind ' + (
          r.wind && r.wind.headwind > 5 ? 'wind-tail'
          : r.wind && r.wind.headwind < -5 ? 'wind-head' : '');
      }
      if (tdGS) tdGS.textContent = (isFirst || r.legGS == null) ? '—' : Math.round(r.legGS);
      const tdTAS = tr.querySelector('.cell-tas');
      if (tdTAS) tdTAS.textContent = (isFirst || r.isHold) ? '—' : Math.round(r.legSpeedKt);
    });
  }

  // ── Meteo (METAR / TAF en aeropuertos cerca de la ruta) ────────────

  async function loadMeteo() {
    if (!meteoApi || !geom) return;
    if (!state.lastPlan) {
      alert('Calcula primero un plan de vuelo.');
      return;
    }
    const btn = $('#btn-plan-meteo');
    const content = $('#plan-meteo-content');
    btn.disabled = true;
    btn.textContent = 'Cargando…';
    content.innerHTML = '<p class="hint">Buscando aeropuertos cerca de la ruta…</p>';
    try {
      const radiusNM = Math.max(10, Number($('#plan-meteo-radius').value) || 50);
      const radiusKm = radiusNM * 1.852;
      const candidates = airportsNearRoute(state.lastPlan, radiusKm);
      if (!candidates.length) {
        content.innerHTML = '<p class="hint">No hay aeropuertos del listado a menos de ' + radiusNM + ' NM de la ruta.</p>';
        $('#plan-meteo-count').textContent = '0';
        mapView.clearWeatherMarkers();
        return;
      }
      content.innerHTML = `<p class="hint">Consultando AWC para ${candidates.length} aeropuerto${candidates.length === 1 ? '' : 's'}…</p>`;
      const result = await meteoApi.fetchWeatherForAirports(candidates.map(c => c.icao));
      const items = candidates.map(c => Object.assign({}, c, {
        metar: result.airports[c.icao] && result.airports[c.icao].metar,
        taf:   result.airports[c.icao] && result.airports[c.icao].taf,
      }));
      state.lastPlan.meteo = items;
      $('#plan-meteo-count').textContent = items.length;
      renderMeteo(items, result.errors);
      ensureMap();
      mapView.setWeatherMarkers(items);
      refreshExportUI();
    } catch (err) {
      console.error('[meteo]', err);
      content.innerHTML = `<p class="plan-error">Error: ${escapeHTML(err.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Recargar METAR / TAF';
    }
  }

  // Devuelve [{icao, lat, lon, name, distanceKm}] de los aeropuertos en
  // airways.waypoints que están a ≤ radiusKm de cualquier tramo de la ruta,
  // ordenados por proximidad.
  function airportsNearRoute(plan, radiusKm) {
    const aw = window.TSAgestor.airways;
    if (!aw || !plan || !plan.coords || plan.coords.length < 2) return [];
    const polyline = plan.coords.map(c => [c.lat, c.lon]);
    const names = aw.waypointNames || {};
    const out = [];
    for (const [icao, pt] of Object.entries(aw.waypoints)) {
      if (!/^[A-Z]{4}$/.test(icao)) continue; // solo códigos ICAO típicos
      const d = geom.pointToPolylineKm(pt, polyline);
      if (d <= radiusKm) {
        out.push({ icao, lat: pt[0], lon: pt[1], name: names[icao] || null, distanceKm: d });
      }
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
  }

  function renderMeteo(items, errors) {
    const content = $('#plan-meteo-content');
    let html = '';
    if (errors && (errors.metar || errors.taf)) {
      const parts = [];
      if (errors.metar) parts.push('METAR (' + errors.metar + ')');
      if (errors.taf) parts.push('TAF (' + errors.taf + ')');
      html += `<p class="meteo-warn">⚠ Algunos datos no llegaron: ${parts.join(' · ')}</p>`;
    }
    const dec = window.TSAgestor.metarDecode;
    html += '<div class="meteo-grid">';
    for (const it of items) {
      const m = it.metar, t = it.taf;
      const cat = (m && m.category) || '—';
      const metarDecoded = dec && m && m.raw ? dec.toHtmlList(dec.decodeMETAR(m.raw)) : '';
      const tafDecoded   = dec && t && t.raw ? dec.toHtmlList(dec.decodeTAF(t.raw))   : '';
      html += `
        <div class="meteo-card cat-${cat}">
          <div class="meteo-card-head">
            <b>${escapeHTML(it.icao)}</b>
            ${it.name ? `<span class="dim">· ${escapeHTML(it.name)}</span>` : ''}
            <span class="meteo-cat-badge cat-${cat}">${cat}</span>
            <span class="dim meteo-dist">${(it.distanceKm / 1.852).toFixed(0)} NM</span>
          </div>
          <div class="meteo-section">
            <span class="lbl">METAR</span>
            <pre>${escapeHTML((m && m.raw) || '— sin datos —')}</pre>
            ${metarDecoded}
          </div>
          <div class="meteo-section">
            <span class="lbl">TAF</span>
            <pre>${escapeHTML((t && t.raw) || '— sin datos —')}</pre>
            ${tafDecoded}
          </div>
        </div>`;
    }
    html += '</div>';
    content.innerHTML = html;
  }

  // ── Vientos en altura (Open-Meteo) ──────────────────────────────────

  async function loadWinds() {
    if (!meteoApi || !meteoApi.fetchWindsAloft) {
      alert('Módulo meteo no disponible.');
      return;
    }
    if (!state.lastPlan || !state.lastPlan.coords || state.lastPlan.coords.length < 2) {
      alert('Necesitas un plan calculado para muestrear vientos en ruta.');
      return;
    }
    const btn = $('#btn-plan-winds');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Cargando…';
    try {
      const pts = state.lastPlan.coords.map(c => ({ lat: c.lat, lon: c.lon }));
      const result = await meteoApi.fetchWindsAloft(pts);
      if (!result.pointsHourly || !result.pointsHourly.length) {
        alert('Open-Meteo no devolvió datos de viento.');
        return;
      }
      // Guardamos pronosticos en TODOS los niveles ISA: el cálculo del log
      // interpola por FL Y por ETA en cada waypoint, asi origen/destino
      // (GND) usan viento de superficie y los wp cruise el viento a su FL.
      state.lastPlan.fuelOpts.windsHourly = result.pointsHourly;
      state.lastPlan.fuelOpts.windLevels  = result.levels;
      state.lastPlan.fuelOpts.windSource  = result.source;
      state.lastPlan.fuel = flightPlan.buildFuelLog(state.lastPlan.coords, state.lastPlan.fuelOpts);
      renderFuelLog(state.lastPlan.fuel);
      const flsCovered = result.levels && result.levels.length
        ? `${result.levels.length} niveles ISA (FL${Math.round(result.levels[0].ft/100)}–FL${Math.round(result.levels[result.levels.length-1].ft/100)})`
        : '—';
      console.log(`[meteo] Vientos ${result.source} cargados: ${flsCovered}. Interpolacion por ETA y FL en cada waypoint.`);
    } catch (err) {
      console.error('[winds]', err);
      alert('No se pudieron cargar los vientos: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function copyText(text, btnSel) {
    if (!text) return;
    if (!navigator.clipboard) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
    } else {
      navigator.clipboard.writeText(text);
    }
    const btn = $(btnSel);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '¡Copiado!';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  function copyNarrative() {
    if (!state.lastPlan) return;
    copyText(state.lastPlan.narrative, '#btn-plan-copy');
  }

  function copyRemarks() {
    if (!state.lastPlan) return;
    const list = (state.lastPlan.overflownTSAs || []).map(t => t.name);
    copyText(list.join(', '), '#btn-plan-remarks-copy');
  }

  function formatDuration(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}min` : `${m} min`;
  }

  // Convierte lat/lon a formato OACI compacto DDMM[N|S]DDDMM[E|W]
  // (3853N00649W). Replicamos la logica de flightPlan.formatICAOCoord
  // localmente para no exponer otra funcion del modulo.
  function icaoCoord(lat, lon) {
    const fmt = (v, deg, pos, neg) => {
      const sign = v >= 0 ? pos : neg;
      const a = Math.abs(v);
      const d = Math.floor(a);
      const m = Math.round((a - d) * 60);
      const dd = m === 60 ? d + 1 : d;
      const mm = m === 60 ? 0 : m;
      return String(dd).padStart(deg, '0') + String(mm).padStart(2, '0') + sign;
    };
    return fmt(lat, 2, 'N', 'S') + fmt(lon, 3, 'E', 'W');
  }

  // Nombre legible de un waypoint del plan: misma logica que
  // flightPlan.buildNarrative -- aeropuertos/NAVAIDs/RNAVs por nombre,
  // puntos sin nombre o cuya etiqueta es la TSA en la que cayeron al
  // dibujar -> coordenada DMS compacta.
  function wpDisplay(wp) {
    if (!wp) return '—';
    const isDecimalCoords = /^-?\d+\.\d+,-?\d+\.\d+$/.test(wp.name || '');
    if (!wp.name || isDecimalCoords) return icaoCoord(wp.lat, wp.lon);
    if (wp.tsa && wp.name === wp.tsa.name) return icaoCoord(wp.lat, wp.lon);
    return wp.name;
  }
  function formatUTC(d) {
    if (!d) return '—';
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
  }
  function formatLat(v) {
    const sign = v >= 0 ? 'N' : 'S';
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return String(d).padStart(2, '0') + '°' + m.toFixed(1).padStart(4, '0') + "'" + sign;
  }
  function formatLon(v) {
    const sign = v >= 0 ? 'E' : 'W';
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return String(d).padStart(3, '0') + '°' + m.toFixed(1).padStart(4, '0') + "'" + sign;
  }

  // ── Exportar PDF ─────────────────────────────────────────────────────

  function refreshExportUI() {
    const visible = getVisible();
    const n = visible.length;
    const hasPlan = !!state.lastPlan;
    const btn = $('#btn-export-pdf');
    const hint = $('#export-hint');
    const summary = $('#export-summary');
    btn.disabled = !hasPlan && n === 0;

    const parts = [];
    if (hasPlan) parts.push(`Plan de vuelo ${state.lastPlan.origin} → ${state.lastPlan.destination}`);
    if (hasPlan && state.lastPlan.fuel) parts.push('log de combustible');
    if (hasPlan && state.lastPlan.meteo && state.lastPlan.meteo.length) {
      parts.push(`METAR/TAF de ${state.lastPlan.meteo.length} aeropuertos`);
    }
    if (n > 0) parts.push(`${n} TSAs filtradas`);
    if (n >= 2) parts.push('corte transversal');

    summary.textContent = parts.length === 0
      ? 'Carga un documento NOTAM o calcula un plan de vuelo para empezar.'
      : 'El PDF incluirá: ' + parts.join(', ') + '.';

    hint.textContent = btn.disabled
      ? 'Necesitas al menos un plan de vuelo o TSAs visibles.'
      : 'Pulsa Generar PDF para descargar el informe completo.';
  }

  async function exportPDF() {
    const svg = $('#cross-svg');
    const btn = $('#btn-export-pdf');
    const visible = getVisible();
    btn.disabled = true;
    btn.textContent = 'Generando…';
    try {
      // Asegura que el SVG del corte esté actualizado aunque la pestaña no se
      // haya visitado. CRÍTICO: pasamos plan + clouds en opts. Sin ello, el
      // SVG en el DOM se regeneraba SIN el plan tras cada exportación, lo que
      // luego hacia que el corte en pantalla apareciese sin la ruta hasta
      // cambiar de pestaña, y el PDF nunca incluia la ruta dibujada.
      const hasContent = visible.length >= 2 || !!state.lastPlan;
      if (hasContent) {
        crossSection.render(svg, visible, {
          plan:   state.lastPlan || null,
          clouds: state.crossClouds || null,
        });
      }
      const fname = await pdfExport.exportReport({
        tsas: visible,
        filterState: state.filter,
        svgEl: hasContent ? svg : null,
        plan: state.lastPlan,
      });
      console.log('[TSAgestor] PDF generado:', fname);
    } catch (err) {
      console.error(err);
      alert('Error al generar el PDF: ' + err.message);
    } finally {
      const after = getVisible();
      btn.disabled = !state.lastPlan && after.length === 0;
      btn.textContent = 'Generar PDF';
    }
  }

  // ── Pipelines de render ──────────────────────────────────────────────

  function renderViews() {
    const visible = getVisible();
    if (state.mapReady) {
      mapView.render(visible);
      // Refresca el contenido de la leyenda flotante si esta activa.
      if (state.legendOpen && mapView.updateLegend) mapView.updateLegend(visible);
    }
    renderCross();
    refreshExportUI();
  }

  function renderAll() {
    renderTable();
    renderViews();
  }

  // ── Bootstrap ────────────────────────────────────────────────────────

  function wireTabs() {
    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function wireFilter() {
    $('#btn-filter-apply').addEventListener('click', applyFilter);
    $('#btn-filter-clear').addEventListener('click', clearFilter);
  }

  function wireActions() {
    $('#btn-fit-bounds').addEventListener('click', () => mapView.fitBounds());
    $('#btn-map-legend').addEventListener('click', toggleMapLegend);
    $('#btn-map-layers').addEventListener('click', toggleMapLayersControl);
    $('#btn-download-cross').addEventListener('click', downloadCrossPNG);
    $('#btn-export-pdf').addEventListener('click', exportPDF);
    $('#btn-plan-calc').addEventListener('click', calcPlan);
    $('#btn-plan-clear').addEventListener('click', clearPlan);
    $('#btn-plan-copy').addEventListener('click', copyNarrative);
    $('#btn-plan-remarks-copy').addEventListener('click', copyRemarks);
    $('#btn-plan-draw').addEventListener('click', startDrawing);
    $('#plan-via').addEventListener('input', () => { state.drawnVia = null; });
    $('#plan-log-table tbody').addEventListener('input', onLegInputChange);
    $('#plan-log-table tbody').addEventListener('click', onHoldButtonClick);
    $('#btn-draw-undo').addEventListener('click', () => mapView.undoDrawingPoint());
    $('#btn-draw-return').addEventListener('click', () => mapView.addReturnLeg());
    $('#btn-draw-finish').addEventListener('click', () => mapView.finishDrawingRoute());
    $('#btn-draw-cancel').addEventListener('click', () => {
      mapView.cancelDrawingRoute();
      hideDrawBanner();
    });
    $('#btn-plan-meteo').addEventListener('click', loadMeteo);
    $('#btn-plan-winds').addEventListener('click', loadWinds);
    $('#btn-save-plan').addEventListener('click', savePlanByName);
    $('#saved-plan-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); savePlanByName(); }
    });
    $('#saved-plans-list').addEventListener('click', onSavedPlanListClick);
    $('#btn-import-plan').addEventListener('click', () => $('#file-import-plan').click());
    $('#file-import-plan').addEventListener('change', onImportPlanFileChange);
    $('#btn-cross-clouds').addEventListener('click', loadCrossClouds);
    $('#btn-cross-clouds-clear').addEventListener('click', clearCrossClouds);
    $('#btn-cross-gramet').addEventListener('click', loadGramet);
  }

  // Modal de bienvenida — se muestra una vez por sesión hasta que el
  // usuario acepta el aviso de seguridad y la nota de acceso.
  const WELCOME_KEY = 'tsagestor_welcome_accepted';
  function showWelcomeIfNeeded() {
    const modal = document.getElementById('welcome-modal');
    if (!modal) return;
    const accepted = sessionStorage.getItem(WELCOME_KEY) === '1';
    if (accepted) {
      modal.classList.add('hidden');
      return;
    }
    modal.classList.remove('hidden');
    document.body.classList.add('welcome-open');
    const check = document.getElementById('welcome-check');
    const btn = document.getElementById('welcome-accept');
    if (check && btn) {
      check.checked = false;
      btn.disabled = true;
      check.addEventListener('change', () => { btn.disabled = !check.checked; });
      btn.addEventListener('click', () => {
        if (!check.checked) return;
        sessionStorage.setItem(WELCOME_KEY, '1');
        modal.classList.add('hidden');
        document.body.classList.remove('welcome-open');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    showWelcomeIfNeeded();
    if (settings) settings.load();
    applySettingsToPlanForm();
    wireTabs();
    wireUpload();
    wireFilter();
    wireActions();
    wireSelection();
    refreshExportUI();
    console.log('[TSAgestor] listo.');
  });
})();
