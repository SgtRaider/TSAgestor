// Utilidades de presentación de horarios (groupings + formateo).
// Una "ventana" individual es { startUTC, endUTC, raw }. Aquí se agrupan
// por horario igual + días consecutivos, para mostrar "21–24 abr 06:00–18:30"
// en lugar de cuatro líneas separadas.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.scheduleFmt = (function () {
  'use strict';

  const MONTHS_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const MS_DAY = 86400000;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dd(d)   { return pad2(d.getUTCDate()); }
  function hhmm(d) { return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }

  // Agrupa schedules con el mismo horario y días consecutivos en runs.
  // Devuelve [{ first, last, count }] ordenados por fecha.
  function groupSchedules(schedules) {
    if (!schedules || !schedules.length) return [];
    const buckets = new Map();
    for (const s of schedules) {
      const start = hhmm(s.startUTC);
      const dur = Math.round((s.endUTC.getTime() - s.startUTC.getTime()) / 60000);
      const key = `${start}|${dur}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(s);
    }
    const out = [];
    for (const list of buckets.values()) {
      list.sort((a, b) => a.startUTC - b.startUTC);
      let runStart = list[0], runEnd = list[0], count = 1;
      for (let i = 1; i < list.length; i++) {
        const diff = (list[i].startUTC.getTime() - runEnd.startUTC.getTime()) / MS_DAY;
        if (Math.abs(diff - 1) < 0.01) { runEnd = list[i]; count++; }
        else { out.push({ first: runStart, last: runEnd, count });
               runStart = list[i]; runEnd = list[i]; count = 1; }
      }
      out.push({ first: runStart, last: runEnd, count });
    }
    out.sort((a, b) => a.first.startUTC - b.first.startUTC);
    return out;
  }

  // "21–24 abr 06:00–18:30Z" o "21 abr 06:00–18:30Z"
  function formatGroup(g) {
    const a = g.first.startUTC, b = g.last.startUTC;
    const aEnd = g.first.endUTC;
    const sameDay   = a.toISOString().slice(0,10) === b.toISOString().slice(0,10);
    const sameMonth = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
    const m1 = MONTHS_ES[a.getUTCMonth()];
    const m2 = MONTHS_ES[b.getUTCMonth()];
    let dateStr;
    if (sameDay)        dateStr = `${dd(a)} ${m1}`;
    else if (sameMonth) dateStr = `${dd(a)}–${dd(b)} ${m1}`;
    else                dateStr = `${dd(a)} ${m1} – ${dd(b)} ${m2}`;
    return `${dateStr} ${hhmm(a)}–${hhmm(aEnd)}Z`;
  }

  // Resumen corto: primer grupo + "(+N grupos · M días)" si hay más
  function summary(schedules) {
    const grouped = groupSchedules(schedules);
    if (!grouped.length) return '—';
    const totalDays = schedules.length;
    const first = formatGroup(grouped[0]);
    if (grouped.length === 1) return first;
    return `${first} · +${grouped.length - 1} grupos (${totalDays} días)`;
  }

  // Lista completa formateada (HTML), una línea por grupo.
  function listHTML(schedules) {
    const grouped = groupSchedules(schedules);
    if (!grouped.length) return '<i>—</i>';
    return grouped.map(g => {
      const days = g.count > 1 ? ` <span class="muted">(${g.count} días)</span>` : '';
      return `<div class="sched-item">${formatGroup(g)}${days}</div>`;
    }).join('');
  }

  function listText(schedules) {
    const grouped = groupSchedules(schedules);
    return grouped.map(g => {
      const days = g.count > 1 ? ` (${g.count} días)` : '';
      return formatGroup(g) + days;
    });
  }

  return { groupSchedules, formatGroup, summary, listHTML, listText };
})();
