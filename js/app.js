// Main application controller — wires together all modules.
import { parseDocument }                         from './parser.js';
import { getUniqueDates, filterTSAs }            from './filters.js';
import { initMap, renderTSAs, addLegend,
         setupMapToolbar }                       from './mapView.js';
import { renderCrossSection }                    from './crossSection.js';
import { exportPDF }                             from './pdfExport.js';

// ── State ────────────────────────────────────────────────────────────────────
let allTSAs      = [];
let filteredTSAs = [];
let filter       = { date: '', startTime: '', endTime: '' };
let mapReady     = false;
let legendAdded  = false;

const getFiltered = () => filteredTSAs;

// ── Tab navigation ───────────────────────────────────────────────────────────
const filterBar = document.getElementById('filter-bar');

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');

    filterBar.classList.toggle('hidden', tab === 'upload');

    if (tab === 'map') {
      if (!mapReady) { initMap(); mapReady = true; }
      if (filteredTSAs.length) {
        // Small delay lets the flex layout settle before Leaflet measures the container
        setTimeout(() => {
          renderTSAs(filteredTSAs);
          if (!legendAdded) { addLegend(); legendAdded = true; }
        }, 50);
      }
    }

    if (tab === 'cross-section') renderCrossSection(filteredTSAs);

    if (tab === 'export') refreshExportSummary();
  });
});

// ── File upload ──────────────────────────────────────────────────────────────
const dropzone  = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  e.target.value = ''; // allow re-upload of same file
});

async function handleFile(file) {
  setStatus('info', `Procesando "${file.name}"…`);

  try {
    allTSAs = await parseDocument(file);
  } catch (err) {
    setStatus('error', `Error al procesar el documento: ${err.message}`);
    console.error(err);
    return;
  }

  if (allTSAs.length === 0) {
    setStatus('error',
      'No se encontraron TSAs en el documento. ' +
      'Verifica que el PDF contenga entradas con "TSA" y los campos esperados.');
    return;
  }

  filter       = { date: '', startTime: '', endTime: '' };
  filteredTSAs = [...allTSAs];
  legendAdded  = false;

  setStatus('success', `Se encontraron ${allTSAs.length} TSA${allTSAs.length > 1 ? 's' : ''} en el documento.`);

  populateDateSelect(allTSAs);
  renderTable(allTSAs);
  setupMapToolbar(allTSAs, getFiltered);

  // Enable PDF export
  document.getElementById('btn-export-pdf').disabled = false;
  document.getElementById('export-hint').style.display = 'none';
}

// ── Status message ───────────────────────────────────────────────────────────
function setStatus(type, msg) {
  const el = document.getElementById('parse-status');
  el.className = type;
  el.textContent = msg;
}

// ── Date selector ─────────────────────────────────────────────────────────────
function populateDateSelect(tsas) {
  const sel = document.getElementById('filter-date');
  sel.innerHTML = '<option value="">Todas las fechas</option>';
  getUniqueDates(tsas).forEach(d => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = d;
    sel.appendChild(opt);
  });
}

// ── Upload table ─────────────────────────────────────────────────────────────
function renderTable(tsas) {
  const container = document.getElementById('tsa-table-container');
  container.classList.remove('hidden');

  const badge = document.getElementById('tsa-count');
  badge.textContent = tsas.length;

  const tbody = document.querySelector('#tsa-table tbody');
  tbody.innerHTML = '';

  for (const tsa of tsas) {
    const tr  = document.createElement('tr');
    const sch = tsa.schedules
      .map(s => `<span class="schedule-chip">${s.date} ${s.start}–${s.end}</span>`)
      .join('');

    tr.innerHTML = `
      <td><strong>${tsa.name}</strong></td>
      <td style="font-family:monospace;color:#ff9900">${tsa.verticalLimits.lower}</td>
      <td style="font-family:monospace;color:#f85149">${tsa.verticalLimits.upper}</td>
      <td>${sch}</td>
      <td style="color:var(--muted);text-align:center">${tsa.coordinates.length}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Filter controls ───────────────────────────────────────────────────────────
document.getElementById('btn-apply-filter').addEventListener('click', applyFilter);
document.getElementById('btn-clear-filter').addEventListener('click', clearFilter);

function applyFilter() {
  filter = {
    date:      document.getElementById('filter-date').value,
    startTime: document.getElementById('filter-start').value,
    endTime:   document.getElementById('filter-end').value,
  };

  filteredTSAs = filterTSAs(allTSAs, filter);

  const countEl = document.getElementById('filter-count');
  countEl.textContent = allTSAs.length
    ? `${filteredTSAs.length} de ${allTSAs.length} TSAs`
    : '';

  refreshActiveView();
  refreshExportSummary();
}

function clearFilter() {
  filter = { date: '', startTime: '', endTime: '' };
  document.getElementById('filter-date').value  = '';
  document.getElementById('filter-start').value = '';
  document.getElementById('filter-end').value   = '';
  document.getElementById('filter-count').textContent = '';

  filteredTSAs = [...allTSAs];
  refreshActiveView();
  refreshExportSummary();
}

function refreshActiveView() {
  const active = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (active === 'map') {
    renderTSAs(filteredTSAs);
  } else if (active === 'cross-section') {
    renderCrossSection(filteredTSAs);
  }
}

// ── Export summary ────────────────────────────────────────────────────────────
function refreshExportSummary() {
  const el = document.getElementById('export-filter-summary');
  const { date, startTime, endTime } = filter;
  if (date || startTime || endTime) {
    el.classList.add('visible');
    const parts = [];
    if (date)      parts.push(`Fecha: <strong>${date}</strong>`);
    if (startTime) parts.push(`Desde: <strong>${startTime}</strong>`);
    if (endTime)   parts.push(`Hasta: <strong>${endTime}</strong>`);
    el.innerHTML = `Filtro activo → ${parts.join(' &nbsp;|&nbsp; ')} &nbsp;(${filteredTSAs.length} TSAs)`;
  } else {
    el.classList.remove('visible');
  }
}

// ── PDF export ────────────────────────────────────────────────────────────────
document.getElementById('btn-export-pdf').addEventListener('click', async () => {
  if (!filteredTSAs.length) {
    alert('No hay TSAs para exportar con el filtro actual.');
    return;
  }

  // Ensure cross-section is rendered (needed for html2canvas capture)
  renderCrossSection(filteredTSAs);
  await new Promise(r => setTimeout(r, 300));

  const btn = document.getElementById('btn-export-pdf');
  btn.textContent = 'Generando…';
  btn.disabled    = true;

  try {
    await exportPDF(filteredTSAs, filter);
  } finally {
    btn.textContent = 'Generar PDF';
    btn.disabled    = false;
  }
});
