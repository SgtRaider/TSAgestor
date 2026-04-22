// Date/time filtering of TSA arrays.
// All times are treated as UTC integers (HHMM) for simple comparison.

const MONTHS = {
  JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5,
  JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11
};

function hhmm(str) {
  // "18:30" → 1830  |  "1830" → 1830
  return parseInt(str.replace(':', ''), 10);
}

function overlaps(schedStart, schedEnd, filterStart, filterEnd) {
  // Handles midnight-crossing: if end < start, the window wraps around 2400
  const sS = schedStart, sE = schedEnd;
  const fS = filterStart, fE = filterEnd;
  if (sS <= sE) {
    // Normal range
    if (fS <= fE) return sS <= fE && sE >= fS;
    // Filter wraps midnight
    return sS <= fE || sE >= fS;
  } else {
    // Schedule wraps midnight (e.g. 1830-0600)
    if (fS <= fE) return fS <= sE || fE >= sS;
    return true; // both wrap, always overlap
  }
}

export function getUniqueDates(tsas) {
  const seen = new Set();
  for (const tsa of tsas)
    for (const s of tsa.schedules)
      seen.add(s.date);
  return [...seen].sort((a, b) => {
    const [mA, dA] = a.split(' ');
    const [mB, dB] = b.split(' ');
    const diff = (MONTHS[mA] ?? 0) - (MONTHS[mB] ?? 0);
    return diff !== 0 ? diff : +dA - +dB;
  });
}

export function filterTSAs(tsas, { date, startTime, endTime }) {
  if (!date && !startTime && !endTime) return tsas;

  const fS = startTime ? hhmm(startTime) : 0;
  const fE = endTime   ? hhmm(endTime)   : 2359;

  return tsas.filter(tsa =>
    tsa.schedules.some(s => {
      if (date && s.date !== date) return false;
      if (!startTime && !endTime) return true;
      return overlaps(+s.start, +s.end, fS, fE);
    })
  );
}
