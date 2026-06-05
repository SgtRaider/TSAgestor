// Almacén persistente de planes de vuelo nombrados.
// Cada entrada captura los inputs del formulario + drawnVia (puntos
// dibujados sobre el mapa). Al cargar se reaplican y se recalcula —
// así la salida se reconstruye con datos TSA/meteo actuales y no se
// queda obsoleta una vez guardada.
//
// API:
//   list()            → array de objetos plan ordenados por fecha desc
//   get(name)         → objeto plan o null
//   save(name, data)  → crea/sobrescribe (data sin name/saved)
//   remove(name)
//   has(name)
//   clear()           → borra todo (debug)

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.savedPlans = (function () {
  'use strict';

  const KEY        = 'tsagestor_saved_plans_v1';
  // F3.8: store separado para vuelos ya realizados (After Action
  // Reports). Misma forma de API pero distinto namespace para que el
  // listado de "Planes guardados" del flujo Plan no se mezcle con los
  // vuelos volados (que son snapshots de sesiones Live).
  const FLOWN_KEY  = 'tsagestor_flown_sessions_v1';

  function readAll(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function writeAll(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); }
    catch (e) { console.warn('[savedPlans]', e); }
  }

  return {
    // ── Planes planificados (formulario + ruta calculada) ──
    list() {
      const all = readAll(KEY);
      return Object.keys(all).map(k => all[k]).sort((a, b) =>
        (b.saved || '').localeCompare(a.saved || '')
      );
    },
    get(name) { return readAll(KEY)[name] || null; },
    save(name, data) {
      const all = readAll(KEY);
      all[name] = Object.assign({}, data, {
        name,
        saved: new Date().toISOString(),
      });
      writeAll(KEY, all);
    },
    remove(name) {
      const all = readAll(KEY);
      delete all[name];
      writeAll(KEY, all);
    },
    has(name) { return !!readAll(KEY)[name]; },
    clear() { writeAll(KEY, {}); },

    // ── F3.8: Vuelos realizados (snapshots de sesion Live) ──
    // Una entrada flown contiene: snapshot de session (coords,
    // actualPassTimes, liveHolds, fuelOverrides, overrides, refetched,
    // rtbEngaged, etc.) + metadatos (origin, destination, durationMs,
    // fuelConsumed, deltaEtaMs). Lo construye livePlan.saveAsFlown.
    listFlown() {
      const all = readAll(FLOWN_KEY);
      return Object.keys(all).map(k => all[k]).sort((a, b) =>
        (b.saved || '').localeCompare(a.saved || '')
      );
    },
    getFlown(name) { return readAll(FLOWN_KEY)[name] || null; },
    saveFlown(name, data) {
      const all = readAll(FLOWN_KEY);
      all[name] = Object.assign({}, data, {
        name,
        saved: new Date().toISOString(),
      });
      writeAll(FLOWN_KEY, all);
    },
    removeFlown(name) {
      const all = readAll(FLOWN_KEY);
      delete all[name];
      writeAll(FLOWN_KEY, all);
    },
    hasFlown(name) { return !!readAll(FLOWN_KEY)[name]; },
    clearFlown() { writeAll(FLOWN_KEY, {}); },
  };
})();
