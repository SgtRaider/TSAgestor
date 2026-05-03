// Almacén persistente de preferencias del usuario (localStorage).
// Centraliza:
//   • opacity   → opacidad por capa del mapa (TSA, ruta, nubes, etc.)
//   • plan      → valores por defecto del formulario de Plan de vuelo
//
// API:
//   load()                       → objeto settings completo (con defaults)
//   get(path, fallback)          → valor anidado por dot-path
//   set(path, value)             → escribe + persiste + dispara onChange
//   reset()                      → restaura a DEFAULTS, persiste, notifica
//   onChange(fn)                 → fn(path, value) cada vez que cambia algo
//   DEFAULTS                     → constante con los valores de fábrica

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.settings = (function () {
  'use strict';

  const KEY = 'tsagestor_settings_v1';

  const DEFAULTS = {
    opacity: {
      country:  1.00,
      tsaFill:  0.30,
      airway:   0.85,
      tma:      0.06,
      ctr:      0.10,
      cloudRV:  0.60,
      cloudCTH: 0.70,
      route:    0.95,
    },
    plan: {
      origin:        'LEBZ',
      destination:   'LEBZ',
      flightLevel:   250,
      speedKt:       120,
      fuelInitial:   2500,
      fuelFlow:      200,
      fuelUnit:      'lb',
      joker:         1500,
      bingo:         400,
    },
  };

  let data = null;
  const listeners = [];

  function load() {
    if (data) return data;
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch (_) { stored = null; }
    data = deepMerge(deepClone(DEFAULTS), stored || {});
    return data;
  }

  function save() {
    if (!data) return;
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) {}
  }

  function get(path, fallback) {
    const v = pathGet(load(), path);
    return v !== undefined ? v : fallback;
  }

  function set(path, value) {
    const obj = load();
    pathSet(obj, path, value);
    save();
    notify(path, value);
  }

  function reset() {
    data = deepClone(DEFAULTS);
    save();
    notify('*', null);
  }

  function onChange(fn) { listeners.push(fn); }
  function notify(path, value) {
    for (const fn of listeners) {
      try { fn(path, value); } catch (e) { console.warn('[settings] onChange:', e); }
    }
  }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function deepMerge(a, b) {
    for (const k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
        a[k] = deepMerge(a[k] || {}, b[k]);
      } else {
        a[k] = b[k];
      }
    }
    return a;
  }
  function pathGet(o, p) {
    const parts = p.split('.');
    let c = o;
    for (const k of parts) { if (c == null) return undefined; c = c[k]; }
    return c;
  }
  function pathSet(o, p, v) {
    const parts = p.split('.');
    let c = o;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!c[parts[i]] || typeof c[parts[i]] !== 'object') c[parts[i]] = {};
      c = c[parts[i]];
    }
    c[parts[parts.length - 1]] = v;
  }

  return { load, get, set, reset, onChange, DEFAULTS };
})();
