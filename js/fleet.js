// OLA4: dashboard de flota (?fleet=1).
//
// Lista las sesiones activas que el backend expone (via liveSync stub
// o real). Refresh cada 15 s (configurable en dispatch.autoRefreshSec).
// Read-only: NO se puede tocar la sesion de otro avion.
//
// Estados derivados en cliente segun edad del ultimo push:
//   < 60 s    -> flying (verde)
//   60-600 s  -> stale  (ambar)
//   > 600 s   -> lost   (rojo) — desaparece tras 30 min
//   ts_ended  -> landed (gris)
//
// Esconde el shell B1 — fullscreen tabla. body.b1-fleet aplica CSS.
//
// Seguridad:
//   - dispatch.unitId vacio -> banner CTA, no fetch.
//   - Todo user-content escapado con escapeHTML (FIX-10).
//   - fetch con cache:'no-store' (FIX-7) — el SW bypasea /api/live/* tambien.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.fleet = (function () {
  'use strict';

  let _mounted = false;
  let _shellEl = null;
  let _refreshTimer = null;
  let _backoffSec = 0;
  let _failCount = 0;

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }

  function _fmtTime(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + 'Z';
  }
  function _fmtAge(ms) {
    if (!Number.isFinite(ms)) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  }
  function _statusOf(s) {
    if (s.tsEnded) return 'landed';
    const age = Date.now() - (s.tsPushed || 0);
    if (age < 60 * 1000) return 'flying';
    if (age < 10 * 60 * 1000) return 'stale';
    return 'lost';
  }
  const _statusLabel = {
    flying: 'En vuelo',
    stale:  'Datos stale',
    lost:   'Sin contacto',
    landed: 'Aterrizado',
  };

  function _buildShell() {
    const sh = document.createElement('div');
    sh.className = 'b1-fleet-shell';
    sh.innerHTML =
      '<h1>FLOTA — Dispatch view</h1>' +
      '<div class="b1-fleet-meta">' +
        '<span id="fleet-unit-info"></span>' +
        '<span id="fleet-update-info"></span>' +
        '<span id="fleet-error" style="color:#fca5a5;"></span>' +
      '</div>' +
      '<div id="fleet-banner"></div>' +
      '<div id="fleet-body"></div>';
    document.body.appendChild(sh);
    return sh;
  }

  function mount() {
    if (_mounted) return;
    _mounted = true;
    _shellEl = _buildShell();
    _render();
    _scheduleRefresh();
    // Pausa refresh cuando el tab no es visible (FIX performance).
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          _stopRefresh();
        } else {
          _render();
          _scheduleRefresh();
        }
      });
    }
  }
  function unmount() {
    _stopRefresh();
    if (_shellEl && _shellEl.parentNode) _shellEl.parentNode.removeChild(_shellEl);
    _shellEl = null;
    _mounted = false;
  }
  function _scheduleRefresh() {
    _stopRefresh();
    const settings = window.TSAgestor && window.TSAgestor.settings;
    const baseSec = (settings && Number(settings.get('dispatch.autoRefreshSec'))) || 15;
    const delay = _backoffSec > 0 ? _backoffSec : baseSec;
    _refreshTimer = setTimeout(_tick, delay * 1000);
  }
  function _stopRefresh() {
    if (_refreshTimer) { try { clearTimeout(_refreshTimer); } catch (_) {} _refreshTimer = null; }
  }
  async function _tick() {
    _refreshTimer = null;
    await _render();
    _scheduleRefresh();
  }

  async function _render() {
    if (!_shellEl) return;
    const settings = window.TSAgestor && window.TSAgestor.settings;
    const ls = window.TSAgestor && window.TSAgestor.liveSync;
    const unitId = (settings && settings.get('dispatch.unitId', '')) || '';
    const unitInfo = _shellEl.querySelector('#fleet-unit-info');
    const updInfo  = _shellEl.querySelector('#fleet-update-info');
    const errEl    = _shellEl.querySelector('#fleet-error');
    const banner   = _shellEl.querySelector('#fleet-banner');
    const body     = _shellEl.querySelector('#fleet-body');

    if (unitInfo) unitInfo.textContent = 'Unidad: ' + (unitId || '(no configurada)');
    if (errEl) errEl.textContent = '';

    if (!unitId) {
      banner.innerHTML = '<div class="b1-fleet-banner">Configura tu <b>ID de unidad</b> en Ajustes → Sync con servidor antes de usar Flota. Sin esto no se hace ningun fetch al servidor.</div>';
      body.innerHTML = '';
      return;
    }
    banner.innerHTML = '';

    if (!ls || typeof ls.listActive !== 'function') {
      body.innerHTML = '<div class="b1-fleet-empty">Modulo liveSync no disponible.</div>';
      return;
    }

    try {
      const r = await ls.listActive();
      _failCount = 0;
      _backoffSec = 0;
      const sessions = (r && Array.isArray(r.sessions)) ? r.sessions : [];
      const showLanded = !!(settings && settings.get('dispatch.showLanded', false));
      const filtered = sessions.filter(s => showLanded || !s.tsEnded);
      if (updInfo) updInfo.textContent = 'Actualizado: ' + _fmtTime(Date.now()) + ' · ' + filtered.length + ' aviones';
      if (!filtered.length) {
        body.innerHTML = '<div class="b1-fleet-empty">Sin sesiones activas en tu unidad.</div>';
        return;
      }
      // Ordena: en vuelo primero, luego stale, lost, landed.
      const order = { flying: 0, stale: 1, lost: 2, landed: 3 };
      filtered.sort((a, b) => (order[_statusOf(a)] - order[_statusOf(b)]));
      const rows = filtered.map(s => {
        const st = _statusOf(s);
        return '<tr class="b1-fleet-row-' + st + '">' +
          '<td><span class="b1-fleet-chip b1-fleet-chip-' + st + '">' + escapeHTML(_statusLabel[st]) + '</span></td>' +
          '<td><b>' + escapeHTML(s.callsign || '—') + '</b></td>' +
          '<td>' + escapeHTML(s.origin || '?') + ' → ' + escapeHTML(s.destination || '?') + '</td>' +
          '<td>WP ' + ((s.currentIdx | 0) + 1) + '</td>' +
          '<td>' + (Number.isFinite(s.fuelRest) ? Math.round(s.fuelRest) : '—') + '</td>' +
          '<td>' + _fmtAge(s.tsPushed) + '</td>' +
        '</tr>';
      }).join('');
      body.innerHTML =
        '<table class="b1-fleet-table">' +
          '<thead><tr><th>Estado</th><th>Indicativo</th><th>Ruta</th><th>WP actual</th><th>Fuel</th><th>Último push</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
    } catch (e) {
      _failCount++;
      _backoffSec = Math.min(120, Math.pow(2, _failCount) * 5);
      if (errEl) errEl.textContent = '⚠ Fallo al actualizar (' + escapeHTML((e && e.message) || 'desconocido') + ') — reintenta en ' + _backoffSec + 's';
    }
  }

  return { mount, unmount };
})();
