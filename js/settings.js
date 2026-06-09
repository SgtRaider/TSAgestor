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
      country:   1.00,
      tsaFill:   0.30,
      airway:    0.85,
      tma:       0.06,
      ctr:       0.10,
      cloudRV:   0.60,
      cloudCTH:  0.70,
      cloudLI:   0.80,   // MTG Lightning AFA (LI)
      cloudConv: 0.65,   // MSG RGB Convection
      sigmet:    0.35,   // poligonos SIGMET (fillOpacity)
      route:     0.95,
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
    // Minimos meteorologicos para Weather Hold en la pestanya NOTAMs.
    // hard = limite absoluto (rojo, no-go). marginal = umbral amarillo.
    wxLimits: {
      ceilingHardFt:      1500,
      ceilingMarginalFt:  2000,
      visibilityHardM:    3000,
      visibilityMarginalM:5000,
      windHardKt:         30,
      windMarginalKt:     20,
    },
    // OLA4: sync con servidor (multi-dispositivo via OCI). Pre-configurado.
    //
    // Estos defaults se aplican cuando:
    //   (a) instalacion limpia (localStorage vacio), o
    //   (b) tras importar un backup donde liveSync.token fue scrubbed
    //       (audit B2/FIX-5: el token se borra del JSON exportado).
    //
    // El operador puede sobreescribir cualquier campo desde
    // Ajustes -> "Sync con servidor". Esos cambios persisten en
    // tsagestor_settings_v1 y tienen prioridad sobre estos defaults.
    //
    // SEGURIDAD del token:
    // - Es un token de UNIDAD compartido (no personal). Rotacion via
    //   backend (revoca el viejo, distribuye uno nuevo).
    // - El token va embebido en este JS source -> visible a cualquiera
    //   que descargue la PWA. Aceptable porque:
    //   1. La PWA esta detras de Cloudflare Pages con restricciones
    //      de origin a la unidad.
    //   2. El backend rate-limita por unitToken (200 PUTs/min).
    //   3. exportFullState scrubea el token del backup JSON; el operador
    //      no comparte el token explicitamente cuando reparte backups.
    // - Para emergencia (token comprometido) -> rotar en backend y
    //   bumpear este valor.
    liveSync: {
      enabled:      true,
      baseUrl:      'https://notamhub.duckdns.org',
      token:        'k6HiZzLRVp80mGuxUGJSCDFHl8tcwm6tgeQAYVKQptrjsrM9',
      callsign:     'REAPER 21',   // operador puede sobreescribir
      intervalSec:  30,
      retryMaxSec:  300,            // cap del backoff exponencial
    },
    // OLA4: dashboard de flota (?fleet=1). unitId es el identificador
    // que se manda en GET /api/live/sessions?unit=... para filtrar
    // solo los aviones de tu unidad.
    dispatch: {
      unitId:         'Ala23',
      autoRefreshSec: 15,
      showLanded:     false,
    },
  };

  // OLA3: catalogo de perfiles de avion. Cada perfil aplica defaults
  // al form Plan cuando el operador lo selecciona en el dropdown
  // "Aeronave". Defaults conservadores tipicos de cruise — el
  // operador debe verificar contra el POH/manual del avion antes de
  // usar. id en minusculas para usarse como value del select.
  //
  // limits.vmoKt: maximum operating IAS — usado para warn si el
  // operador pone IAS > Vmo en form o override en vuelo.
  const AIRCRAFT_PROFILES = [
    {
      id: 't-21', name: 'T-21 (Pilatus PC-21)',
      family: 'Turboprop entrenador avanzado',
      defaults: {
        flightLevel: 200, speedKt: 240,
        fuelInitial: 1100, fuelFlow: 400, fuelUnit: 'lb',
        joker: 400, bingo: 250,
      },
      limits: { vmoKt: 320, flMax: 250 },
    },
    {
      id: 't-25', name: 'T-25 (CASA C-101 Aviojet)',
      family: 'Reactor entrenador',
      defaults: {
        flightLevel: 250, speedKt: 280,
        fuelInitial: 1800, fuelFlow: 800, fuelUnit: 'lb',
        joker: 600, bingo: 350,
      },
      limits: { vmoKt: 415, flMax: 400 },
    },
    {
      id: 'f-5', name: 'F-5 (Northrop F-5M Tiger II)',
      family: 'Caza ligero',
      defaults: {
        flightLevel: 300, speedKt: 360,
        fuelInitial: 4500, fuelFlow: 3200, fuelUnit: 'lb',
        joker: 1200, bingo: 700,
      },
      limits: { vmoKt: 720, flMax: 500 },
    },
    {
      id: 'f-18', name: 'F-18 (McDonnell Douglas EF-18A Hornet)',
      family: 'Caza multirole',
      defaults: {
        flightLevel: 350, speedKt: 420,
        fuelInitial: 10800, fuelFlow: 5400, fuelUnit: 'lb',
        joker: 2500, bingo: 1500,
      },
      limits: { vmoKt: 700, flMax: 500 },
    },
    {
      id: 'nr-05', name: 'NR.05',
      family: 'Perfil EA — verificar especificaciones reales',
      defaults: {
        flightLevel: 200, speedKt: 220,
        fuelInitial: 2000, fuelFlow: 400, fuelUnit: 'lb',
        joker: 600, bingo: 350,
      },
      limits: { vmoKt: 300, flMax: 300 },
    },
  ];

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

  return {
    load, get, set, reset, onChange, DEFAULTS,
    // OLA3: catalogo + getters auxiliares para perfiles de aeronave.
    AIRCRAFT_PROFILES,
    getAircraftProfile(id) {
      return AIRCRAFT_PROFILES.find(p => p.id === id) || null;
    },
  };
})();
