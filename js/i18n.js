// OLA3: foundation de internacionalizacion (es/en).
//
// Uso:
//   const t = window.TSAgestor.i18n.t;
//   t('live.start', 'Iniciar ruta')      -> "Iniciar ruta" en es, "Start route" en en
//   i18n.setLang('en')                   -> cambia idioma y dispara onChange
//   i18n.applyToDOM()                    -> traduce todos los elementos con
//                                            data-i18n="<key>" del DOM actual
//
// Estrategia:
//   - Dictionary: { es: { key: txt }, en: { key: txt } }
//   - La key es semantica ('plan.title', 'live.start'). NO usar el
//     texto literal como key — asi cambios de copy no rompen.
//   - t(key, fallback) devuelve el texto en lang activo, o fallback,
//     o la key entre [] como ultima opcion (visible en dev).
//   - applyToDOM() lee data-i18n y data-i18n-title; reaplica al
//     cambiar idioma.
//   - Persiste lang en localStorage 'tsagestor_lang'.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.i18n = (function () {
  'use strict';

  const KEY = 'tsagestor_lang';
  const SUPPORTED = ['es', 'en'];
  let lang = 'es';
  const listeners = [];

  // ── Diccionario ──────────────────────────────────────────────────
  // Keys en formato 'modulo.subkey'. Coverage parcial — los strings
  // mas visibles tienen entradas; el resto cae al fallback.
  const DICT = {
    es: {
      // Navegacion principal
      'nav.home':         'Inicio',
      'nav.plan':         'Plan',
      'nav.notams':       'NOTAMs',
      'nav.cross':        'Corte',
      'nav.live':         'Live',
      'nav.export':       'Briefing',
      'nav.settings':     'Ajustes',
      // Common buttons
      'btn.calc':         'Calcular ruta',
      'btn.clear':        'Limpiar',
      'btn.save':         'Guardar',
      'btn.cancel':       'Cancelar',
      'btn.close':        'Cerrar',
      'btn.confirm':      'Confirmar',
      'btn.delete':       'Borrar',
      'btn.export':       'Exportar',
      // Plan
      'plan.aircraft':    'Aeronave',
      'plan.origin':      'Origen',
      'plan.dest':        'Destino',
      'plan.fl':          'Nivel (FL)',
      'plan.ias':         'IAS (kt)',
      'plan.depart':      'Salida (UTC)',
      // Live cards
      'live.status':      'Estado actual',
      'live.threats':     'Amenazas',
      'live.eval':        'Evaluación',
      'live.start':       'Iniciar ruta',
      'live.advance':     'Estoy en próximo WP',
      'live.back':        'Retroceder',
      'live.hold':        '+ Hold',
      'live.rtb':         'Vuelta a base',
      'live.refresh':     'Refresh viento',
      'live.reset':       'Reset sesión',
      // Status stats
      'stat.next':        'Próximo WP',
      'stat.eta':         'ETA',
      'stat.delta':       'Δ',
      'stat.fuel':        'Combustible',
      'stat.dist':        'Distancia',
      // Threats
      'threat.none':      'Sin amenazas detectadas en la ruta restante.',
      'threat.nodata':    'Sin datos aún. Marca tu posición para comenzar el seguimiento.',
      // Settings
      'set.lang':         'Idioma',
      'set.lang.es':      'Español',
      'set.lang.en':      'English',
    },
    en: {
      'nav.home':         'Home',
      'nav.plan':         'Plan',
      'nav.notams':       'NOTAMs',
      'nav.cross':        'Profile',
      'nav.live':         'Live',
      'nav.export':       'Briefing',
      'nav.settings':     'Settings',
      'btn.calc':         'Calculate route',
      'btn.clear':        'Clear',
      'btn.save':         'Save',
      'btn.cancel':       'Cancel',
      'btn.close':        'Close',
      'btn.confirm':      'Confirm',
      'btn.delete':       'Delete',
      'btn.export':       'Export',
      'plan.aircraft':    'Aircraft',
      'plan.origin':      'Origin',
      'plan.dest':        'Destination',
      'plan.fl':          'Level (FL)',
      'plan.ias':         'IAS (kt)',
      'plan.depart':      'Departure (UTC)',
      'live.status':      'Current status',
      'live.threats':     'Threats',
      'live.eval':        'Evaluation',
      'live.start':       'Start route',
      'live.advance':     'I am at next WP',
      'live.back':        'Go back',
      'live.hold':        '+ Hold',
      'live.rtb':         'Return to base',
      'live.refresh':     'Refresh winds',
      'live.reset':       'Reset session',
      'stat.next':        'Next WP',
      'stat.eta':         'ETA',
      'stat.delta':       'Δ',
      'stat.fuel':        'Fuel',
      'stat.dist':        'Distance',
      'threat.none':      'No threats detected on remaining route.',
      'threat.nodata':    'No data yet. Mark your position to begin tracking.',
      'set.lang':         'Language',
      'set.lang.es':      'Español',
      'set.lang.en':      'English',
    },
  };

  function load() {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored && SUPPORTED.indexOf(stored) >= 0) lang = stored;
    } catch (_) {}
  }
  function persist() {
    try { localStorage.setItem(KEY, lang); } catch (_) {}
  }
  function setLang(newLang) {
    if (SUPPORTED.indexOf(newLang) < 0) return;
    if (newLang === lang) return;
    lang = newLang;
    persist();
    applyToDOM();
    listeners.forEach(fn => { try { fn(lang); } catch (_) {} });
  }
  function getLang() { return lang; }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function t(key, fallback) {
    const d = DICT[lang] || DICT.es;
    if (d && d[key] != null) return d[key];
    if (fallback != null) return fallback;
    return '[' + key + ']';
  }

  // Traduce todos los elementos con data-i18n="<key>" y
  // data-i18n-title="<key>". El primero pone textContent, el segundo
  // pone el atributo title. Llamado al cambiar idioma + tras montar
  // contenido dinamico.
  function applyToDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      const txt = t(k, el.textContent);
      if (txt) el.textContent = txt;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const k = el.getAttribute('data-i18n-title');
      const txt = t(k, el.getAttribute('title'));
      if (txt) el.setAttribute('title', txt);
    });
    document.documentElement.setAttribute('lang', lang);
  }

  load();
  return { t, setLang, getLang, onChange, applyToDOM, SUPPORTED };
})();
