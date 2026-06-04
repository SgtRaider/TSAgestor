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
  // - live: heartbeat / pulse line para tracking en vuelo
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
    live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 12h4l2-6 4 12 3-9 2 3h3"/></svg>',
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
    { id: 'live',     icon: ICONS.live,     label: 'Live',     tabId: 'tab-live',    drawer: [
      { id: 'live-log-table-wrap',   label: 'Log live' },
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
            <h2 id="b1-help-title">Guia de TSAgestor</h2>
            <button class="b1-icon-btn" id="b1-help-close" title="Cerrar (Esc)" aria-label="Cerrar ayuda">✕</button>
          </header>
          <div class="b1-help-body">

            <nav class="b1-help-toc" aria-label="Indice">
              <h3>Indice</h3>
              <ol>
                <li><a href="#h-bienvenida" data-help-toc>Bienvenida y proposito</a></li>
                <li><a href="#h-anatomia" data-help-toc>Anatomia de la interfaz</a></li>
                <li><a href="#h-flujo" data-help-toc>Flujo de trabajo recomendado</a></li>
                <li><a href="#h-inicio" data-help-toc>Seccion <b>Inicio</b></a></li>
                <li><a href="#h-datos" data-help-toc>Seccion <b>Datos</b></a></li>
                <li><a href="#h-plan" data-help-toc>Seccion <b>Plan</b></a></li>
                <li><a href="#h-briefing" data-help-toc>Seccion <b>Briefing</b></a></li>
                <li><a href="#h-ajustes" data-help-toc>Seccion <b>Ajustes</b></a></li>
                <li><a href="#h-mapa" data-help-toc>El mapa: toolbar, leyendas, controles</a></li>
                <li><a href="#h-dibujo" data-help-toc>Modo dibujo de ruta</a></li>
                <li><a href="#h-motor" data-help-toc>Como se calcula el plan (motor)</a></li>
                <li><a href="#h-da" data-help-toc>Density Altitude y TAS corregida</a></li>
                <li><a href="#h-capas-meteo" data-help-toc>Capas meteorologicas en detalle</a></li>
                <li><a href="#h-notams" data-help-toc>NOTAMs y briefing</a></li>
                <li><a href="#h-pdf" data-help-toc>Exportar a PDF</a></li>
                <li><a href="#h-atajos" data-help-toc>Atajos de teclado</a></li>
                <li><a href="#h-persistencia" data-help-toc>Persistencia y datos guardados</a></li>
                <li><a href="#h-glosario" data-help-toc>Glosario</a></li>
                <li><a href="#h-faq" data-help-toc>Solucion de problemas (FAQ)</a></li>
                <li><a href="#h-creditos" data-help-toc>Creditos y fuentes</a></li>
              </ol>
            </nav>

            <details open id="h-bienvenida">
              <summary>1. Bienvenida y proposito</summary>
              <p><b>TSAgestor</b> es un planificador de vuelo tactico orientado a operacion en espacios aereos con TSAs (Temporary Segregated Areas) y a tripulaciones que necesitan integrar de forma rapida datos de aerovias, restricciones temporales, NOTAMs y meteo en un solo briefing.</p>
              <p>Esta guia esta organizada en bloques tematicos accesibles desde el indice. Si es tu primera vez:</p>
              <ol>
                <li>Lee <b>Anatomia de la interfaz</b> para situarte en el layout B1 (mapa full-canvas + panel lateral + cajon inferior).</li>
                <li>Sigue <b>Flujo de trabajo recomendado</b> para entender el ciclo basico (cargar KML &rarr; planificar &rarr; briefing).</li>
                <li>Consulta el bloque concreto cuando lo necesites.</li>
              </ol>
              <p>La aplicacion funciona offline tras el primer arranque (Service Worker cachea recursos), excepto las llamadas a APIs externas (Open-Meteo, EUMETSAT, RainViewer, airplanes.live).</p>
            </details>

            <details id="h-anatomia">
              <summary>2. Anatomia de la interfaz</summary>
              <p>El layout B1 organiza la pantalla en cuatro zonas:</p>
              <ul>
                <li><b>Cabecera superior</b> &mdash; Logo TSAgestor a la izquierda, stepper con las 5 secciones en el centro, acciones a la derecha (<kbd>?</kbd> ayuda, <kbd>📄</kbd> PDF, <kbd>⇔</kbd> toggle panel).</li>
                <li><b>Panel lateral izquierdo</b> &mdash; Contenido de la seccion activa: formularios, listas, cards. Redimensionable arrastrando el borde derecho. La tecla <kbd>M</kbd> cicla su estado entre abierto, colapsado (rail con iconos) y oculto.</li>
                <li><b>Mapa (fondo)</b> &mdash; Ocupa toda la pantalla detras del panel y el drawer. Toolbar flotante en la esquina superior derecha (Centrar / Leyenda TSAs / Capas / Trafico) y controles nativos de Leaflet en las esquinas (zoom abajo-izquierda, capas en topleft).</li>
                <li><b>Cajon inferior (drawer)</b> &mdash; Aparece automaticamente para tablas anchas. Pestanas configuradas por seccion: en Plan trae Log de combustible / Corte transversal / Waypoints. Redimensionable verticalmente. <kbd>Esc</kbd> lo cierra.</li>
              </ul>
              <p>La filosofia es mantener el mapa siempre visible. El panel y el drawer flotan encima, no recortan el mapa.</p>
            </details>

            <details id="h-flujo">
              <summary>3. Flujo de trabajo recomendado</summary>
              <p>Ciclo tipico de un briefing tactico:</p>
              <ol>
                <li><b>Carga datos</b> (seccion Datos): sube el KML/KMZ del dia con las TSAs publicadas. Las TSAs detectadas aparecen en el mapa y en la tabla del drawer.</li>
                <li><b>Filtra TSAs</b>: usa los chips <i>Trabajo</i> / <i>Transito</i> / <i>Active now</i> y el rango fecha/hora para quedarte solo con las que aplican a tu ventana operativa.</li>
                <li><b>Configura el plan</b> (seccion Plan): origen, destino, via opcional, FL y IAS, hora UTC de salida, combustible inicial y consumo.</li>
                <li><b>Calcular ruta</b>: genera log de combustible, corte transversal y tabla de waypoints. Si no defines via, el planificador la calcula usando las aerovias activadas.</li>
                <li><b>Carga vientos en altura</b> (boton <i>Cargar vientos</i> en el formulario): trae datos de Open-Meteo por waypoint en todos los niveles ISA. La GS y la TAS se recalculan con la densidad real (DA).</li>
                <li><b>Activa capas meteo</b> (toolbar &rarr; Capas): RainViewer para nubes IR, EUMETSAT para tormentas / convencion, SIGMETs para avisos formales, METAR/TAF para aerodromos.</li>
                <li><b>Consulta NOTAMs</b> (seccion Briefing): pulsa <i>Origen+destino del plan</i> para autocompletar, o introduce ICAOs libres.</li>
                <li><b>Exporta PDF</b> (boton <kbd>📄</kbd> del header): genera el briefing completo con plan, log, corte, waypoints y NOTAMs en un PDF imprimible.</li>
              </ol>
            </details>

            <details id="h-inicio">
              <summary>4. Seccion Inicio</summary>
              <p>Pantalla de bienvenida tras cargar la app. Resume el proposito y ofrece accesos rapidos a las acciones mas habituales (cargar KML, ver planes guardados, abrir ayuda).</p>
              <p>Si la app detecta que es tu primera visita en esta sesion, muestra automaticamente este modal de ayuda y un breve overlay de bienvenida. Pulsando <i>No mostrar de nuevo</i> en ese overlay no aparece mas hasta que se borre <code>sessionStorage</code>.</p>
            </details>

            <details id="h-datos">
              <summary>5. Seccion Datos</summary>

              <h4>Cargar KML / KMZ</h4>
              <p>Arrastra el fichero sobre la zona de carga, o usa el boton <i>Cargar archivo</i>. El parser detecta:</p>
              <ul>
                <li>Placemarks con poligonos (TSAs, zonas reservadas).</li>
                <li>Atributos <code>name</code>, <code>description</code>, <code>TimeSpan</code>.</li>
                <li>Estilos KML (colores, lineas) para diferenciar tipos.</li>
              </ul>
              <p>Soporta KMZ (KML comprimido en ZIP) y carga directamente desde URL si se especifica con drag desde otra pestana del navegador.</p>

              <h4>Filtros</h4>
              <p>El filter-bar contiene:</p>
              <ul>
                <li><b>Chips por categoria</b> &mdash; Trabajo (verde) / Transito (rojo) / Active now (TSAs activas en este preciso instante UTC).</li>
                <li><b>Rango fecha/hora</b> &mdash; Desde / Hasta. Limita las TSAs visibles a las que solapan el rango.</li>
                <li><b>Quick-select chips</b> &mdash; Atajos: <i>Hoy</i>, <i>Manyana</i>, <i>Hoy+Manyana</i>, <i>Semana</i>.</li>
              </ul>

              <h4>Tabla de TSAs detectadas (drawer)</h4>
              <p>Lista todas las TSAs cargadas con:</p>
              <ul>
                <li>Nombre, tipo (Trabajo/Transito), ventana temporal, FL inferior/superior, area.</li>
                <li>Checkbox para activar/desactivar cada una en el mapa.</li>
                <li>Boton para seleccionar todas / ninguna / solo activas-ahora.</li>
                <li>Click en una fila &mdash; centra el mapa sobre esa TSA.</li>
              </ul>
            </details>

            <details id="h-plan">
              <summary>6. Seccion Plan</summary>

              <h4>Formulario base</h4>
              <ul>
                <li><b>Origen / Destino</b> &mdash; ICAOs OACI de 4 letras (ej. LEMD, LEZG).</li>
                <li><b>Via</b> &mdash; Waypoints intermedios separados por espacio o coma. Acepta codigos de waypoint estandar (CCS, NDB, VOR, fixes 5-letras). Si lo dejas vacio, el planificador calcula la ruta automatica usando las aerovias activadas en el mapa.</li>
                <li><b>Nivel (FL)</b> &mdash; FL de cruise (FL100 = 10 000 ft).</li>
                <li><b>IAS (kt)</b> &mdash; Velocidad indicada del cruise. Tipico para entrenamiento militar: 200&ndash;300 kt segun avion.</li>
                <li><b>Salida (UTC)</b> &mdash; Fecha y hora UTC del despegue. Se usa para ETA de cada waypoint y para look-up de vientos por hora.</li>
              </ul>

              <h4>Combustible</h4>
              <ul>
                <li><b>Inicial</b> &mdash; Combustible a bordo al despegue.</li>
                <li><b>Consumo (/h)</b> &mdash; Flujo base por hora a cruise. Puede sobreescribirse por tramo en el log.</li>
                <li><b>Unidad</b> &mdash; lb o kg (la app convierte internamente, todas las cifras del PDF salen en la unidad seleccionada).</li>
                <li><b>JOKER</b> &mdash; Combustible de aviso (momento recomendado para iniciar el regreso). Por debajo, el log marca el tramo en color naranja.</li>
                <li><b>BINGO</b> &mdash; Combustible minimo absoluto. Por debajo, el log marca en rojo y muestra "COMBUSTIBLE INSUFICIENTE".</li>
              </ul>

              <h4>Acciones</h4>
              <ul>
                <li><b>Calcular ruta</b> &mdash; Genera el plan completo: ruta en el mapa, log de combustible, corte transversal y tabla de waypoints.</li>
                <li><b>Dibujar en mapa</b> &mdash; Activa el modo dibujo para anyadir waypoints intermedios graficamente. Ver bloque dedicado.</li>
                <li><b>Cargar vientos (Open-Meteo)</b> &mdash; Tras calcular, este boton aparece habilitado. Pide vientos en altura por waypoint en todos los niveles ISA disponibles. Una vez cargados, la GS y la TAS reflejan la densidad real (DA).</li>
                <li><b>Limpiar</b> &mdash; Resetea el formulario a los valores guardados en Ajustes.</li>
                <li><b>Guardar plan / Importar plan</b> &mdash; Persistencia en localStorage. Ver bloque dedicado.</li>
              </ul>

              <h4>Tabs del drawer (resultados)</h4>
              <ul>
                <li><b>Log de combustible</b> &mdash; Tabla tramo a tramo: # / Waypoint / Tramo NM / IAS kt / TAS kt / Viento / GS kt / Tiempo / Combustible / Restante / Estado. La columna IAS es editable por leg (override por tramo). La de TAS es read-only (se recalcula del IAS y la DA). El estado muestra <b>OK</b>, <b>JOKER</b> o <b>BINGO</b> en colores. <b>Hover</b> sobre TAS muestra DA y OAT usadas.</li>
                <li><b>Corte transversal</b> &mdash; Perfil vertical del vuelo: eje X = distancia acumulada, eje Y = FL. Sobre el perfil se pintan opcionalmente las nubes (Open-Meteo) o el GRAMET (Autorouter, requiere credenciales).</li>
                <li><b>Waypoints y coordenadas</b> &mdash; Lista de waypoints reales (sin holds): #, codigo, FL, aerovia, lat, lon, tramo, acumulado, ETA UTC.</li>
              </ul>

              <h4>Editar tramo a tramo (holds y overrides)</h4>
              <ul>
                <li>En el log, cada IAS es editable: introduce el valor para ese leg concreto (override).</li>
                <li>El consumo (Flow) tambien es editable por tramo &mdash; util para configurar perfiles especificos (ascenso vs cruise vs descenso).</li>
                <li>Boton <b>+ Espera</b> en cualquier fila &mdash; inserta una fila de hold despues. Edita los minutos de hold; la app suma el combustible al cumulativo y avanza la ETA del resto del plan.</li>
                <li>Boton <b>X</b> en una fila de hold &mdash; la elimina.</li>
              </ul>

              <h4>Planes guardados</h4>
              <p>Lista los planes guardados con su nombre y resumen. Acciones:</p>
              <ul>
                <li><b>Guardar plan actual</b> &mdash; Pide un nombre y guarda formulario + ruta + log en localStorage.</li>
                <li><b>Importar plan</b> &mdash; Carga un plan guardado en el formulario (sin ejecutar Calcular automaticamente, para que puedas revisar antes).</li>
                <li><b>Eliminar</b> &mdash; Borra el plan guardado.</li>
              </ul>
            </details>

            <details id="h-briefing">
              <summary>7. Seccion Briefing</summary>
              <p>Bloque para consultar NOTAMs y meteo de aerodromos.</p>
              <h4>NOTAMs</h4>
              <ul>
                <li><b>Origen+destino del plan</b> &mdash; Carga NOTAMs de los ICAOs del plan actual con una sola pulsacion.</li>
                <li><b>Consultar</b> &mdash; Introduce ICAOs libres separados por espacio (hasta 10 por consulta).</li>
                <li>Las cards muestran codigo NOTAM, tipo, vigencia (desde / hasta UTC), descripcion y un mini-mapa con la zona afectada cuando aplica.</li>
              </ul>
              <h4>Filtros de NOTAMs</h4>
              <ul>
                <li>Por tipo: Aerodromo, NAVAID, Espacios aereos, Otros.</li>
                <li>Por severidad: urgent (rojo), info (azul).</li>
                <li>Por texto libre en codigo o descripcion.</li>
              </ul>
              <h4>Meteo de aerodromo (METAR / TAF)</h4>
              <p>Al consultar un ICAO se decodifica el METAR y TAF de aviationweather.gov. La card muestra el raw + el decode legible (visibilidad, viento, ceiling, temp, dewpoint).</p>
            </details>

            <details id="h-ajustes">
              <summary>8. Seccion Ajustes</summary>
              <p>Preferencias persistentes que se aplican como defaults al formulario del plan:</p>
              <ul>
                <li><b>Velocidad base (IAS kt)</b> &mdash; IAS preconfigurada al hacer <i>Limpiar</i>.</li>
                <li><b>Consumo base (/h)</b> &mdash; Flow preconfigurado.</li>
                <li><b>Unidad</b> &mdash; lb / kg.</li>
                <li><b>FL preferido</b> &mdash; FL por defecto.</li>
                <li><b>JOKER por defecto</b> y <b>BINGO por defecto</b>.</li>
                <li><b>Opacidad de cada capa meteo</b> &mdash; sliders para RainViewer, CTH, LI AFA, RGB Convection.</li>
              </ul>
              <p>Estos valores se guardan en localStorage con clave <code>tsagestor_settings</code>.</p>
            </details>

            <details id="h-mapa">
              <summary>9. El mapa: toolbar, leyendas y controles</summary>

              <h4>Toolbar flotante (esquina superior derecha)</h4>
              <ul>
                <li><b>Centrar</b> &mdash; Encuadra el mapa sobre las TSAs visibles (o sobre el plan calculado).</li>
                <li><b>Leyenda TSAs</b> &mdash; Toggle de la leyenda flotante. Lista en 3 columnas todas las TSAs activas hoy + manyana, agrupadas por nombre/lateral con la ventana temporal de cada una.</li>
                <li><b>Capas</b> &mdash; Toggle del control nativo de Leaflet con todas las overlays disponibles.</li>
                <li><b>Trafico</b> &mdash; Activa el panel para introducir un ICAO y mostrar trafico en vivo (airplanes.live).</li>
              </ul>

              <h4>Capas disponibles (control de Leaflet)</h4>
              <ul>
                <li><b>Aerovias alta NE / NW / SE / SW</b> &mdash; Aerovias de cota alta por sector. Util para planning IFR de alto nivel.</li>
                <li><b>Aerovias baja NE / NW / SE / SW</b> &mdash; Aerovias de cota baja por sector.</li>
                <li><b>TMAs (demo)</b> y <b>CTRs (demo)</b> &mdash; Espacios controlados demostrativos.</li>
                <li><b>Nubosidad (RainViewer IR)</b>, <b>Cloud Top Height (EUMETSAT)</b>, <b>Tormentas electricas LI AFA</b>, <b>RGB Conveccion</b> &mdash; ver bloque Capas meteo en detalle.</li>
                <li><b>SIGMETs</b> &mdash; Avisos de fenomenos significativos. Cobertura Iberia + Europa O. + N-Africa.</li>
                <li><b>METAR / TAF</b> &mdash; Marcadores en aerodromos con tooltip al hover.</li>
              </ul>

              <h4>Controles nativos de Leaflet</h4>
              <ul>
                <li>Zoom +/- (esquina inferior-izquierda).</li>
                <li>Attribution (esquina inferior-derecha).</li>
                <li>Capas (esquina superior-izquierda) &mdash; el control que abre/cierra el boton <i>Capas</i>.</li>
              </ul>

              <h4>Interacciones</h4>
              <ul>
                <li>Click sobre una TSA &mdash; popup con detalles y boton <i>Anyadir al plan</i>.</li>
                <li>Click sobre un marcador de waypoint &mdash; se anyade al campo Via del plan.</li>
                <li>Click sobre un METAR/TAF &mdash; muestra el codigo crudo y decodificado.</li>
              </ul>
            </details>

            <details id="h-dibujo">
              <summary>10. Modo dibujo de ruta</summary>
              <ol>
                <li>Pulsa <b>Dibujar en mapa</b> en la seccion Plan.</li>
                <li>El cursor se vuelve cruz. La toolbar y los controles del mapa se ocultan automaticamente para no robar clicks.</li>
                <li>Cada click en el mapa anyade un waypoint intermedio entre origen y destino.</li>
                <li>El banner inferior muestra el contador (<i>N puntos</i>) y las acciones:
                  <ul>
                    <li><b>Deshacer</b> &mdash; Quita el ultimo waypoint anyadido.</li>
                    <li><b>Vuelta</b> &mdash; Anyade los waypoints en orden inverso para cerrar el circuito hasta origen (util para misiones IDA+VUELTA simetricas).</li>
                    <li><b>Listo</b> &mdash; Termina el dibujo y rellena automaticamente el campo Via con los waypoints (codificados como lat,lon).</li>
                    <li><b>Cancelar</b> &mdash; Descarta el dibujo sin tocar el formulario.</li>
                  </ul>
                </li>
                <li>Doble click sobre el mapa equivale a <b>Listo</b>.</li>
              </ol>
            </details>

            <details id="h-motor">
              <summary>11. Como se calcula el plan (motor interno)</summary>

              <h4>Construccion de la ruta</h4>
              <p>El planificador toma origen, destino y los waypoints intermedios del campo Via. Si Via esta vacio, busca una ruta usando las aerovias activadas en el mapa (con un algoritmo de tipo A* sobre el grafo de waypoints + aerovias). Si no hay aerovias activadas, la ruta es <b>DCT</b> (directa) entre tus puntos.</p>

              <h4>Distancias y rumbos</h4>
              <p>Cada tramo se calcula con formulas geodesicas:</p>
              <ul>
                <li>Distancia &mdash; great-circle entre los dos waypoints (Haversine, precision sub-metro).</li>
                <li>Track &mdash; rumbo geodesico inicial (sin correccion magnetica).</li>
              </ul>

              <h4>Velocidades: IAS &rarr; TAS &rarr; GS</h4>
              <p>La velocidad indicada (IAS) que introduces en el formulario es la base. La TAS se calcula con una tabla bilineal KIAS &times; altitud densidad (ver Density Altitude). La GS suma la componente de viento sobre el track:</p>
              <p><code>GS = TAS + componente_paralela_al_track</code></p>
              <p>Si la componente es negativa (viento en cara) GS &lt; TAS. Si es positiva (cola) GS &gt; TAS.</p>

              <h4>Vientos en altura</h4>
              <p>Open-Meteo devuelve viento por nivel de presion (1000 hPa &rarr; 100 hPa). La app interpola entre los dos niveles ISA que bracketean el FL del tramo, usando componentes vectoriales (u, v) para no romper en 359&deg;/0&deg;. Luego mezcla los vientos de los dos extremos del tramo segun la posicion del sub-leg.</p>

              <h4>Sub-legs en cambios de FL</h4>
              <p>Si un tramo cambia &ge; 5000 ft (ascensos, descensos, FL adaptados por TSA), se subdivide en N sub-legs de 5000 ft cada uno. Cada sub-leg calcula su viento al FL medio. El resultado se integra (suma de horas) y se devuelve un viento medio representativo.</p>

              <h4>Iteracion punto-fijo</h4>
              <p>Como la GS depende del viento y el viento depende de la ETA (hora del lookup), hay un bucle:</p>
              <ol>
                <li>1.&ordf; pasada: TAS sin viento (estimacion ISA), ETA inicial.</li>
                <li>2.&ordf; / 3.&ordf; / 4.&ordf; pasada: vuelve a calcular GS con vientos a las ETAs estimadas; refresca ETAs.</li>
                <li>El bucle converge tipicamente en 3 iteraciones.</li>
              </ol>

              <h4>Combustible</h4>
              <p>Por tramo: <code>fuel_leg = horas_leg &times; flow</code>. Acumulado y restante por waypoint. Compara con JOKER/BINGO para colorear el estado.</p>

              <h4>Holds</h4>
              <p>Una fila de hold es sintetica (no consume distancia). Su tiempo se suma al cumulativo y su combustible se calcula con el flow del tramo padre. La ETA del resto del plan se desplaza.</p>
            </details>

            <details id="h-da">
              <summary>12. Density Altitude (DA) y TAS corregida</summary>
              <p>La <b>DA</b> (altitud densidad) es la altitud equivalente en atmosfera estandar para la densidad real del aire actual. En dias calidos a la altitud de cruise, DA &gt; PA &rarr; aire menos denso &rarr; TAS mas alta para la misma IAS.</p>
              <p>Formula estandar de aviacion:</p>
              <p><code>DA = PA + 118.8 &times; (OAT &minus; ISA_temp(PA))</code></p>
              <p>Donde:</p>
              <ul>
                <li><code>PA</code> &mdash; Pressure Altitude (= FL &times; 100).</li>
                <li><code>OAT</code> &mdash; Outside Air Temperature, en &deg;C.</li>
                <li><code>ISA_temp(PA)</code> &mdash; 15 &minus; 1.98 &times; (PA/1000) hasta tropopausa (36 089 ft). Por encima, constante a &minus;56.5&deg;C.</li>
                <li><b>118.8</b> es el factor empirico estandar (a veces redondeado a 120).</li>
              </ul>
              <p>TSAgestor calcula DA por sub-leg: lookup de OAT en Open-Meteo (cuando hay vientos cargados), mezcla lineal de los dos extremos del tramo, aplica la formula y pasa la DA al lookup TAS = kiasToTAS(IAS, DA). El resultado se promedia para el tramo.</p>
              <p><b>Hover</b> sobre cualquier celda TAS del log de combustible para ver la DA y la OAT media usadas. Ejemplo: <i>TAS = kiasToTAS(120 kt, DA 27450 ft) &middot; OAT media &minus;25.3&deg;C</i>.</p>
              <p>Casos donde la correccion importa:</p>
              <ul>
                <li>Operacion estival sobre desiertos / sur de Espanya en verano: ISA+10/+15 facilmente &rarr; DA +1500/+2000 ft.</li>
                <li>Cruise a FL250&ndash;FL300 con masa de aire calida.</li>
                <li>Planificacion de altitud densidad sobre aerodromos elevados (Madrid 2 000 ft + verano = DA superficie &gt; 4 500 ft).</li>
              </ul>
            </details>

            <details id="h-capas-meteo">
              <summary>13. Capas meteorologicas en detalle</summary>

              <h4>Nubosidad RainViewer IR</h4>
              <p>Mosaico satelite IR de RainViewer (<code>tilecache.rainviewer.com</code>). Refresco cada ~10 min. Util para ver cobertura nubosa global. Antes de pedir tiles, la app hace un fetch a <code>api.rainviewer.com/public/weather-maps.json</code> para descubrir el timestamp valido actual.</p>

              <h4>Cloud Top Height (MSG &middot; EUMETSAT)</h4>
              <p>WMS de <code>view.eumetsat.int</code>. Producto MSG (Meteosat Second Generation) con altura del tope de nubes en codigo de color (FL010 &rarr; FL525). Resolucion nativa ~3 km/px. Refresco cada 15 min.</p>
              <p>Util para identificar tormentas convectivas en desarrollo (tops altos = celulas activas).</p>

              <h4>Tormentas electricas (MTG &middot; LI AFA)</h4>
              <p>WMS de EUMETSAT. Producto Lightning Imager Accumulated Flash Area de MTG-I (Meteosat Third Generation). Identifica celulas con actividad electrica reciente.</p>

              <h4>RGB Conveccion (MSG &middot; SEVIRI)</h4>
              <p>Composite RGB que destaca celulas convectivas (rojo brillante = topes muy frios + posible overshooting). Producto SEVIRI/MSG.</p>

              <h4>SIGMETs (Iberia + Europa O. + N-Africa)</h4>
              <p>Avisos formales de fenomenos significativos (tormentas, turbulencia severa, engelamiento, cenizas volcanicas). Fuente: aviationweather.gov. Las zonas se dibujan como poligonos con borde rojo y texto del aviso al hover.</p>

              <h4>METAR / TAF</h4>
              <p>Marcadores en aerodromos. Al hover muestra el codigo crudo y decodificado. Click para detalles ampliados. Fuente: aviationweather.gov.</p>

              <h4>Performance y cache</h4>
              <p>Las tiles usan <code>crossOrigin: 'anonymous'</code> donde el servidor soporta CORS (RainViewer y EUMETSAT LI/Convection) para que el Service Worker pueda cachearlas. Segundas activaciones de la misma capa son instantaneas. CTH no usa crossOrigin por compatibilidad con su producto base.</p>
            </details>

            <details id="h-notams">
              <summary>14. NOTAMs y briefing (ver tambien seccion Briefing)</summary>
              <p>Esta seccion del modal complementa la <i>seccion Briefing</i> de la app con detalle tecnico sobre como funciona la integracion:</p>
              <h4>Origen de los datos</h4>
              <ul>
                <li><b>NOTAMs</b> &mdash; Pasarela al servicio EAD/EUROCONTROL (a traves de un proxy <code>/api/notamHub</code> en el servidor remoto, o consulta directa en local).</li>
                <li><b>METAR / TAF</b> &mdash; aviationweather.gov, decodificado en cliente con <code>metarDecode.js</code>.</li>
              </ul>
              <h4>Estructura de cada card de NOTAM</h4>
              <ul>
                <li>Codigo del NOTAM (A-series, D-series).</li>
                <li>Aerodromo afectado (ICAO).</li>
                <li>Vigencia: desde / hasta UTC.</li>
                <li>Tipo: Aerodromo / NAVAID / Espacios / Otros.</li>
                <li>Severidad: urgent (rojo, ej. cierres) / info (azul, ej. cambios de frecuencia).</li>
                <li>Descripcion: texto plano del NOTAM.</li>
                <li>Mini-mapa: cuando el NOTAM trae coordenadas, mapa pequenyo de la zona afectada.</li>
              </ul>
              <h4>Filtrado</h4>
              <p>Los chips arriba de la lista filtran por tipo y severidad. El input de busqueda filtra por texto libre en codigo + descripcion.</p>
              <p>El resultado se actualiza en vivo.</p>
            </details>

            <details id="h-pdf">
              <summary>14. Exportar a PDF</summary>
              <p>Pulsa el icono <kbd>📄</kbd> del header (junto al toggle del panel) para generar el briefing en PDF. Requiere haber calculado el plan al menos una vez. El PDF incluye:</p>
              <ul>
                <li><b>Portada</b> &mdash; ICAOs, FL, IAS, hora de salida UTC, fecha de generacion.</li>
                <li><b>Resumen del plan</b> &mdash; Distancia total, tiempo, combustible inicial / consumido / restante.</li>
                <li><b>Log de combustible</b> &mdash; Tabla con todas las columnas (incluye TAS corregida por DA si hay vientos cargados).</li>
                <li><b>Corte transversal</b> &mdash; Imagen del SVG del corte (con nubes y GRAMET si se cargaron).</li>
                <li><b>Tabla de waypoints</b> &mdash; Lat/lon/FL/ETA por punto.</li>
                <li><b>Mapa</b> &mdash; Snapshot del mapa con la ruta y las TSAs activas.</li>
                <li><b>NOTAMs</b> &mdash; Si has consultado NOTAMs, se incluyen como apendice.</li>
              </ul>
              <p>Generacion del PDF: jsPDF + jsPDF-AutoTable + html2canvas. El proceso dura unos segundos en planes grandes.</p>
            </details>

            <details id="h-atajos">
              <summary>15. Atajos de teclado</summary>
              <table class="b1-help-shortcuts">
                <tr><td><kbd>M</kbd></td><td>Cicla el panel lateral: abierto &rarr; colapsado (rail) &rarr; oculto.</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>Cierra el modal de ayuda si esta abierto. Si no, cierra el cajon inferior. Si no, cancela el modo dibujo.</td></tr>
                <tr><td>Doble click en el mapa</td><td>Durante modo dibujo: termina la ruta (equivale al boton Listo).</td></tr>
                <tr><td><kbd>?</kbd> (boton header)</td><td>Abre esta guia.</td></tr>
                <tr><td><kbd>📄</kbd> (boton header)</td><td>Exporta el plan a PDF.</td></tr>
                <tr><td><kbd>⇔</kbd> (boton header)</td><td>Equivale a <kbd>M</kbd> &mdash; cicla el panel.</td></tr>
              </table>
              <p>Las combinaciones con modificadores (<kbd>Ctrl</kbd>+<kbd>M</kbd>, <kbd>Cmd</kbd>+<kbd>M</kbd>, <kbd>Alt</kbd>+<kbd>M</kbd>) NO se interceptan &mdash; son atajos del sistema operativo y se respetan.</p>
              <p>Los atajos NO se disparan cuando el foco esta en un input, textarea o select.</p>
            </details>

            <details id="h-persistencia">
              <summary>16. Persistencia y datos guardados</summary>
              <p>TSAgestor guarda en <code>localStorage</code>:</p>
              <ul>
                <li><code>tsagestor_b1_layout</code> &mdash; Estado del layout: seccion activa, estados del panel/drawer, anchos/altos.</li>
                <li><code>tsagestor_settings</code> &mdash; Preferencias de la seccion Ajustes.</li>
                <li><code>tsagestor_plans</code> &mdash; Planes guardados (nombre, formulario, ruta calculada).</li>
                <li><code>tsagestor_ar_creds</code> y <code>tsagestor_ar_token</code> &mdash; Credenciales / token de Autorouter para GRAMET (opcional).</li>
              </ul>
              <p>El Service Worker cachea:</p>
              <ul>
                <li><b>App shell</b> &mdash; HTML, CSS, JS, iconos (cache-first, version <code>tsagestor-vNNN</code>).</li>
                <li><b>Tiles meteo cacheables</b> &mdash; RainViewer y EUMETSAT LI/Convection con CORS (runtime cache).</li>
                <li><b>Datos meteo</b> &mdash; Network-first con fallback a cache si la red falla.</li>
              </ul>
              <h4>Resetear / recuperar</h4>
              <p>En DevTools (F12) &rarr; Console:</p>
              <ul>
                <li><code>localStorage.removeItem('tsagestor_b1_layout')</code> &rarr; resetea el layout al default y recarga.</li>
                <li><code>localStorage.clear()</code> &rarr; borra TODO (planes, ajustes, credenciales). Solo si quieres empezar de cero.</li>
                <li>Application &rarr; Service Workers &rarr; Unregister &rarr; recarga &rarr; fuerza el SW v actual.</li>
              </ul>
            </details>

            <details id="h-glosario">
              <summary>17. Glosario</summary>
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

            <details id="h-faq">
              <summary>18. Solucion de problemas (FAQ)</summary>

              <h4>El mapa no se ve / sale gris</h4>
              <ul>
                <li>Comprueba que tienes conexion (los tiles de OpenStreetMap requieren internet en la primera carga).</li>
                <li>DevTools (F12) &rarr; Application &rarr; Service Workers &rarr; Unregister, luego recarga con <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>.</li>
              </ul>

              <h4>Una capa meteo no aparece o tarda mucho</h4>
              <ul>
                <li>EUMETSAT WMS es lento en hora punta. Es normal que cada activacion tarde varios segundos.</li>
                <li>Si la capa <i>nunca</i> aparece, revisa Network (F12) buscando peticiones a <code>view.eumetsat.int</code> y comprueba el status (200 = ok, 5xx = servidor caido).</li>
                <li>Si la pantalla del sistema esta mal sincronizada, las consultas WMS pueden caer fuera de la ventana de datos publicados.</li>
              </ul>

              <h4>La TAS calculada no me cuadra</h4>
              <ul>
                <li>Si no has cargado vientos, la TAS asume ISA (PA = DA). Pulsa <i>Cargar vientos</i> para usar la temperatura real.</li>
                <li>Pasa el cursor sobre la celda TAS para ver la DA y OAT usadas &mdash; ahi se ve el origen de la diferencia.</li>
                <li>En cruise alto (FL360+), la app respeta la tropopausa (T_ISA constante a &minus;56.5&deg;C). Esto puede dar diferencias respecto a planificadores que extrapolan linealmente.</li>
              </ul>

              <h4>El panel se quedo oculto y no puedo recuperarlo</h4>
              <ul>
                <li>Pulsa la tecla <kbd>M</kbd>: cicla el estado (oculto &rarr; abierto).</li>
                <li>Si la tecla no responde, asegurate de no tener el foco en un input. Click sobre el mapa, luego <kbd>M</kbd>.</li>
              </ul>

              <h4>El plan no se calcula / da error</h4>
              <ul>
                <li>Verifica que origen y destino son ICAOs validos (4 letras, mayusculas).</li>
                <li>Si usas Via, comprueba que todos los waypoints existen en la base. Codigos invalidos se ignoran &mdash; pero si TODOS son invalidos, el plan se queda en DCT.</li>
                <li>Si no has activado ninguna capa de aerovias en el mapa, el planificador hace DCT entre tus waypoints (sin aerovias).</li>
              </ul>

              <h4>La leyenda TSAs no se muestra entera</h4>
              <ul>
                <li>Asegurate de que la app esta en SW v201+ (el bug del max-height inline esta fixed).</li>
                <li>Cierra el drawer si esta abierto para liberar espacio vertical.</li>
              </ul>

              <h4>El boton de PDF no responde</h4>
              <ul>
                <li>El PDF requiere haber calculado el plan al menos una vez. Sin plan calculado, el boton no hace nada.</li>
                <li>En navegadores antiguos (Chrome &lt; 90, Firefox &lt; 90) puede fallar la generacion. Usa una version reciente.</li>
              </ul>

              <h4>He perdido planes guardados / preferencias</h4>
              <ul>
                <li>Comprueba si has cambiado de navegador o limpiado datos del sitio &mdash; los datos viven en localStorage.</li>
                <li>El modo incognito no persiste &mdash; usa una ventana normal.</li>
              </ul>
            </details>

            <details id="h-creditos">
              <summary>19. Creditos y fuentes de datos</summary>
              <h4>Fuentes de datos</h4>
              <ul>
                <li><b>Aerovias y waypoints</b> &mdash; Compilados a partir de AIP de Espanya (datos demo / educativos).</li>
                <li><b>TSAs</b> &mdash; Aportadas por el usuario via KML / KMZ.</li>
                <li><b>Vientos y temperatura en altura</b> &mdash; <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (modelo GFS, gratis, sin API key, CORS abierto).</li>
                <li><b>Tiles meteo IR</b> &mdash; <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>.</li>
                <li><b>Productos satelite</b> &mdash; <a href="https://view.eumetsat.int" target="_blank" rel="noopener">EUMETSAT</a> (MSG &middot; CTH, MTG &middot; LI AFA, SEVIRI &middot; RGB Convection).</li>
                <li><b>NOTAMs y METAR/TAF</b> &mdash; EAD/EUROCONTROL y <a href="https://aviationweather.gov" target="_blank" rel="noopener">aviationweather.gov</a>.</li>
                <li><b>SIGMETs</b> &mdash; aviationweather.gov.</li>
                <li><b>Trafico en vivo</b> &mdash; <a href="https://airplanes.live" target="_blank" rel="noopener">airplanes.live</a>.</li>
                <li><b>GRAMET</b> (corte meteo opcional) &mdash; <a href="https://www.autorouter.aero" target="_blank" rel="noopener">Autorouter.aero</a> (requiere cuenta).</li>
                <li><b>Cartografia base</b> &mdash; <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a> contributors.</li>
              </ul>

              <h4>Librerias open source</h4>
              <ul>
                <li><a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet 1.9</a> &mdash; Motor cartografico.</li>
                <li><a href="https://github.com/parallax/jsPDF" target="_blank" rel="noopener">jsPDF</a> + <a href="https://github.com/simonbengtsson/jsPDF-AutoTable" target="_blank" rel="noopener">jsPDF-AutoTable</a> &mdash; Generacion del briefing PDF.</li>
                <li><a href="https://html2canvas.hertzen.com" target="_blank" rel="noopener">html2canvas</a> &mdash; Snapshot del mapa para el PDF.</li>
                <li><a href="https://mozilla.github.io/pdf.js/" target="_blank" rel="noopener">pdf.js</a> &mdash; Render de PDFs embebidos.</li>
              </ul>

              <h4>Sobre el codigo</h4>
              <p>TSAgestor es una aplicacion web estatica (HTML + CSS + JS vanilla, sin build, sin framework) que aprovecha el navegador moderno. Funciona offline tras el primer arranque (PWA con Service Worker).</p>
              <p>Codigo fuente, issues y contribuciones en el repositorio Git asociado.</p>
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
      if (newId === 'live'     && appApi.initLiveTab)     appApi.initLiveTab();
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
    // Cierre del modal de ayuda + navegacion TOC. Esc lo cubre el
    // handler de teclado via la clase .modal:not(.hidden).
    const helpModal = _shell.querySelector('#b1-help-modal');
    if (helpModal) {
      helpModal.addEventListener('click', (e) => {
        // Cierre
        if (e.target.id === 'b1-help-close' || e.target.id === 'b1-help-backdrop'
            || (e.target.closest && e.target.closest('#b1-help-close'))) {
          _closeHelpModal();
          return;
        }
        // TOC: click en un link con data-help-toc -> abre el <details>
        // correspondiente, lo asegura visible, y scrollea hasta el.
        const tocLink = e.target.closest && e.target.closest('a[data-help-toc]');
        if (tocLink) {
          e.preventDefault();
          const href = tocLink.getAttribute('href') || '';
          const id = href.replace(/^#/, '');
          if (!id) return;
          const target = helpModal.querySelector('#' + CSS.escape(id));
          if (!target) return;
          // Si es un <details>, lo abrimos.
          if (target.tagName === 'DETAILS') target.open = true;
          // Pintamos antes de scrollear para que la altura ya sea la
          // del details abierto.
          requestAnimationFrame(() => {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        }
      });
    }
  }

  function _openHelpModal() {
    const m = _shell && _shell.querySelector('#b1-help-modal');
    if (m) {
      m.classList.remove('hidden');
      // Resetea el scroll al abrir, para que el indice quede arriba.
      const body = m.querySelector('.b1-help-body');
      if (body) body.scrollTop = 0;
    }
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
