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

  // Configuracion del stepper. order = orden de aparicion en el header.
  const SECTIONS = [
    { id: 'home',     num: '①', label: 'Inicio',   tabId: 'tab-home',    drawer: [] },
    { id: 'datos',    num: '②', label: 'Datos',    tabId: 'tab-upload',  drawer: [
      { id: 'tsa-table-wrap',     label: 'TSAs detectadas' },
    ]},
    { id: 'plan',     num: '③', label: 'Plan',     tabId: 'tab-plan',    drawer: [
      { id: 'plan-log-table-wrap',   label: 'Log de combustible' },
      { id: 'cross-section-wrap',    label: 'Corte transversal' },
      { id: 'plan-coords-wrap',      label: 'Waypoints y coordenadas' },
    ]},
    { id: 'briefing', num: '④', label: 'Briefing', tabId: 'tab-notams',  drawer: [] },
    { id: 'settings', num: '⑤', label: 'Ajustes',  tabId: 'tab-settings', drawer: [] },
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
      btn.innerHTML = `<span class="b1-step-num">${sec.num}</span><span class="b1-step-label">${sec.label}</span>`;
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
    });
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
      } else if (e.key === 'Escape' && state.drawerState !== 'closed') {
        // Si hay un modal visible delante, deja que el modal capture Esc.
        const modalOpen = document.querySelector('.modal:not(.hidden), [role="dialog"]:not(.hidden)');
        if (modalOpen) return;
        state.drawerState = 'closed';
        _shell.setAttribute('data-drawer-state', 'closed');
        _saveState();
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
    // Mueve tambien el banner del modo 'Dibujar ruta' al map-zone
    // para que sea visible mientras se trazan waypoints (vive
    // originalmente dentro de #tab-map, ahora oculto en B1).
    const drawBanner = document.getElementById('draw-banner');
    if (drawBanner) {
      drawBanner.classList.add('b1-draw-banner');
      _mapZone.appendChild(drawBanner);
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
