// Filtrado de TSAs por rango fecha/hora UTC.
// Estado esperado: { dateFrom?: 'YYYY-MM-DD', dateTo?: 'YYYY-MM-DD',
//                    timeFrom?: 'HH:MM',     timeTo?: 'HH:MM' }

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.filters = (function () {
  'use strict';

  function parseDateYMD(ymd) {
    if (!ymd) return null;
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }

  function parseHM(hm) {
    if (!hm) return null;
    const m = hm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return { h: +m[1], m: +m[2] };
  }

  // Intersección temporal de dos intervalos [a,b] y [c,d] (exclusivo).
  function intersects(a, b, c, d) {
    return a < d && c < b;
  }

  // ¿Algún día del rango dateFrom..dateTo tiene solape con [timeFrom, timeTo] de la ventana?
  function windowMatches(schedule, state) {
    const dFrom = parseDateYMD(state.dateFrom);
    const dTo   = parseDateYMD(state.dateTo);
    const tFrom = parseHM(state.timeFrom);
    const tTo   = parseHM(state.timeTo);

    const sStart = schedule.startUTC.getTime();
    const sEnd   = schedule.endUTC.getTime();

    // Filtro por fechas
    if (dFrom && sEnd < dFrom.getTime()) return false;
    if (dTo) {
      const cutoff = dTo.getTime() + 24 * 3600 * 1000;
      if (sStart >= cutoff) return false;
    }

    // Filtro por hora del día (si no hay, basta con las fechas)
    if (!tFrom && !tTo) return true;

    // Recorre cada día que toca la ventana y comprueba solape horario.
    const day0 = new Date(Date.UTC(
      schedule.startUTC.getUTCFullYear(),
      schedule.startUTC.getUTCMonth(),
      schedule.startUTC.getUTCDate()
    ));
    const endDayMs = sEnd - 1;
    for (let t = day0.getTime(); t <= endDayMs; t += 24 * 3600 * 1000) {
      const dayStart = t;
      const hFrom = tFrom ? dayStart + (tFrom.h * 60 + tFrom.m) * 60000 : dayStart;
      const hTo   = tTo   ? dayStart + (tTo.h   * 60 + tTo.m)   * 60000 : dayStart + 24 * 3600 * 1000;
      // Si el rango horario cruza medianoche (tTo < tFrom), partir en dos tramos.
      if (tFrom && tTo && hTo <= hFrom) {
        if (intersects(sStart, sEnd, dayStart, hTo)) return true;
        if (intersects(sStart, sEnd, hFrom, dayStart + 24 * 3600 * 1000)) return true;
      } else {
        if (intersects(sStart, sEnd, hFrom, hTo)) return true;
      }
    }
    return false;
  }

  function matches(tsa, state) {
    if (!state) return true;
    const any = state.dateFrom || state.dateTo || state.timeFrom || state.timeTo;
    if (!any) return true;
    for (const sch of tsa.schedules) {
      if (windowMatches(sch, state)) return true;
    }
    return false;
  }

  function filter(tsas, state) {
    return tsas.filter(t => matches(t, state));
  }

  function summaryText(state) {
    if (!state) return 'Sin filtro';
    const parts = [];
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
