// Controlador principal: navegación por pestañas, estado, wiring de UI.
//
// Visibilidad en Mapa / Corte / PDF = TSAs SELECCIONADAS ∩ TSAs QUE PASAN EL FILTRO.

(function () {
  'use strict';

  const { parser, filters, mapView, crossSection, pdfExport, geom, scheduleFmt } = window.TSAgestor;

  const state = {
    tsas: [],                                                 // todas las parseadas
    selected: new Set(),                                       // ids seleccionadas por el usuario
    filter: { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '' },
    mapReady: false,
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
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-content').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'map' && state.mapReady) {
      setTimeout(() => mapView.invalidateSize(), 50);
      mapView.render(getVisible());
    }
    if (name === 'cross') renderCross();
    if (name === 'export') refreshExportUI();
  }

  // ── Tabla de TSAs ────────────────────────────────────────────────────

  function renderTable() {
    const tbody = $('#tsa-table tbody');
    tbody.innerHTML = '';

    for (const t of state.tsas) {
      const inFilter  = filters.matches(t, state.filter);
      const isSelected = state.selected.has(t.id);
      const schedHTML = `
        <details class="sched-details">
          <summary>${escapeHTML(scheduleFmt.summary(t.schedules))}</summary>
          <div class="sched-list">${scheduleFmt.listHTML(t.schedules)}</div>
        </details>`;

      const tr = document.createElement('tr');
      tr.className = 'tsa-row' + (inFilter ? '' : ' out-of-filter') + (isSelected ? ' selected' : '');
      tr.dataset.id = t.id;
      tr.innerHTML = `
        <td class="col-check">
          <input type="checkbox" class="tsa-check" data-id="${escapeHTML(t.id)}"${isSelected ? ' checked' : ''}>
        </td>
        <td><b>${escapeHTML(t.name)}</b></td>
        <td>${t.format}</td>
        <td>${escapeHTML(t.vertical.lowerLabel)}</td>
        <td>${escapeHTML(t.vertical.upperLabel)}</td>
        <td>${t.polygon.length}</td>
        <td>${schedHTML}</td>
      `;
      tbody.appendChild(tr);
    }

    $('#tsa-count').textContent = state.tsas.length;
    $('#tsa-table-wrap').classList.toggle('hidden', state.tsas.length === 0);
    refreshSelectionUI();
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

  async function handleFile(file) {
    if (!file) return;
    setStatus(`Procesando ${file.name}…`, 'info');
    try {
      const tsas = await parser.parseFile(file);
      state.tsas = tsas;
      state.selected = new Set(tsas.map(t => t.id)); // por defecto todas
      state.filter = readFilter();
      if (tsas.length === 0) {
        setStatus('No se han encontrado TSAs en el documento.', 'error');
      } else {
        setStatus(`${tsas.length} TSAs detectadas.`, 'ok');
      }
      $('#filter-bar').classList.remove('hidden');
      ensureMap();
      populateRangeSelects();
      renderAll();
    } catch (err) {
      console.error(err);
      setStatus('Error al procesar el archivo: ' + err.message, 'error');
    }
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
  }

  // ── Selección ────────────────────────────────────────────────────────

  function wireSelection() {
    // Delegación para los checkboxes de fila.
    $('#tsa-table tbody').addEventListener('change', e => {
      const cb = e.target.closest('.tsa-check');
      if (!cb) return;
      const id = cb.dataset.id;
      if (cb.checked) state.selected.add(id);
      else state.selected.delete(id);
      const row = cb.closest('tr');
      if (row) row.classList.toggle('selected', cb.checked);
      refreshSelectionUI();
      renderViews();
    });

    $('#tsa-select-all-cb').addEventListener('change', e => {
      if (e.target.checked) selectAll();
      else selectNone();
    });

    $('#btn-select-all').addEventListener('click', selectAll);
    $('#btn-select-none').addEventListener('click', selectNone);
    $('#btn-select-between').addEventListener('click', selectBetween);
    $('#select-from').addEventListener('change', updateRangeButton);
    $('#select-to').addEventListener('change', updateRangeButton);
  }

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

  // Selecciona todas las TSAs cuyo centroide proyectado en la geodésica
  // (centroide A → centroide B) cae dentro del segmento [0, |AB|], con
  // un margen de tolerancia para incluir los extremos sin recortes.
  function selectBetween() {
    const idA = $('#select-from').value;
    const idB = $('#select-to').value;
    if (!idA || !idB || idA === idB) return;
    const A = state.tsas.find(t => t.id === idA);
    const B = state.tsas.find(t => t.id === idB);
    if (!A || !B) return;
    const dAB = geom.greatCircleDistance(A.centroid, B.centroid);
    const tol = Math.max(5, dAB * 0.02); // 2 % o 5 km mínimo
    const next = new Set();
    for (const t of state.tsas) {
      if (t.id === idA || t.id === idB) { next.add(t.id); continue; }
      const along = geom.alongTrackDistance(A.centroid, B.centroid, t.centroid);
      if (along >= -tol && along <= dAB + tol) next.add(t.id);
    }
    state.selected = next;
    renderTable();
    renderViews();
  }

  function populateRangeSelects() {
    const from = $('#select-from'), to = $('#select-to');
    from.innerHTML = '<option value="">—</option>';
    to.innerHTML   = '<option value="">—</option>';
    for (const t of state.tsas) {
      from.appendChild(new Option(t.name, t.id));
      to.appendChild(new Option(t.name, t.id));
    }
    updateRangeButton();
  }

  function updateRangeButton() {
    const a = $('#select-from').value;
    const b = $('#select-to').value;
    $('#btn-select-between').disabled = !a || !b || a === b;
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
    applyFilter();
  }

  // ── Mapa ─────────────────────────────────────────────────────────────

  function ensureMap() {
    if (state.mapReady) return;
    mapView.init('map');
    state.mapReady = true;
  }

  // ── Corte transversal ────────────────────────────────────────────────

  function renderCross() {
    const svg = $('#cross-svg');
    const empty = $('#cross-empty');
    const btn = $('#btn-download-cross');
    const info = $('#cross-info');

    const visible = getVisible();
    const res = crossSection.render(svg, visible);
    if (res.ok) {
      empty.classList.add('hidden');
      svg.style.display = 'block';
      btn.disabled = false;
      info.textContent =
        `${res.extremes.A} → ${res.extremes.B} · ${res.distance.toFixed(1)} km · ` +
        `${res.panels} panel${res.panels === 1 ? '' : 'es'} · solapes: ${res.overlapCount}`;
    } else {
      empty.classList.remove('hidden');
      svg.style.display = 'none';
      btn.disabled = true;
      info.textContent = visible.length === 0
        ? 'No hay TSAs visibles (revisa selección y filtro)'
        : 'Sólo hay 1 TSA visible: selecciona al menos 2 para generar el corte';
    }
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

  // ── Exportar PDF ─────────────────────────────────────────────────────

  function refreshExportUI() {
    const visible = getVisible();
    const n = visible.length;
    const btn = $('#btn-export-pdf');
    const hint = $('#export-hint');
    const summary = $('#export-summary');
    btn.disabled = n === 0;
    summary.textContent =
      (state.tsas.length === 0
        ? 'Carga un documento NOTAM para empezar.'
        : `${n} TSAs se incluirán en el informe (${state.selected.size} seleccionadas).\n` +
          `Filtro: ${filters.summaryText(state.filter)}`);
    hint.textContent = n === 0
      ? 'Selecciona TSAs y ajusta el filtro para habilitar la exportación.'
      : 'Se generará un PDF con la tabla y el corte transversal.';
  }

  async function exportPDF() {
    const svg = $('#cross-svg');
    const btn = $('#btn-export-pdf');
    const visible = getVisible();
    btn.disabled = true;
    btn.textContent = 'Generando…';
    try {
      // Asegura que el SVG del corte esté actualizado aunque la pestaña no se haya visitado.
      crossSection.render(svg, visible);
      const fname = await pdfExport.exportReport(visible, state.filter, svg);
      console.log('[TSAgestor] PDF generado:', fname);
    } catch (err) {
      console.error(err);
      alert('Error al generar el PDF: ' + err.message);
    } finally {
      btn.disabled = getVisible().length === 0;
      btn.textContent = 'Generar PDF';
    }
  }

  // ── Pipelines de render ──────────────────────────────────────────────

  function renderViews() {
    if (state.mapReady) mapView.render(getVisible());
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
    $('#btn-download-cross').addEventListener('click', downloadCrossPNG);
    $('#btn-export-pdf').addEventListener('click', exportPDF);
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireTabs();
    wireUpload();
    wireFilter();
    wireActions();
    wireSelection();
    refreshExportUI();
    console.log('[TSAgestor] listo.');
  });
})();
