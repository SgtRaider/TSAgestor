// Filtrado de TSAs por rango fecha/hora UTC con semántica de SOLAPE.
// Una TSA entra si CUALQUIERA de sus ventanas horarias tiene intersección
// (no vacía) con el rango del filtro. No hace falta que coincida la fecha
// exacta: p.ej. filtro 21–22 incluye NOTAM que va del 1 al 30, solo el 21,
// solo el 22, del 15 al 25, etc.
//
// Estado esperado: { dateFrom?: 'YYYY-MM-DD', dateTo?: 'YYYY-MM-DD',
//                    timeFrom?: 'HH:MM',     timeTo?: 'HH:MM' }

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.filters = (function () {
  'use strict';

  const MS_DAY = 24 * 3600 * 1000;

  function parseDateYMD(ymd) {
    if (!ymd) return null;
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  function parseHMtoMinutes(hm) {
    if (!hm) return null;
    const m = hm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }

  // Overlap estricto de intervalos [a,b) y [c,d).
  function overlap(a, b, c, d) { return a < d && c < b; }

  function scheduleMatches(schedule, state) {
    const sStart = schedule.startUTC.getTime();
    const sEnd   = schedule.endUTC.getTime();

    // 1. Overlap por fecha (siempre, aunque sólo haya una de las dos).
    const dFromMs = parseDateYMD(state.dateFrom);
    const dToMs   = parseDateYMD(state.dateTo);
    const fStart  = dFromMs !== null ? dFromMs : -Infinity;
    const fEnd    = dToMs   !== null ? dToMs + MS_DAY : Infinity;
    if (!overlap(sStart, sEnd, fStart, fEnd)) return false;

    // 2. Si no hay filtro horario, el solape de fecha es suficiente.
    const tF = parseHMtoMinutes(state.timeFrom);
    const tT = parseHMtoMinutes(state.timeTo);
    if (tF === null && tT === null) return true;

    const tFromMin = tF !== null ? tF : 0;
    const tToMin   = tT !== null ? tT : 24 * 60;

    // 3. Itera cada día en la intersección (schedule ∩ filter-dates).
    const rangeStart = Math.max(sStart, fStart);
    const rangeEnd   = Math.min(sEnd,   fEnd);
    const firstDay   = Math.floor(rangeStart / MS_DAY) * MS_DAY;

    for (let d = firstDay; d < rangeEnd; d += MS_DAY) {
      const hFrom = d + tFromMin * 60000;
      const hTo   = d + tToMin   * 60000;
      if (tToMin <= tFromMin) {
        // Cruza medianoche: [d, hTo) ∪ [hFrom, d+1d)
        if (overlap(sStart, sEnd, d, hTo)) return true;
        if (overlap(sStart, sEnd, hFrom, d + MS_DAY)) return true;
      } else {
        if (overlap(sStart, sEnd, hFrom, hTo)) return true;
      }
    }
    return false;
  }

  function matches(tsa, state) {
    if (!state) return true;
    // Filtro por tipo (work/transit). Si la TSA no tiene _isWorkArea
    // boolean, la dejamos pasar en cualquier filtro de tipo (no podemos
    // clasificarla — caso tipico de KML importado sin metadata).
    if (state.tsaType === 'work'    && tsa._isWorkArea === false) return false;
    if (state.tsaType === 'transit' && tsa._isWorkArea === true)  return false;
    // Filtro "active-now": al menos una ventana cubre el momento actual.
    if (state.activeNow) {
      const now = Date.now();
      const anyActive = (tsa.schedules || []).some(s => {
        const a = s.startUTC instanceof Date ? s.startUTC.getTime() : Date.parse(s.startUTC);
        const b = s.endUTC   instanceof Date ? s.endUTC.getTime()   : Date.parse(s.endUTC);
        return Number.isFinite(a) && Number.isFinite(b) && a <= now && now < b;
      });
      if (!anyActive) return false;
    }
    const anyField = state.dateFrom || state.dateTo || state.timeFrom || state.timeTo;
    if (!anyField) return true;
    return tsa.schedules.some(s => scheduleMatches(s, state));
  }

  function filter(tsas, state) {
    return tsas.filter(t => matches(t, state));
  }

  function summaryText(state) {
    if (!state) return 'Sin filtro';
    const parts = [];
    if (state.tsaType === 'work')    parts.push('Tipo: Work');
    if (state.tsaType === 'transit') parts.push('Tipo: Transit');
    if (state.activeNow) parts.push('Solo activas ahora');
    if (state.dateFrom || state.dateTo) {
      parts.push(`Fechas: ${state.dateFrom || '—'} a ${state.dateTo || '—'}`);
    }
    if (state.timeFrom || state.timeTo) {
      parts.push(`Horario UTC: ${state.timeFrom || '00:00'}–${state.timeTo || '23:59'}`);
    }
    return parts.length ? parts.join(' · ') : 'Sin filtro';
  }

  return { filter, matches, summaryText };
})();
