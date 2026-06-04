// B1 layout — Stepper + floating opaque panel + bottom drawer sobre
// mapa siempre full-canvas.
//
// Activacion: anade clase 'b1' al <body>. Si el modulo falla por
// cualquier motivo, la app cae al layout antiguo sin tocar nada.
//
// Reorganizacion (5 secciones del stepper):
//   ① Inicio    -> contenido del antiguo #tab-home
//   ② Datos     -> contenido del antiguo #tab-upload + #filter-bar
//                  drawer: #tsa-table-wrap (tabla TSAs)
//   ③ Plan      -> contenido del antiguo #tab-plan (formulario)
//                  drawer: log de combustible + waypoints + corte
//   ④ Briefing  -> contenido del antiguo #tab-notams (WX + cards)
//   ⑤ Ajustes   -> #tab-settings
//
// El mapa (#map) se mueve al .b1-map-zone y ahi vive siempre, full
// canvas, detras del panel y el drawer. La toolbar del mapa (Centrar
// / Leyenda / Capas / Trafico) se mueve a una posicion flotante en
// la esquina superior derecha del mapa.

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.b1Layout = (function () {
  'use strict';

  // Iconos del stepper: SVG inline tematicos del Ejercito del Aire.
  // - home: cocarda (3 circulos concentricos) — el roundel del EA
  // - data: stack de capas (KML / TSAs / mapas)
  // - plan: silueta delta de jet militar (vista superior)
  // - briefing: nube con rayo (meteo)
  // - settings: pinon clasico (8 brazos + circulo)
  // Todos heredan color via stroke=currentColor; CSS controla tamano.
  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/>' +
      '<circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
    data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 18l9 5 9-5"/></svg>',
    plan: '<svg viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M12 2l1.5 6 8.5 4v1.5l-8.5-1v6l3 2v1l-4.5-1-4.5 1v-1l3-2v-6l-8.5 1V12l8.5-4z"/></svg>',
    briefing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 18a5 5 0 0 1 0-10 7 7 0 0 1 13 4 4 4 0 0 1-2 7H7z"/>' +
      '<path d="M13 11l-3 5h4l-2 4"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>',
  };

  // Configuracion del stepper. order = orden de aparicion en el header.
  const SECTIONS = [
    { id: 'home',     icon: ICONS.home,     label: 'Inicio',   tabId: 'tab-home',    drawer: [] },
    { id: 'datos',    icon: ICONS.data,     label: 'Datos',    tabId: 'tab-upload',  drawer: [
      { id: 'tsa-table-wrap',     label: 'TSAs detectadas' },
    ]},
    { id: 'plan',     icon: ICONS.plan,     label: 'Plan',     tabId: 'tab-plan',    drawer: [
      { id: 'plan-log-table-wrap',   label: 'Log de combustible' },
      { id: 'cross-section-wrap',    label: 'Corte transversal' },
      { id: 'plan-coords-wrap',      label: 'Waypoints y coordenadas' },
    ]},
    { id: 'briefing', icon: ICONS.briefing, label: 'Briefing', tabId: 'tab-notams',  drawer: [] },
    { id: 'settings', icon: ICONS.settings, label: 'Ajustes',  tabId: 'tab-settings', drawer: [] },
  ];

  const STORAGE_KEY = 'tsagestor_b1_layout';
  const DEFAULTS = {
    section:      'home',
    panelState:   'open',          // open | collapsed | hidden
    drawerState:  'closed',        // closed | open | collapsed
    drawerItem:   null,            // id de drawer-item activo
    panelW:       480,
    drawerH:      0.42,            // fraccion del viewport (resize relativo)
  };

  let state = Object.assign({}, DEFAULTS);
  let _shell, _panel, _panelBody, _panelRail, _drawer, _drawerHead, _drawerBody, _mapZone;
  // Cache de la ubicacion original (parentElement) de cada drawer item,
  // para devolverlo a su sitio exacto al salir de la seccion.
  const _drawerItemOrigin = new Map();

  function isEnabled() { return document.body.classList.contains('b1'); }

  function init() {
    if (!isEnabled()) return;
    _loadState();
    _buildShell();
    _wireStepper();
    _wireResize();
    _wireKeyboard();
    _wireDrawerControls();
    _adoptFilterBar();
    _moveMap();
    // Inicializa Leaflet al activar B1: el usuario nunca pasa por
    // switchTab('map') con el stepper de B1, asi que sin esto el
    // contenedor #map se queda sin instancia y el mapa no se ve.
    try {
      const appApi = (window.TSAgestor && window.TSAgestor.app) || {};
      if (appApi.ensureMap) appApi.ensureMap();
    } catch (err) { console.warn('[b1Layout] ensureMap fallo:', err); }
    _moveSection(state.section);
    _applyPanelState();
    _applyDrawerState();
    setTimeout(_invalidateMapSize, 50);
    console.info('[b1Layout] activado, seccion=', state.section);
  }

  // Mueve #filter-bar dentro de #tab-upload para que viaje con la
  // seccion Datos al panel y siga siendo accesible (los chips
  // work/transit y los filtros de fecha/hora son funcionalidad core).
  function _adoptFilterBar() {
    const fb = document.getElementById('filter-bar');
    const datosTab = document.getElementById('tab-upload');
    if (fb && datosTab && fb.parentElement !== datosTab) {
      datosTab.insertBefore(fb, datosTab.firstChild);
    }
  }

  // ── Estado persistente ───────────────────────────────────────────
  function _loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = Object.assign({}, DEFAULTS, parsed);
      }
    } catch (_) { /* default */ }
  }
  function _saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  // ── Modal de ayuda ───────────────────────────────────────────────
  // Contenido completo de "como operar la app", estructurado en
  // secciones <details>/<summary> colapsables para que el usuario
  // localice rapido lo que busca. Se monta dentro de .b1-shell con
  // class "modal" para que herede el patron de cierre por Esc
  // (b1Layout._wireKeyboard ya respeta cualquier .modal:not(.hidden)).
  function _buildHelpModalHTML() {
    return `
      <div class="b1-help-modal modal hidden" id="b1-help-modal" role="dialog" aria-modal="true" aria-labelledby="b1-help-title">
        <div class="b1-help-backdrop" id="b1-help-backdrop"></div>
        <div class="b1-help-content">
          <header class="b1-help-head">
            <h2 id="b1-help-title">Ayuda TSAgestor</h2>
            <button class="b1-icon-btn" id="b1-help-close" title="Cerrar (Esc)" aria-label="Cerrar ayuda">✕</button>
          </header>
          <div class="b1-help-body">
            <details open>
              <summary>Inicio rapido</summary>
              <p>TSAgestor es un planificador de vuelo tactico para aviacion militar / TSA. La interfaz se organiza en 5 secciones (stepper superior):</p>
              <ul>
                <li><b>① Inicio</b> &mdash; Bienvenida.</li>
                <li><b>② Datos</b> &mdash; Carga de KML/KMZ con TSAs detectadas y filtros.</li>
                <li><b>③ Plan</b> &mdash; Configura el plan de vuelo y calcula ruta, log de combustible, corte transversal y tabla de waypoints.</li>
                <li><b>④ Briefing</b> &mdash; NOTAMs y consulta meteo.</li>
                <li><b>⑤ Ajustes</b> &mdash; Preferencias persistentes (velocidad base, consumo, BINGO/JOKER).</li>
              </ul>
              <p>El mapa ocupa toda la pantalla detras del panel y el drawer. El boton <b>⇔</b> del header (o la tecla <kbd>M</kbd>) cicla el panel <i>abierto &rarr; colapsado &rarr; oculto</i>.</p>
            </details>

            <details>
              <summary>Cargar datos (KML / KMZ)</summary>
              <p>En la seccion <b>② Datos</b>:</p>
              <ol>
                <li>Pulsa <b>Cargar archivo</b> o arrastra un KML/KMZ.</li>
                <li>Las TSAs detectadas aparecen en la tabla del cajon inferior.</li>
                <li>Filtra con los chips <b>Trabajo</b> / <b>Transito</b> / <b>Active now</b>, o por rango de fecha/hora.</li>
              </ol>
              <p>Las TSAs activas se dibujan en el mapa con colores diferenciados (Trabajo verde, Transito rojo).</p>
            </details>

            <details>
              <summary>Plan de vuelo</summary>
              <p>En la seccion <b>③ Plan</b>, rellena el formulario:</p>
              <ul>
                <li><b>Origen / Destino</b> &mdash; ICAOs de 4 letras (ej. LEMD, LEZG).</li>
                <li><b>Via</b> &mdash; Waypoints separados por espacio o coma. Vacio = ruta automatica.</li>
                <li><b>Nivel (FL)</b> e <b>IAS (kt)</b> &mdash; Altitud y velocidad del cruise.</li>
                <li><b>Salida (UTC)</b> &mdash; Fecha y hora UTC del despegue.</li>
                <li><b>Combustible</b> &mdash; Inicial, Consumo (/h), Unidad, JOKER, BINGO.</li>
              </ul>
              <p>Botones:</p>
              <ul>
                <li><b>Dibujar en mapa</b> &mdash; Activa el modo dibujo (ver seccion).</li>
                <li><b>Calcular ruta</b> &mdash; Genera la ruta, el log de combustible, el corte y la tabla de waypoints.</li>
                <li><b>Limpiar</b> &mdash; Resetea el formulario.</li>
              </ul>
              <p>Tras calcular, el cajon inferior trae 3 pestanas:</p>
              <ul>
                <li><b>Log de combustible</b> &mdash; Tramo a tramo: IAS / TAS / Viento / GS / Tiempo / Combustible / Estado.</li>
                <li><b>Corte transversal</b> &mdash; Perfil vertical del vuelo (FL vs distancia) con nubes Open-Meteo y GRAMET opcionales.</li>
                <li><b>Waypoints y coordenadas</b> &mdash; Lat / Lon / FL / ETA por waypoint.</li>
              </ul>
            </details>

            <details>
              <summary>Modo dibujo de ruta</summary>
              <ol>
                <li>Pulsa <b>Dibujar en mapa</b> en la seccion Plan.</li>
                <li>Haz click en el mapa para anyadir waypoints intermedios.</li>
                <li>El banner inferior muestra el contador y las acciones:
                  <ul>
                    <li><b>Deshacer</b> &mdash; Quita el ultimo waypoint.</li>
                    <li><b>Vuelta</b> &mdash; Anyade los waypoints en orden inverso para cerrar el circuito hasta origen.</li>
                    <li><b>Listo</b> &mdash; Termina y vuelve a la seccion Plan.</li>
                    <li><b>Cancelar</b> &mdash; Descarta el dibujo.</li>
                  </ul>
                </li>
                <li>Doble click sobre el mapa equivale a <b>Listo</b>.</li>
              </ol>
              <p>Durante el modo dibujo se ocultan automaticamente las controles flotantes del mapa para no robar clicks.</p>
            </details>

            <details>
              <summary>Capas, leyendas y meteo</summary>
              <p>La toolbar flotante (esquina superior derecha del mapa) ofrece:</p>
              <ul>
                <li><b>Centrar</b> &mdash; Encuadra el mapa sobre las TSAs visibles.</li>
                <li><b>Leyenda TSAs</b> &mdash; Toggle de la leyenda flotante con las TSAs activas hoy/manyana (3 columnas).</li>
                <li><b>Capas</b> &mdash; Abre/cierra el control nativo de Leaflet con todas las overlays:
                  <ul>
                    <li>Aerovias alta/baja por zona (NE, NW, SE, SW)</li>
                    <li>TMAs / CTRs (demo)</li>
                    <li>Nubosidad RainViewer IR</li>
                    <li>EUMETSAT: Cloud Top Height, Tormentas electricas (LI AFA), RGB Conveccion</li>
                    <li>SIGMETs (Iberia + Europa O. + N-Africa)</li>
                    <li>METAR / TAF</li>
                  </ul>
                </li>
                <li><b>Trafico</b> &mdash; Activa la capa de trafico aereo en vivo (airplanes.live) para un ICAO concreto.</li>
              </ul>
            </details>

            <details>
              <summary>Briefing (NOTAMs)</summary>
              <p>La seccion <b>④ Briefing</b> consulta NOTAMs (EAD/EUROCONTROL):</p>
              <ul>
                <li>Boton <b>Origen+destino del plan</b> &mdash; Carga NOTAMs de los ICAOs del plan actual.</li>
                <li>Boton <b>Consultar</b> &mdash; ICAOs libres.</li>
                <li>Filtros: tipo (Aerodromo, NAVAID, Espacios) y severidad.</li>
                <li>Cards con codigo, descripcion, vigencia y mapa.</li>
              </ul>
            </details>

            <details>
              <summary>Density Altitude (DA) y TAS corregida</summary>
              <p>La <b>DA</b> (altitud densidad) es la altitud equivalente en atmosfera estandar para la densidad real del aire actual. En dias calidos, DA &gt; PA &rarr; aire menos denso &rarr; TAS mas alta para la misma IAS.</p>
              <p>Formula: <code>DA = PA + 118.8 &times; (OAT &minus; ISA_temp(PA))</code></p>
              <p>TSAgestor calcula DA por waypoint usando la temperatura de Open-Meteo (cuando hay vientos cargados) y corrige la TAS via tabla bilineal KIAS&times;DA. La tropopausa (36089 ft) se respeta: arriba de ahi T_ISA es constante a &minus;56.5&deg;C.</p>
              <p><b>Hover</b> sobre cualquier celda <b>TAS</b> del log de combustible para ver la DA y la OAT media usadas.</p>
            </details>

            <details>
              <summary>Atajos de teclado</summary>
              <table class="b1-help-shortcuts">
                <tr><td><kbd>M</kbd></td><td>Cicla el panel lateral: abierto &rarr; colapsado (rail) &rarr; oculto.</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>Cierra el cajon inferior. Si hay modal abierto, lo cierra primero.</td></tr>
                <tr><td>Doble click en el mapa</td><td>Durante modo dibujo: termina la ruta.</td></tr>
              </table>
              <p>Las combinaciones <kbd>Ctrl</kbd>+<kbd>M</kbd>, <kbd>Cmd</kbd>+<kbd>M</kbd>, <kbd>Alt</kbd>+<kbd>M</kbd> NO se interceptan (son atajos del SO).</p>
            </details>

            <details>
              <summary>Glosario</summary>
              <div class="b1-help-glossary">

                <h4 class="b1-help-cat">Velocidades</h4>
                <dl class="b1-help-dl">
                  <dt><code>IAS</code></dt><dd><b>Indicated Airspeed</b><br><span class="dim">Velocidad indicada por el anemometro &mdash; sin corregir.</span></dd>
                  <dt><code>TAS</code></dt><dd><b>True Airspeed</b><br><span class="dim">Velocidad real respecto al aire. Sube con la altitud porque baja la densidad.</span></dd>
                  <dt><code>GS</code></dt><dd><b>Ground Speed</b><br><span class="dim">Velocidad respecto al suelo &mdash; TAS + componente de viento en el track.</span></dd>
                </dl>

                <h4 class="b1-help-cat">Altitudes y atmosfera</h4>
                <dl class="b1-help-dl">
                  <dt><code>FL</code></dt><dd><b>Flight Level</b><br><span class="dim">Altitud en centenares de pies con QNH 29.92" (ej. FL250 = 25 000 ft).</span></dd>
                  <dt><code>PA</code></dt><dd><b>Pressure Altitude</b><br><span class="dim">Altitud calculada con presion estandar &mdash; equivale a FL &times; 100.</span></dd>
                  <dt><code>DA</code></dt><dd><b>Density Altitude</b><br><span class="dim">PA corregida por temperatura. En dias calidos DA &gt; PA &rarr; aire menos denso &rarr; TAS mas alta para la misma IAS.</span></dd>
                  <dt><code>OAT</code></dt><dd><b>Outside Air Temperature</b><br><span class="dim">Temperatura ambiente exterior, en &deg;C.</span></dd>
                  <dt><code>ISA</code></dt><dd><b>International Standard Atmosphere</b><br><span class="dim">Atmosfera estandar de referencia. T_ISA(SL) = 15&deg;C, lapse rate &minus;1.98&deg;C/1000 ft hasta tropopausa (36 089 ft) &mdash; arriba constante a &minus;56.5&deg;C.</span></dd>
                </dl>

                <h4 class="b1-help-cat">Combustible</h4>
                <dl class="b1-help-dl">
                  <dt><code>BINGO</code></dt><dd><b>Combustible minimo</b><br><span class="dim">Cantidad para regresar a origen sin reservas. Si se cruza, hay que abortar.</span></dd>
                  <dt><code>JOKER</code></dt><dd><b>Combustible de aviso</b><br><span class="dim">Marca el momento recomendado para empezar el regreso (BINGO + reserva).</span></dd>
                </dl>

                <h4 class="b1-help-cat">Aeronautico y meteo</h4>
                <dl class="b1-help-dl">
                  <dt><code>TSA</code></dt><dd><b>Temporary Segregated Area</b><br><span class="dim">Zona del espacio aereo reservada temporalmente para uso militar / ejercicios.</span></dd>
                  <dt><code>NOTAM</code></dt><dd><b>Notice to Air Missions</b><br><span class="dim">Aviso sobre cambios o restricciones que afectan a la operacion.</span></dd>
                  <dt><code>ICAO</code></dt><dd><b>Codigo OACI</b><br><span class="dim">Identificador aeronautico de 4 letras (ej. LEMD = Madrid-Barajas).</span></dd>
                  <dt><code>METAR</code></dt><dd><b>Aviation Routine Weather Report</b><br><span class="dim">Observacion meteo horaria de un aerodromo.</span></dd>
                  <dt><code>TAF</code></dt><dd><b>Terminal Aerodrome Forecast</b><br><span class="dim">Pronostico meteo (~24-30 h) para un aerodromo.</span></dd>
                  <dt><code>SIGMET</code></dt><dd><b>Significant Meteorological Information</b><br><span class="dim">Aviso de fenomenos meteo significativos (tormentas, turbulencia, cenizas, etc.).</span></dd>
                  <dt><code>WMS</code></dt><dd><b>Web Map Service</b><br><span class="dim">Protocolo OGC para servir tiles raster &mdash; usado por las capas EUMETSAT.</span></dd>
                </dl>

              </div>
            </details>

            <details>
              <summary>Persistencia y recuperacion</summary>
              <ul>
                <li>El estado del layout (seccion activa, anchos del panel/drawer) se guarda en <code>localStorage</code> bajo la clave <code>tsagestor_b1_layout</code>.</li>
                <li>Los planes calculados pueden guardarse desde la seccion Plan (lista <b>Planes guardados</b>).</li>
                <li>Para resetear el layout: borra la clave en DevTools o ejecuta <code>localStorage.removeItem('tsagestor_b1_layout')</code> y recarga.</li>
              </ul>
            </details>
          </div>
        </div>
      </div>
    `;
  }

  // ── Construye la estructura B1 e inyecta antes del primer hijo ───
  function _buildShell() {
    _shell = document.createElement('div');
    _shell.className = 'b1-shell';
    _shell.setAttribute('data-panel-state', state.panelState);
    _shell.setAttribute('data-drawer-state', state.drawerState);
    _shell.innerHTML = `
      <header class="b1-header">
        <div class="b1-brand">
          <img src="assets/rokiski-blanco.svg" alt="" aria-hidden="true">
          <span class="b1-brand-name">TSAgestor</span>
        </div>
        <nav class="b1-stepper" role="tablist" aria-label="Secciones de la aplicación"></nav>
        <div class="b1-actions">
          <button class="b1-icon-btn" id="b1-help-btn" title="Ayuda" aria-label="Abrir ayuda">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </button>
          <button class="b1-icon-btn" id="b1-export-btn" title="Exportar PDF" aria-label="Exportar PDF">📄</button>
          <button class="b1-icon-btn" id="b1-toggle-panel" title="Tecla M: cicla panel" aria-label="Alternar panel">⇔</button>
        </div>
      </header>
      <div class="b1-main">
        <aside class="b1-panel" id="b1-panel">
          <div class="b1-panel-rail" id="b1-panel-rail"></div>
          <div class="b1-panel-body" id="b1-panel-body"></div>
          <div class="b1-panel-resize" id="b1-panel-resize" role="separator" aria-orientation="vertical" aria-label="Redimensionar panel"></div>
        </aside>
        <main class="b1-map-zone" id="b1-map-zone"></main>
        <section class="b1-drawer" id="b1-drawer" aria-label="Cajón inferior con tablas">
          <div class="b1-drawer-resize" id="b1-drawer-resize" role="separator" aria-orientation="horizontal" aria-label="Redimensionar drawer"></div>
          <div class="b1-drawer-head">
            <div class="b1-drawer-tabs" id="b1-drawer-tabs"></div>
            <button class="b1-icon-btn" id="b1-drawer-collapse" title="Colapsar (Esc cierra)" aria-label="Colapsar drawer">↧</button>
            <button class="b1-icon-btn" id="b1-drawer-close" title="Cerrar" aria-label="Cerrar drawer">✕</button>
          </div>
          <div class="b1-drawer-body" id="b1-drawer-body"></div>
        </section>
      </div>
      ${_buildHelpModalHTML()}
    `;
    document.body.insertBefore(_shell, document.body.firstChild);
    // Aplica ancho persistido al panel.
    if (state.panelW > 200) {
      _shell.style.setProperty('--b1-panel-w', state.panelW + 'px');
    }
    // Drawer height en fraccion del viewport.
    if (state.drawerH > 0.1 && state.drawerH < 0.9) {
      _shell.style.setProperty('--b1-drawer-h', (state.drawerH * 100) + 'vh');
    }
    // Construye stepper buttons.
    const stepperEl = _shell.querySelector('.b1-stepper');
    const railEl    = _shell.querySelector('.b1-panel-rail');
    for (const sec of SECTIONS) {
      const btn = document.createElement('button');
      btn.className = 'b1-step';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-section', sec.id);
      btn.innerHTML = `<span class="b1-step-icon">${sec.icon}</span><span class="b1-step-label">${sec.label}</span>`;
      stepperEl.appendChild(btn);
      // Rail (modo colapsado): clon mas pequeno.
      const railBtn = btn.cloneNode(true);
      railBtn.title = sec.label;
      railEl.appendChild(railBtn);
    }
    _panel     = _shell.querySelector('#b1-panel');
    _panelBody = _shell.querySelector('#b1-panel-body');
    _panelRail = _shell.querySelector('#b1-panel-rail');
    _drawer    = _shell.querySelector('#b1-drawer');
    _drawerHead = _shell.querySelector('.b1-drawer-head');
    _drawerBody = _shell.querySelector('#b1-drawer-body');
    _mapZone   = _shell.querySelector('#b1-map-zone');
  }

  // ── Stepper ──────────────────────────────────────────────────────
  function _wireStepper() {
    _shell.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.b1-step');
      if (!btn) return;
      e.preventDefault();
      const id = btn.dataset.section;
      if (id && id !== state.section) _moveSection(id);
    });
  }

  // ── Mueve el contenido de la seccion antigua al panel ────────────
  function _moveSection(newId) {
    // Devuelve el contenido del panel anterior a su origen.
    const prev = SECTIONS.find(s => s.id === state.section);
    if (prev) {
      const prevTab = document.getElementById(prev.tabId);
      if (prevTab && prevTab.parentElement === _panelBody) {
        // Devuelve a su lugar original (en la <main> oculta dentro de #app).
        const oldMain = document.querySelector('#app > main') || document.querySelector('main');
        if (oldMain) oldMain.appendChild(prevTab);
        prevTab.classList.remove('active');
        prevTab.style.display = '';
      }
      _devolverDrawerItems(prev);
    }
    // Trae el contenido nuevo.
    const sec = SECTIONS.find(s => s.id === newId);
    if (!sec) return;
    const tab = document.getElementById(sec.tabId);
    if (tab) {
      _panelBody.appendChild(tab);
      tab.classList.add('active');
      tab.style.display = 'flex';   // tab-content usa display:flex active
    }
    state.section = newId;
    // Activa los botones del stepper (header + rail).
    _shell.querySelectorAll('.b1-step').forEach(b => {
      b.classList.toggle('is-active', b.dataset.section === newId);
      if (b.classList.contains('is-active')) b.setAttribute('aria-selected', 'true');
      else b.removeAttribute('aria-selected');
    });
    // Renderiza tabs del drawer segun seccion.
    _renderDrawerTabs(sec);
    // Dispara los hooks que en el flujo antiguo corria switchTab()
    // de app.js. Sin esto Plan no autocompleta hora UTC, Ajustes no
    // sincroniza inputs y Briefing deja el boton 'Consultar' muerto.
    try {
      const appApi = (window.TSAgestor && window.TSAgestor.app) || {};
      if (newId === 'plan'     && appApi.initPlanTab)     appApi.initPlanTab();
      if (newId === 'settings' && appApi.initSettingsTab) appApi.initSettingsTab();
      if (newId === 'datos'    && appApi.refreshExportUI) appApi.refreshExportUI();
      if (newId === 'briefing' && window.TSAgestor && window.TSAgestor.notamView
          && window.TSAgestor.notamView.onTabOpen) {
        window.TSAgestor.notamView.onTabOpen();
      }
    } catch (err) { console.warn('[b1Layout] init de seccion fallo:', err); }
    _saveState();
    // _renderDrawerTabs puede haber cerrado el drawer (si la nueva
    // seccion no tiene items) o haberlo abierto. El alto efectivo del
    // mapa cambia y Leaflet necesita recalcular para las capas WMS.
    setTimeout(_invalidateMapSize, 250);
  }

  function _devolverDrawerItems(sec) {
    const oldMain = document.querySelector('#app > main') || document.querySelector('main');
    for (const it of (sec.drawer || [])) {
      const el = document.getElementById(it.id);
      if (el && el.parentElement === _drawerBody) {
        // Prioriza la ubicacion original cacheada (donde estaba antes
        // del primer move); cae al tab actual y luego al main.
        const origin = _drawerItemOrigin.get(it.id);
        const parentTab = document.getElementById(sec.tabId);
        const target = origin || parentTab || oldMain;
        if (target) {
          target.appendChild(el);
          el.style.display = '';
        }
      }
    }
    // No usar _drawerBody.innerHTML = '' aqui: destruiria nodos que
    // todavia podriamos haber dejado dentro del drawer (p.ej. si
    // origin/parentTab no se encontraron). El bucle de arriba ya
    // limpia los items que tenian destino.
  }

  function _renderDrawerTabs(sec) {
    const tabsEl = _shell.querySelector('#b1-drawer-tabs');
    tabsEl.innerHTML = '';
    if (!sec.drawer || !sec.drawer.length) {
      // Sin contenido para el drawer en esta seccion: lo cerramos.
      if (state.drawerState !== 'closed') {
        state.drawerState = 'closed';
        _shell.setAttribute('data-drawer-state', 'closed');
        _saveState();
      }
      return;
    }
    for (const it of sec.drawer) {
      const btn = document.createElement('button');
      btn.className = 'b1-drawer-tab';
      btn.dataset.drawerItem = it.id;
      btn.textContent = it.label;
      tabsEl.appendChild(btn);
    }
    // Wire local de click (delegacion via shell ya cubre, esto refuerza).
    // Activamos un item por defecto.
    let active = state.drawerItem;
    if (!active || !sec.drawer.some(d => d.id === active)) {
      active = sec.drawer[0].id;
    }
    _activateDrawerItem(active, sec);
  }

  function _activateDrawerItem(itemId, sec) {
    sec = sec || SECTIONS.find(s => s.id === state.section);
    if (!sec) return;
    // Movemos TODOS los items del drawer al body una vez y luego
    // togleamos display. El enfoque anterior (innerHTML='' + appendChild
    // del nuevo) destruia el nodo del item previo: tras un cambio de
    // tab, ningun calculo posterior podia repoblar Log/Corte/Waypoints
    // porque sus tablas habian sido eliminadas del DOM.
    for (const it of (sec.drawer || [])) {
      const el = document.getElementById(it.id);
      if (!el) continue;
      if (el.parentElement !== _drawerBody) {
        if (!_drawerItemOrigin.has(it.id)) {
          _drawerItemOrigin.set(it.id, el.parentElement);
        }
        _drawerBody.appendChild(el);
      }
      el.style.display = (it.id === itemId) ? '' : 'none';
    }
    state.drawerItem = itemId;
    _shell.querySelectorAll('.b1-drawer-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.drawerItem === itemId);
    });
    // Si el drawer estaba cerrado, lo abre.
    if (state.drawerState === 'closed') {
      state.drawerState = 'open';
      _shell.setAttribute('data-drawer-state', 'open');
      // Abrir el drawer cambia el alto del mapa: refresca Leaflet.
      setTimeout(_invalidateMapSize, 250);
    }
    _saveState();
  }

  // ── Controles del drawer ─────────────────────────────────────────
  function _wireDrawerControls() {
    _shell.addEventListener('click', (e) => {
      // Click en tabs del drawer
      const tab = e.target.closest && e.target.closest('.b1-drawer-tab');
      if (tab) {
        e.preventDefault();
        _activateDrawerItem(tab.dataset.drawerItem);
        return;
      }
      // Boton colapsar drawer
      if (e.target.id === 'b1-drawer-collapse') {
        state.drawerState = state.drawerState === 'collapsed' ? 'open' : 'collapsed';
        _shell.setAttribute('data-drawer-state', state.drawerState);
        _saveState();
        // El alto efectivo del mapa cambia: Leaflet necesita saberlo
        // o las capas WMS (EUMETSAT, RainViewer) pediran tiles para
        // un viewport obsoleto.
        setTimeout(_invalidateMapSize, 250);
        return;
      }
      // Boton cerrar drawer
      if (e.target.id === 'b1-drawer-close') {
        state.drawerState = 'closed';
        _shell.setAttribute('data-drawer-state', 'closed');
        _saveState();
        setTimeout(_invalidateMapSize, 250);
        return;
      }
      // Boton toggle del panel (en header)
      if (e.target.id === 'b1-toggle-panel') {
        _cyclePanelState();
        return;
      }
      // Boton export
      if (e.target.id === 'b1-export-btn') {
        const exp = document.getElementById('btn-export-pdf');
        if (exp) exp.click();
        return;
      }
      // Boton ayuda (?) -> abre modal
      if (e.target.closest && e.target.closest('#b1-help-btn')) {
        _openHelpModal();
        return;
      }
    });
    // Cierre del modal de ayuda: boton X o backdrop. Esc lo cubre el
    // handler de teclado via la clase .modal:not(.hidden).
    const helpModal = _shell.querySelector('#b1-help-modal');
    if (helpModal) {
      helpModal.addEventListener('click', (e) => {
        if (e.target.id === 'b1-help-close' || e.target.id === 'b1-help-backdrop'
            || (e.target.closest && e.target.closest('#b1-help-close'))) {
          _closeHelpModal();
        }
      });
    }
  }

  function _openHelpModal() {
    const m = _shell && _shell.querySelector('#b1-help-modal');
    if (m) m.classList.remove('hidden');
  }
  function _closeHelpModal() {
    const m = _shell && _shell.querySelector('#b1-help-modal');
    if (m) m.classList.add('hidden');
  }

  // ── Tecla M cicla panel; Esc cierra drawer ───────────────────────
  function _wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!isEnabled()) return;
      // Ignora si esta escribiendo en un input/textarea.
      const t = e.target;
      if (t && t.matches && t.matches('input, textarea, select, [contenteditable]')) return;
      // No interceptamos combinaciones con modificadores (Ctrl+M, Cmd+M
      // y Alt+M tienen significados nativos: mute tab, minimizar, a11y).
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        _cyclePanelState();
      } else if (e.key === 'Escape') {
        // Prioridad de Esc: 1) cerrar modal de ayuda si esta abierto,
        // 2) dejar pasar a otros modals visibles, 3) cerrar drawer.
        const helpModal = _shell && _shell.querySelector('#b1-help-modal');
        if (helpModal && !helpModal.classList.contains('hidden')) {
          _closeHelpModal();
          return;
        }
        const modalOpen = document.querySelector('.modal:not(.hidden), [role="dialog"]:not(.hidden)');
        if (modalOpen) return;
        if (state.drawerState !== 'closed') {
          state.drawerState = 'closed';
          _shell.setAttribute('data-drawer-state', 'closed');
          _saveState();
        }
      }
    });
  }

  function _cyclePanelState() {
    const order = ['open', 'collapsed', 'hidden'];
    const cur = order.indexOf(state.panelState);
    state.panelState = order[(cur + 1) % order.length];
    _applyPanelState();
    _saveState();
    // Forzar Leaflet a recalcular tamano del contenedor.
    setTimeout(_invalidateMapSize, 250);
  }

  function _applyPanelState() {
    _shell.setAttribute('data-panel-state', state.panelState);
  }
  function _applyDrawerState() {
    _shell.setAttribute('data-drawer-state', state.drawerState);
  }

  // ── Drag bars de redimensionar ──────────────────────────────────
  function _wireResize() {
    const panelHandle  = _shell.querySelector('#b1-panel-resize');
    const drawerHandle = _shell.querySelector('#b1-drawer-resize');
    // matchMedia reacciona a rotaciones / resize, a diferencia de un
    // snapshot de innerWidth tomado al pointerdown.
    const mq = window.matchMedia('(max-width: 768px)');

    panelHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      panelHandle.classList.add('b1-dragging');
      try { panelHandle.setPointerCapture(e.pointerId); } catch (_) {}
      let isMobile = mq.matches;
      const start = isMobile ? e.clientY : e.clientX;
      const startSize = isMobile
        ? _panel.getBoundingClientRect().height
        : _panel.getBoundingClientRect().width;
      const move = (ev) => {
        isMobile = mq.matches; // recalcula por si rotan a mitad
        const cur = isMobile ? ev.clientY : ev.clientX;
        const delta = isMobile ? (start - cur) : (cur - start);
        const newSize = Math.max(220, Math.min(isMobile ? window.innerHeight - 120 : window.innerWidth - 120, startSize + delta));
        if (isMobile) {
          _panel.style.height = newSize + 'px';
          state.panelH = newSize / window.innerHeight;
        } else {
          _shell.style.setProperty('--b1-panel-w', newSize + 'px');
          state.panelW = newSize;
        }
      };
      // cleanup robusto: pointerup + pointercancel + blur de la
      // ventana (cubre el caso de soltar el boton fuera del viewport,
      // donde algunos navegadores nunca emiten pointerup).
      const cleanup = () => {
        try { panelHandle.releasePointerCapture(e.pointerId); } catch (_) {}
        panelHandle.classList.remove('b1-dragging');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', cleanup);
        document.removeEventListener('pointercancel', cleanup);
        window.removeEventListener('blur', cleanup);
        _saveState();
        _invalidateMapSize();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', cleanup);
      document.addEventListener('pointercancel', cleanup);
      window.addEventListener('blur', cleanup);
    });

    drawerHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drawerHandle.classList.add('b1-dragging');
      try { drawerHandle.setPointerCapture(e.pointerId); } catch (_) {}
      const startY = e.clientY;
      const startH = _drawer.getBoundingClientRect().height;
      const vh = window.innerHeight;
      const move = (ev) => {
        const delta = startY - ev.clientY;
        const newH = Math.max(120, Math.min(vh - 120, startH + delta));
        _shell.style.setProperty('--b1-drawer-h', newH + 'px');
        state.drawerH = newH / vh;
      };
      const cleanup = () => {
        try { drawerHandle.releasePointerCapture(e.pointerId); } catch (_) {}
        drawerHandle.classList.remove('b1-dragging');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', cleanup);
        document.removeEventListener('pointercancel', cleanup);
        window.removeEventListener('blur', cleanup);
        _saveState();
        _invalidateMapSize();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', cleanup);
      document.addEventListener('pointercancel', cleanup);
      window.addEventListener('blur', cleanup);
    });
  }

  // ── Mueve el div del mapa al map-zone ────────────────────────────
  function _moveMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl) {
      console.warn('[b1Layout] no se encontro #map; el mapa no se movera');
      return;
    }
    if (mapEl.parentElement === _mapZone) return;
    // Tambien movemos la toolbar del mapa fuera de #tab-map y la
    // ponemos flotante sobre el mapa.
    const mapTab = document.getElementById('tab-map');
    const toolbar = mapTab ? mapTab.querySelector('.toolbar') : null;
    _mapZone.appendChild(mapEl);
    if (toolbar) {
      toolbar.classList.add('b1-map-toolbar');
      _mapZone.appendChild(toolbar);
    }
    // Mueve el banner de 'Dibujar ruta' DIRECTAMENTE A BODY (no a
    // _mapZone). Aunque position:fixed deberia hacerlo independiente
    // del ancestro, .b1-main lleva overflow:hidden y eso puede
    // recortar el banner en algunos navegadores y reducir su z-index
    // efectivo al stacking context interno del shell. En body queda
    // fuera de toda jerarquia B1, asi que su z-index 9000 cubre
    // panel, drawer, header, toolbar y los controles Leaflet.
    const drawBanner = document.getElementById('draw-banner');
    if (drawBanner) {
      drawBanner.classList.add('b1-draw-banner');
      document.body.appendChild(drawBanner);
    }
    _invalidateMapSize();
  }

  function _invalidateMapSize() {
    const lmap = window._tsa_leaflet_map;
    if (lmap && lmap.invalidateSize) {
      try { lmap.invalidateSize(); } catch (_) {}
    }
  }

  return { init, isEnabled };
})();

// Auto-init en DOMContentLoaded si el body tiene .b1.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (window.TSAgestor && window.TSAgestor.b1Layout) {
      window.TSAgestor.b1Layout.init();
    }
  });
} else {
  if (window.TSAgestor && window.TSAgestor.b1Layout) {
    window.TSAgestor.b1Layout.init();
  }
}
