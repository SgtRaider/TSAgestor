// Controlador principal: navegación por pestañas, estado, wiring de UI.

(function () {
  'use strict';

  const { parser, filters, mapView, crossSection, pdfExport } = window.TSAgestor;

  const state = {
    tsas: [],
    filtered: [],
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

  // ── Tabs ─────────────────────────────────────────────────────────────

  function switchTab(name) {
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-content').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'map' && state.mapReady) {
      setTimeout(() => mapView.invalidateSize(), 50);
      mapView.render(state.filtered);
    }
    if (name === 'cross') renderCross();
    if (name === 'export') refreshExportUI();
  }

  // ── Tabla de TSAs ────────────────────────────────────────────────────

  function renderTable(tsas) {
    const tbody = $('#tsa-table tbody');
    tbody.innerHTML = '';
    for (const t of tsas) {
      const schedTxt = t.schedules.slice(0, 4).map(s =>
        `${s.startUTC.toISOString().slice(0, 10)} ` +
        `${s.startUTC.toISOString().slice(11, 16)}Z–${s.endUTC.toISOString().slice(11, 16)}Z`
      ).join('<br>') + (t.schedules.length > 4 ? `<br><i>+${t.schedules.length - 4}</i>` : '');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${escapeHTML(t.name)}</b></td>
        <td>${t.format}</td>
        <td>${escapeHTML(t.vertical.lowerLabel)}</td>
        <td>${escapeHTML(t.vertical.upperLabel)}</td>
        <td>${t.polygon.length}</td>
        <td>${schedTxt}</td>
      `;
      tbody.appendChild(tr);
    }
    $('#tsa-count').textContent = tsas.length;
    $('#tsa-table-wrap').classList.toggle('hidden', tsas.length === 0);
  }

  // ── Carga de archivo ─────────────────────────────────────────────────

  async function handleFile(file) {
    if (!file) return;
    setStatus(`Procesando ${file.name}…`, 'info');
    try {
      const tsas = await parser.parseFile(file);
      state.tsas = tsas;
      applyFilter();
      if (tsas.length === 0) {
        setStatus('No se han encontrado TSAs en el documento.', 'error');
      } else {
        setStatus(`${tsas.length} TSAs detectadas.`, 'ok');
      }
      $('#filter-bar').classList.remove('hidden');
      ensureMap();
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
      fileInput.value = ''; // permite re-seleccionar mismo archivo
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
    state.filtered = filters.filter(state.tsas, state.filter);
    $('#filter-summary').textContent =
      `${state.filtered.length} de ${state.tsas.length} TSAs · ${filters.summaryText(state.filter)}`;
    renderTable(state.filtered);
    if (state.mapReady) mapView.render(state.filtered);
    renderCross();
    refreshExportUI();
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
    mapView.render(state.filtered);
  }

  // ── Corte transversal ────────────────────────────────────────────────

  function renderCross() {
    const svg = $('#cross-svg');
    const empty = $('#cross-empty');
    const btn = $('#btn-download-cross');
    const info = $('#cross-info');

    const res = crossSection.render(svg, state.filtered);
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
      info.textContent = state.filtered.length
        ? 'Una sola TSA tras el filtro'
        : 'Sin TSAs tras el filtro';
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
    const n = state.filtered.length;
    const btn = $('#btn-export-pdf');
    const hint = $('#export-hint');
    const summary = $('#export-summary');
    btn.disabled = n === 0;
    summary.textContent =
      (state.tsas.length === 0
        ? 'Carga un documento NOTAM para empezar.'
        : `${n} TSAs se incluirán en el informe.\nFiltro: ${filters.summaryText(state.filter)}`);
    hint.textContent = n === 0
      ? 'Carga un documento y ajusta el filtro para habilitar la exportación.'
      : 'Se generará un PDF con la tabla y el corte transversal.';
  }

  async function exportPDF() {
    const svg = $('#cross-svg');
    const btn = $('#btn-export-pdf');
    btn.disabled = true;
    btn.textContent = 'Generando…';
    try {
      // Asegura que el SVG del corte esté actualizado aunque la pestaña no se haya visitado.
      crossSection.render(svg, state.filtered);
      const fname = await pdfExport.exportReport(state.filtered, state.filter, svg);
      console.log('[TSAgestor] PDF generado:', fname);
    } catch (err) {
      console.error(err);
      alert('Error al generar el PDF: ' + err.message);
    } finally {
      btn.disabled = state.filtered.length === 0;
      btn.textContent = 'Generar PDF';
    }
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
    refreshExportUI();
    console.log('[TSAgestor] listo.');
  });
})();
