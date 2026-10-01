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

  const KEY = 'tsagestor_saved_plans_v1';

  function readAll() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function writeAll(obj) {
    try { localStorage.setItem(KEY, JSON.stringify(obj)); }
    catch (e) { console.warn('[savedPlans]', e); }
  }

  return {
    list() {
      const all = readAll();
      return Object.keys(all).map(k => all[k]).sort((a, b) =>
        (b.saved || '').localeCompare(a.saved || '')
      );
    },
    get(name) { return readAll()[name] || null; },
    save(name, data) {
      const all = readAll();
      all[name] = Object.assign({}, data, {
        name,
        saved: new Date().toISOString(),
      });
      writeAll(all);
    },
    remove(name) {
      const all = readAll();
      delete all[name];
      writeAll(all);
    },
    has(name) { return !!readAll()[name]; },
    clear() { writeAll({}); },
  };
})();
