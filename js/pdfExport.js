// Exportador de informe PDF con jsPDF + autoTable + captura del corte.
// Incluye:
//   • Plan de vuelo (resumen, cadena de ruta, conflictos, waypoints)
//   • Log de combustible (con marcas JOKER / BINGO)
//   • Tabla de TSAs filtradas (si hay)
//   • Imagen del corte transversal (si hay ≥ 2 TSAs)

window.TSAgestor = window.TSAgestor || {};
window.TSAgestor.pdfExport = (function () {
  'use strict';

  const filters = window.TSAgestor.filters;
  const crossSection = window.TSAgestor.crossSection;

  // Audit B1 (blocker): doc.save() en Safari iOS/iPadOS NO descarga
  // — abre el blob inline como Untitled, sin opcion de guardar. iPad
  // EFB es plataforma target del producto (apple-mobile-web-app-capable,
  // manifest icon, etc.). Helper que prefiere Web Share API (la unica
  // forma fiable de "guardar archivo" en iOS), fallback a
  // URL.createObjectURL + a[download] (funciona en Safari Mac, Chrome,
  // Firefox, etc.), y solo como ultimo recurso doc.save() nativo.
  // Tambien resuelve el mismo problema en KML/JSON downloads — el
  // helper esta exportado.
  async function saveDocCompat(doc, filename) {
    if (!doc || typeof doc.output !== 'function') {
      // Fallback inseguro: usar API nativa
      if (doc && typeof doc.save === 'function') doc.save(filename);
      return;
    }
    let blob = null;
    try {
      blob = doc.output('blob');
    } catch (_) {
      try { doc.save(filename); } catch (_) {}
      return;
    }
    // Camino 1: Web Share API con File (iOS Safari 14+, iPadOS, Chrome).
    // Permite guardar en Files / iCloud Drive / share-sheet.
    try {
      if (typeof File === 'function' && typeof navigator !== 'undefined' &&
          typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
        const file = new File([blob], filename, { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      }
    } catch (e) {
      // Si el usuario cancela el share-sheet o falla, caemos al fallback.
      if (e && e.name === 'AbortError') return;
    }
    // Camino 2: URL.createObjectURL + a[download]. Funciona en Chrome,
    // Edge, Firefox, Safari Mac. Falla silenciosamente en Safari iOS
    // (abre inline) pero no rompe.
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke al minuto — algunos browsers necesitan el URL alive
      // mientras la descarga progresa.
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
      return;
    } catch (_) {}
    // Camino 3 (ultimo recurso): doc.save nativo.
    try { doc.save(filename); } catch (_) {}
  }

  // Audit B1 secundario: helper para descargas de texto/blob no-PDF
  // (KML, JSON backup, GRAMET PNG, etc.). Misma estrategia que
  // saveDocCompat pero sin doc.output — recibe el blob/string directo.
  async function downloadAsFile(content, filename, mime) {
    mime = mime || 'application/octet-stream';
    const blob = (content instanceof Blob)
      ? content
      : new Blob([content], { type: mime });
    try {
      if (typeof File === 'function' && typeof navigator !== 'undefined' &&
          typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
        const file = new File([blob], filename, { type: mime });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
    } catch (_) {}
  }

  // Audit M1 (major): probe que el plugin autoTable se cargo. Si
  // cdnjs esta bloqueado (CSP, corporate proxy, primer load offline
  // antes del cache), jsPDF carga pero el plugin no, y el primer
  // doc.autoTable() crashea con TypeError cryptico. Mejor un error
  // claro upfront que el operador puede actuar (re-conectar, refresh).
  function _assertAutoTable(doc) {
    if (typeof doc.autoTable !== 'function') {
      throw new Error('Plugin autoTable no disponible — verifique conectividad al CDN o cache offline. Recargue la pagina con Ctrl+Shift+R.');
    }
  }

  // Audit M2 + M3 (majors): centraliza el patron disable-button +
  // async-call + restore-button + toast. Antes _exportFlownPdf y
  // exportFlownPdfByName no tenian guard de reentrancia — doble click
  // arrancaba dos exports paralelos con el mismo filename y CPU spike.
  // Uso: await withExportLock(btn, async () => { ... await ... });
  async function withExportLock(btn, asyncFn) {
    if (!asyncFn) return;
    let originalText = null;
    if (btn) {
      if (btn.disabled) return; // reentrancia bloqueada
      btn.disabled = true;
      originalText = btn.textContent;
      btn.textContent = 'Generando…';
    }
    try {
      return await asyncFn();
    } finally {
      if (btn) {
        btn.disabled = false;
        if (originalText != null) btn.textContent = originalText;
      }
    }
  }

  function iso(d) { return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z'; }
  function ymdhm(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  }

  function icaoCoord(lat, lon) {
    const fmt = (v, deg, pos, neg) => {
      const sign = v >= 0 ? pos : neg;
      const a = Math.abs(v);
      const d = Math.floor(a);
      const m = Math.round((a - d) * 60);
      const dd = m === 60 ? d + 1 : d;
      const mm = m === 60 ? 0 : m;
      return String(dd).padStart(deg, '0') + String(mm).padStart(2, '0') + sign;
    };
    return fmt(lat, 2, 'N', 'S') + fmt(lon, 3, 'E', 'W');
  }
  function wpDisplay(wp) {
    if (!wp) return '—';
    const isDecimalCoords = /^-?\d+\.\d+,-?\d+\.\d+$/.test(wp.name || '');
    if (!wp.name || isDecimalCoords) return icaoCoord(wp.lat, wp.lon);
    if (wp.tsa && wp.name === wp.tsa.name) return icaoCoord(wp.lat, wp.lon);
    return wp.name;
  }

  // Carga el logo EA y lo cachea como dataURL para reutilizar entre exports.
  // Audit M5/m5 + m13: cache en sessionStorage para sobrevivir hard
  // reload (Ctrl+Shift+R) sin re-fetch del SW. Cachear la Promise (no
  // el valor) evita race entre dos exports concurrentes que
  // arrancarian dos Image loaders. m2: quitar crossOrigin innecesario
  // en same-origin — en Firefox file:// puede romper el load.
  const LOGO_CACHE_KEY = 'tsagestor_pdf_logo_dataurl_v1';
  let _logoPromise = null;
  async function loadLogoDataURL() {
    if (_logoPromise) return _logoPromise;
    // Cache de sessionStorage si existe (sobrevive hard reload).
    try {
      const raw = sessionStorage.getItem(LOGO_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && cached.dataUrl) {
          _logoPromise = Promise.resolve(cached);
          return _logoPromise;
        }
      }
    } catch (_) {}
    _logoPromise = new Promise((resolve) => {
      const img = new Image();
      // Sin crossOrigin: el logo es same-origin (assets/...) y el
      // atributo puede romper carga en Firefox file:// o en CDNs sin
      // CORS headers.
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          const result = {
            dataUrl: c.toDataURL('image/png'),
            w: img.naturalWidth,
            h: img.naturalHeight,
          };
          try { sessionStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(result)); } catch (_) {}
          resolve(result);
        } catch (e) {
          console.warn('[pdfExport] Logo EA fallo al renderizar a canvas:', e && e.message);
          resolve(null);
        }
      };
      img.onerror = () => {
        console.warn('[pdfExport] Logo EA no se pudo cargar — el PDF sale sin escudo institucional');
        resolve(null);
      };
      img.src = 'assets/logo-ea-azul.png';
    });
    return _logoPromise;
  }
  function formatUTC(d) {
    if (!d) return '—';
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
  }
  function formatDuration(min) {
    if (!Number.isFinite(min)) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}min` : `${m} min`;
  }
  function formatLat(v) {
    const sign = v >= 0 ? 'N' : 'S';
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return String(d).padStart(2, '0') + '°' + m.toFixed(1).padStart(4, '0') + "'" + sign;
  }
  function formatLon(v) {
    const sign = v >= 0 ? 'E' : 'W';
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return String(d).padStart(3, '0') + '°' + m.toFixed(1).padStart(4, '0') + "'" + sign;
  }
  function fmtNum(v) { return Math.round(v).toLocaleString('es-ES'); }

  function ensureSpace(doc, y, needed, margin) {
    if (y + needed > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      return margin;
    }
    return y;
  }
  function sectionHeader(doc, title, y, margin) {
    y = ensureSpace(doc, y, 14, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30, 41, 59);
    doc.text(title, margin, y);
    doc.setDrawColor(30, 41, 59);
    doc.setLineWidth(0.4);
    doc.line(margin, y + 1.5, doc.internal.pageSize.getWidth() - margin, y + 1.5);
    doc.setTextColor(0);
    return y + 7;
  }

  // ── TSAs ───────────────────────────────────────────────────────────

  function buildTSARows(tsas) {
    const fmt = window.TSAgestor.scheduleFmt;
    const rows = [];
    for (const tsa of tsas) {
      if (!tsa.schedules.length) {
        rows.push([tsa.name, tsa.vertical.lowerLabel, tsa.vertical.upperLabel, '—']);
        continue;
      }
      const groups = fmt ? fmt.listText(tsa.schedules) : tsa.schedules.map(s =>
        `${s.startUTC.toISOString().slice(0,10)} ${s.startUTC.toISOString().slice(11,16)}Z–${s.endUTC.toISOString().slice(11,16)}Z`
      );
      rows.push([
        tsa.name,
        tsa.vertical.lowerLabel,
        tsa.vertical.upperLabel,
        groups.join('\n'),
      ]);
    }
    return rows;
  }

  function renderTSASection(doc, tsas, filterState, margin, y) {
    y = sectionHeader(doc, `TSAs incluidas (${tsas.length})`, y, margin);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text(`Filtro: ${filters.summaryText(filterState)}`, margin, y);
    y += 5;
    doc.setTextColor(0);
    doc.autoTable({
      startY: y,
      head: [['Nombre', 'Lím. inferior', 'Lím. superior', 'Ventanas horarias (UTC)']],
      body: buildTSARows(tsas),
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255 },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      margin: { left: margin, right: margin },
    });
    return doc.lastAutoTable.finalY + 8;
  }

  // ── Plan de vuelo ──────────────────────────────────────────────────

  function renderPlanSection(doc, plan, margin, pageW, y) {
    y = sectionHeader(doc, 'Plan de vuelo', y, margin);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);
    const lines = [
      `Origen → Destino:  ${plan.origin}  →  ${plan.destination}`,
      `Distancia:  ${plan.distanceNM.toFixed(1)} NM  (${plan.distanceKM.toFixed(0)} km)        Tiempo estimado:  ${formatDuration(plan.timeMinutes)}`,
      `Nivel base:  FL${plan.flightLevel}        Velocidad base:  ${plan.speedKt} kt`,
      `Salida UTC:  ${formatUTC(plan.departureUTC)}        ETA UTC:  ${formatUTC(plan.eta)}`,
    ];
    const maxLineW = pageW - margin * 2;
    for (const line of lines) {
      const wrapped = doc.splitTextToSize(line, maxLineW);
      for (const w of wrapped) {
        y = ensureSpace(doc, y, 5, margin);
        doc.text(w, margin, y);
        y += 5;
      }
    }
    if (plan.route.direct) {
      doc.setTextColor(180, 130, 30);
      doc.setFont('helvetica', 'italic');
      doc.text('Ruta directa: no se halló ruta por aerovías o resultaba >60% más larga', margin, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(40);
    }
    y += 2;

    // Cadena de ruta (narrative)
    y = ensureSpace(doc, y, 14, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text('Cadena de ruta:', margin, y);
    y += 4;
    doc.setFont('courier', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(20, 60, 120);
    const narrativeLines = doc.splitTextToSize(plan.narrative, pageW - margin * 2);
    for (const line of narrativeLines) {
      y = ensureSpace(doc, y, 4, margin);
      doc.text(line, margin, y);
      y += 4;
    }
    doc.setTextColor(0);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    y += 4;

    // Conflictos
    if (plan.conflicts && plan.conflicts.length) {
      y = ensureSpace(doc, y, 10, margin);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(180, 30, 30);
      doc.setFontSize(10);
      doc.text(`Conflictos con TSAs activas: ${plan.conflicts.length}`, margin, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(80);
      for (const c of plan.conflicts) {
        const text = `• ${c.tsa.name}  (${c.tsa.vertical.lowerLabel} – ${c.tsa.vertical.upperLabel})  · segmento ${wpDisplay(c.segment.from)} → ${wpDisplay(c.segment.to)}  · paso ${formatUTC(c.tStart)} – ${formatUTC(c.tEnd)}`;
        const wrapped = doc.splitTextToSize(text, pageW - margin * 2);
        for (const line of wrapped) {
          y = ensureSpace(doc, y, 4, margin);
          doc.text(line, margin, y);
          y += 4;
        }
      }
      doc.setTextColor(0);
      y += 3;
    }

    // Tabla de waypoints
    // Test report: numeracion alineada con el mapa y el log Live —
    // sub-legs de climb/descent (isClimbDescentSub) muestran "↳"
    // continuacion en vez de un numero. Antes cada sub-leg ocupaba
    // un "WP X" propio, descuadrando la numeracion respecto al mapa.
    let _planRealIdx = 0;
    y = ensureSpace(doc, y, 20, margin);
    doc.autoTable({
      startY: y,
      head: [['#', 'Waypoint', 'FL', 'Aerovía', 'Latitud', 'Longitud', 'Tramo NM', 'Acum NM', 'ETA UTC']],
      body: plan.coords.map((c, i) => {
        const isSub = !!c.isClimbDescentSub;
        let displayN;
        if (!isSub) {
          _planRealIdx++;
          displayN = String(_planRealIdx);
        } else {
          displayN = '↳';
        }
        return [
          displayN,
          c.name,
          c.fl != null ? 'FL' + c.fl : '—',
          c.airway,
          formatLat(c.lat),
          formatLon(c.lon),
          i === 0 ? '—' : (c.legDistKm / 1.852).toFixed(1),
          c.cumDistNM.toFixed(1),
          formatUTC(c.etaUTC),
        ];
      }),
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      didParseCell: function (data) {
        if (data.section !== 'body') return;
        const row = plan.coords[data.row.index];
        if (row && row.tsa) {
          data.cell.styles.fillColor = [254, 226, 226];
        }
        if (row && row.fl != null && row.fl !== plan.flightLevel && data.column.index === 2) {
          data.cell.styles.textColor = [180, 130, 30];
          data.cell.styles.fontStyle = 'bold';
        }
      },
      margin: { left: margin, right: margin },
    });
    return doc.lastAutoTable.finalY + 8;
  }

  // ── Log de combustible ─────────────────────────────────────────────

  function renderFuelSection(doc, fuel, coords, margin, pageW, y) {
    y = sectionHeader(doc, 'Log de vuelo y combustible', y, margin);
    const u = fuel.unit || '';

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);
    const lines = [
      `Inicial: ${fmtNum(fuel.initialFuel)} ${u}        Consumo base: ${fmtNum(fuel.fuelFlow)} ${u}/h        IAS base: ${fuel.defaultSpeedKt} kt`,
      `Total consumido: ${fmtNum(fuel.totalFuelUsed)} ${u}        Restante en destino: ${fmtNum(fuel.finalRemaining)} ${u}        Tiempo total: ${formatDuration(fuel.totalTimeMin)}`,
    ];
    // Test report: convierte raw idx a real-WP num (saltando sub-legs)
    // para que "wpt #N" coincida con la numeracion del mapa/log/tabla.
    function _rawToRealIdx(rawIdx) {
      if (!Array.isArray(coords) || rawIdx == null) return rawIdx != null ? rawIdx + 1 : null;
      let count = 0;
      for (let i = 0; i <= rawIdx && i < coords.length; i++) {
        if (!coords[i].isClimbDescentSub) count++;
      }
      return count;
    }
    if (fuel.jokerFuel != null) {
      lines.push(`JOKER: ${fmtNum(fuel.jokerFuel)} ${u}` + (fuel.firstJokerIdx != null ? `  (alcanzado en wpt #${_rawToRealIdx(fuel.firstJokerIdx)})` : '  (no alcanzado)'));
    }
    if (fuel.bingoFuel != null) {
      lines.push(`BINGO: ${fmtNum(fuel.bingoFuel)} ${u}` + (fuel.firstBingoIdx != null ? `  (alcanzado en wpt #${_rawToRealIdx(fuel.firstBingoIdx)})` : '  (no alcanzado)'));
    }
    if (fuel.hasWinds && fuel.windLevel) {
      lines.push(`Vientos en altura: nivel ${fuel.windLevel.hPa} hPa (≈ FL${Math.round(fuel.windLevel.ft / 100)}) — pronóstico Open-Meteo, look-up por ETA real de cada waypoint`);
    }
    // Envolvemos cada linea por si excede el ancho util: si no, jsPDF no
    // hace word-wrap y termina rederizando el texto "letra-a-letra" o salido
    // del margen. La nota de vientos en altura es la mas susceptible.
    const maxLineW = pageW - margin * 2;
    for (const line of lines) {
      const wrapped = doc.splitTextToSize(line, maxLineW);
      for (const w of wrapped) {
        y = ensureSpace(doc, y, 5, margin);
        doc.text(w, margin, y);
        y += 5;
      }
    }
    if (!fuel.reachesDestination) {
      y = ensureSpace(doc, y, 6, margin);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(180, 30, 30);
      doc.text('COMBUSTIBLE INSUFICIENTE para llegar al destino', margin, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(40);
    }
    y += 2;

    // Tabla por tramos. Mantenemos las columnas IAS / TAS / Viento / GS
    // para que el PDF tenga el mismo layout que el log en pantalla. Si no
    // se han cargado vientos, las celdas Viento/GS muestran "—". TAS = IAS
    // corregida por altitud densidad (tabla bilineal en geom.kiasToTAS).
    y = ensureSpace(doc, y, 20, margin);
    const head = ['#', 'Waypoint', 'Tramo NM', 'IAS kt', 'TAS kt', 'Viento', 'GS kt',
                  'T tramo', 'T total', `Cons ${u}/h`, `Comb tramo ${u}`,
                  `Restante ${u}`, 'Estado'];
    const statusColIdx = head.length - 1;
    // Test report: misma logica de numeracion que renderPlanSection —
    // sub-legs muestran "↳" en lugar de un numero secuencial. coords[r.index]
    // permite detectar isClimbDescentSub. Si coords no se paso (caller
    // legacy), fallback a "r.index + 1" sin cambio.
    let _fuelRealIdx = 0;
    doc.autoTable({
      startY: y,
      head: [head],
      body: fuel.rows.map(r => {
        const c = (Array.isArray(coords) && coords[r.index]) || null;
        const isSub = !!(c && c.isClimbDescentSub);
        let displayN;
        if (!isSub) {
          _fuelRealIdx++;
          displayN = String(_fuelRealIdx);
        } else {
          displayN = '↳';
        }
        return [
        displayN,
        r.name,
        (r.index === 0 || r.isHold) ? '—' : r.legDistNM.toFixed(1),
        (r.index === 0 || r.isHold) ? '—' : (Number.isFinite(r.legIAS) ? Math.round(r.legIAS) : '—'),
        (r.index === 0 || r.isHold) ? '—' : (Number.isFinite(r.legSpeedKt) ? Math.round(r.legSpeedKt) : '—'),
        (r.index === 0 || !r.wind) ? '—'
          : `${String(Math.round(r.wind.dir)).padStart(3, '0')}/${Math.round(r.wind.speedKt)}`,
        (r.index === 0 || r.legGS == null) ? '—' : Math.round(r.legGS),
        r.index === 0 ? '—' : formatDuration(r.legTimeMin),
        formatDuration(r.cumTimeMin),
        r.index === 0 ? '—' : Math.round(r.legFuelFlow),
        r.index === 0 ? '—' : fmtNum(r.legFuel),
        fmtNum(r.remaining),
        r.status === 'bingo' ? 'BINGO' : (r.status === 'joker' ? 'JOKER' : '—'),
      ]),
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      didParseCell: function (data) {
        if (data.section !== 'body') return;
        const r = fuel.rows[data.row.index];
        if (!r) return;
        if (r.status === 'bingo') {
          data.cell.styles.fillColor = [254, 202, 202];
          if (data.column.index === statusColIdx) data.cell.styles.fontStyle = 'bold';
        } else if (r.status === 'joker') {
          data.cell.styles.fillColor = [254, 240, 138];
          if (data.column.index === statusColIdx) data.cell.styles.fontStyle = 'bold';
        }
      },
      margin: { left: margin, right: margin },
    });
    return doc.lastAutoTable.finalY + 8;
  }

  // ── Meteorología en ruta (METAR / TAF) ─────────────────────────────

  // Formatea METAR/TAF para el PDF: primero el código crudo, una línea en
  // blanco, y debajo la decodificación en español línea por línea.
  function formatMetarTafForPDF(weatherItem, type) {
    if (!weatherItem || !weatherItem.raw) return '— sin datos —';
    const raw = weatherItem.raw;
    const dec = window.TSAgestor && window.TSAgestor.metarDecode;
    if (!dec) return raw;
    const lines = type === 'metar' ? dec.decodeMETAR(raw) : dec.decodeTAF(raw);
    if (!lines || !lines.length) return raw;
    const decoded = lines.map(d => `${d.label}: ${d.value}`).join('\n');
    return raw + '\n\n' + decoded;
  }

  function renderMeteoSection(doc, meteo, margin, pageW, y) {
    if (!meteo || !meteo.length) return y;
    y = sectionHeader(doc, `Meteorología en ruta — ${meteo.length} aeropuertos`, y, margin);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(80);
    doc.text(
      'Origen: NOAA Aviation Weather Center · cada celda muestra el código crudo arriba y la decodificación en español debajo.',
      margin, y, { maxWidth: pageW - margin * 2 });
    y += 5;
    doc.setTextColor(0);

    const rows = meteo.map(it => {
      const cat = (it.metar && it.metar.category) || '—';
      const distNM = (it.distanceKm / 1.852).toFixed(0);
      const head = `${it.icao}${it.name ? '\n' + it.name : ''}\n${cat} · ${distNM} NM`;
      const metarTxt = formatMetarTafForPDF(it.metar, 'metar');
      const tafTxt   = formatMetarTafForPDF(it.taf,   'taf');
      return [head, metarTxt, tafTxt];
    });

    doc.autoTable({
      startY: y,
      head: [['Aeropuerto', 'METAR (UTC)', 'TAF (UTC)']],
      body: rows,
      styles: { fontSize: 7.5, cellPadding: 2, valign: 'top', overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 36, fontStyle: 'bold', fontSize: 8 },
        1: { fontSize: 7 },
        2: { fontSize: 7 },
      },
      headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didParseCell: function (data) {
        if (data.section !== 'body') return;
        const m = meteo[data.row.index];
        if (!m || !m.metar) return;
        const cat = m.metar.category;
        // Colorear la celda de aeropuerto por categoría de vuelo
        if (data.column.index === 0 && cat) {
          if      (cat === 'VFR')  data.cell.styles.fillColor = [187, 247, 208];
          else if (cat === 'MVFR') data.cell.styles.fillColor = [191, 219, 254];
          else if (cat === 'IFR')  data.cell.styles.fillColor = [254, 202, 202];
          else if (cat === 'LIFR') data.cell.styles.fillColor = [233, 213, 255];
        }
      },
      margin: { left: margin, right: margin },
    });
    return doc.lastAutoTable.finalY + 8;
  }

  // ── OLA2: SIGMETs (briefing PDF unificado) ───────────────────────
  function renderSigmetsSection(doc, sigmets, margin, pageW, y) {
    if (!Array.isArray(sigmets) || !sigmets.length) return y;
    y = sectionHeader(doc, `SIGMETs activos en area — ${sigmets.length} avisos`, y, margin);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(80);
    doc.text(
      'Aviation Weather Center · cruce con la ruta no se evalua aqui (ver corte y card Amenazas en Live).',
      margin, y, { maxWidth: pageW - margin * 2 });
    y += 5;
    doc.setTextColor(0);
    const rows = sigmets.map(s => {
      const id   = s.icaoId || s.firId || '';
      const tipo = s.hazard || s.type || '';
      const fl1  = s.altitudeLow1 || '';
      const fl2  = s.altitudeHi1 || '';
      const fl   = (fl1 || fl2) ? `FL${fl1}-FL${fl2}` : '—';
      const valid = (s.validTimeFrom && s.validTimeTo)
        ? `${shortIso(s.validTimeFrom)} → ${shortIso(s.validTimeTo)}` : '—';
      const raw = s.rawSigmet || '—';
      return [id, tipo, fl, valid, raw];
    });
    doc.autoTable({
      startY: y,
      head: [['FIR/ID', 'Tipo', 'FL', 'Validez UTC', 'Texto']],
      body: rows,
      styles: { fontSize: 7.5, cellPadding: 2, valign: 'top', overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 25 },
        2: { cellWidth: 22 },
        3: { cellWidth: 35 },
        4: { fontSize: 7 },
      },
      headStyles: { fillColor: [120, 53, 15], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      margin: { left: margin, right: margin },
    });
    return doc.lastAutoTable.finalY + 8;
  }
  function shortIso(s) {
    try {
      const d = new Date(s);
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
    } catch (_) { return s; }
  }

  // ── OLA2: Minimos meteorologicos (briefing) ──────────────────────
  function renderWxLimitsSection(doc, wxLimits, margin, pageW, y) {
    if (!wxLimits || typeof wxLimits !== 'object') return y;
    y = sectionHeader(doc, 'Minimos meteorologicos (Weather Hold)', y, margin);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(80);
    doc.text(
      'Umbrales operativos para reproducir las decisiones GO / NO-GO de la pestania NOTAMs.',
      margin, y, { maxWidth: pageW - margin * 2 });
    y += 5;
    doc.setTextColor(0);
    const rows = [
      ['Ceiling DURO (no-go)',        wxLimits.ceilingHardFt + ' ft AGL'],
      ['Ceiling MARGINAL (warn)',     wxLimits.ceilingMarginalFt + ' ft AGL'],
      ['Visibilidad DURA (no-go)',    wxLimits.visibilityHardM + ' m'],
      ['Visibilidad MARGINAL (warn)', wxLimits.visibilityMarginalM + ' m'],
    ].filter(r => r[1] != null && r[1] !== '' && !String(r[1]).startsWith('undefined'));
    doc.autoTable({
      startY: y,
      head: [['Concepto', 'Valor']],
      body: rows,
      styles: { fontSize: 8.5, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 80, fontStyle: 'bold' },
      },
      headStyles: { fillColor: [30, 41, 59], textColor: 255 },
      margin: { left: margin, right: margin },
    });
    return doc.lastAutoTable.finalY + 8;
  }

  // ── GRAMET (audit B2) ─────────────────────────────────────────────
  // El briefing incluye la GRAMET cuando el operador la ha solicitado
  // previamente (state.lastGramet en app.js). Sin esto la GRAMET solo
  // se veia en pantalla pero nunca en el PDF — feature documentada
  // que el usuario percibia rota.
  function renderGrametSection(doc, gramet, margin, pageW, y) {
    if (!gramet || !gramet.dataUrl) return y;
    y = sectionHeader(doc, 'GRAMET — perfil meteorologico de ruta', y, margin);
    const imgW = pageW - margin * 2;
    // GRAMET de autorouter.aero suele ser ~1100x500 (aspect ~0.45).
    // Calculamos altura desde el PNG real via Image probe en el
    // momento del addImage — jsPDF acepta dataURL con dimensiones
    // implicitas, pero para fit-to-page necesitamos saberlas. Usamos
    // aspect tipico como fallback.
    const aspect = 0.45;
    const imgH = imgW * aspect;
    if (y + imgH > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
    try {
      doc.addImage(gramet.dataUrl, 'PNG', margin, y, imgW, imgH, undefined, 'FAST');
      y += imgH + 4;
      if (gramet.strategy) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(80);
        doc.text(safe('Estrategia GRAMET: ' + gramet.strategy), margin, y);
        doc.setTextColor(0);
        y += 6;
      }
    } catch (err) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(200, 50, 50);
      doc.text('No se pudo insertar la GRAMET: ' + (err && err.message ? err.message : err), margin, y);
      doc.setTextColor(0);
      y += 8;
    }
    return y;
  }

  // ── Corte transversal ─────────────────────────────────────────────

  async function renderCrossSection(doc, svgEl, margin, pageW, y) {
    y = sectionHeader(doc, 'Corte transversal', y, margin);
    try {
      const png = await crossSection.toPNGDataURL(svgEl, 2);
      const imgW = pageW - margin * 2;
      const vb = svgEl.viewBox.baseVal;
      const aspect = (vb && vb.height && vb.width) ? (vb.height / vb.width) : 0.62;
      const imgH = imgW * aspect;
      if (y + imgH > doc.internal.pageSize.getHeight() - margin) {
        doc.addPage();
        y = margin;
      }
      doc.addImage(png, 'PNG', margin, y, imgW, imgH);
      y += imgH + 6;
    } catch (err) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(200, 50, 50);
      doc.text('No se pudo insertar el corte transversal: ' + err.message, margin, y);
      doc.setTextColor(0);
      y += 5;
    }
    return y;
  }

  // ── Entry point ────────────────────────────────────────────────────

  async function exportReport(opts) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('jsPDF no disponible');
    }
    opts = opts || {};
    const tsas = opts.tsas || [];
    const filterState = opts.filterState || {};
    const svgEl = opts.svgEl || null;
    const plan = opts.plan || null;

    const { jsPDF } = window.jspdf;
    // Audit m12 (minor): compress=true reduce el tamano del PDF
    // 30-40% (importante en Safari iOS — files >5MB pueden no
    // descargar bien). jsPDF 2.5.x soporta deflate por defecto pero
    // hay que activarlo explicitamente.
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    // Audit M1: probe del plugin autoTable inmediatamente tras crear el
    // doc. Mejor error claro upfront que TypeError cryptico mas tarde.
    _assertAutoTable(doc);
    const margin = 14;
    const pageW = doc.internal.pageSize.getWidth();
    let y = margin;

    // jsPDF Helvetica usa encoding WinAnsi (CP1252) y no soporta caracteres
    // como → ≈ ≥ ≤ ✓ ✗ ⚠, que se renderizan como bytes UTF-8 sueltos (ej.
    // "→" sale como "â†'" ~ "!'"). Reemplazamos por ASCII en TODO el output:
    // monkeypatch de doc.text y doc.autoTable para no tener que recordar
    // sanear cada string a mano.
    const SAFE_MAP = [
      [/→/g, '->'], [/←/g, '<-'], [/↑/g, '^'], [/↓/g, 'v'],
      [/≈/g, '~'], [/≥/g, '>='], [/≤/g, '<='],
      [/✓/g, 'OK'], [/✗/g, 'X'], [/⚠/g, '!'],
    ];
    function safe(s) {
      if (s == null || typeof s !== 'string') return s;
      // Audit m1 (minor): normalizar a NFC para que macOS Safari
      // entrege acentos compuestos correctamente — WinAnsi NFD parte
      // los caracteres como letra + diacritic separados.
      let out = (typeof s.normalize === 'function') ? s.normalize('NFC') : s;
      for (const [re, rep] of SAFE_MAP) out = out.replace(re, rep);
      return out;
    }
    function safeRow(row) {
      return (row || []).map(c => {
        if (typeof c === 'string') return safe(c);
        if (c && typeof c === 'object' && typeof c.content === 'string') {
          return Object.assign({}, c, { content: safe(c.content) });
        }
        return c;
      });
    }
    const _origText = doc.text.bind(doc);
    doc.text = function (str, x, y, opts2) {
      if (Array.isArray(str)) str = str.map(safe);
      else                    str = safe(str);
      return _origText(str, x, y, opts2);
    };
    const _origAutoTable = doc.autoTable.bind(doc);
    doc.autoTable = function (cfg) {
      cfg = cfg || {};
      if (Array.isArray(cfg.head)) cfg.head = cfg.head.map(safeRow);
      if (Array.isArray(cfg.body)) cfg.body = cfg.body.map(safeRow);
      return _origAutoTable(cfg);
    };

    // Cabecera institucional con logo EA + filete bandera
    const logo = await loadLogoDataURL();
    const logoMaxH = 18;   // mm de alto máximo
    let logoW = 0;
    if (logo) {
      const aspect = logo.w / logo.h;
      const logoH = logoMaxH;
      logoW = logoH * aspect;
      doc.addImage(logo.dataUrl, 'PNG', margin, y, logoW, logoH);
    }
    // Texto a la derecha del logo
    const textX = margin + (logoW ? logoW + 5 : 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(0, 55, 100);   // Gris aviador #003764
    const title = plan
      ? `TSAgestor — ${plan.origin} → ${plan.destination}`
      : 'TSAgestor — Informe de TSAs';
    doc.text(title, textX, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(78, 115, 138); // Azul medio
    doc.text('EJÉRCITO DEL AIRE Y DEL ESPACIO · VISOR TSA & PLANIFICADOR', textX, y + 11);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Generado: ${iso(new Date())}`, textX, y + 16);
    // Filete bandera bicolor bajo la cabecera
    y += logoMaxH + 2;
    doc.setDrawColor(173, 46, 28);   // Rojo bandera
    doc.setLineWidth(0.6);
    doc.line(margin, y, pageW / 2, y);
    doc.setDrawColor(250, 194, 0);   // Amarillo bandera
    doc.line(pageW / 2, y, pageW - margin, y);
    y += 5;
    doc.setTextColor(0);

    // Plan de vuelo + Log de combustible
    if (plan) {
      y = renderPlanSection(doc, plan, margin, pageW, y);
      if (plan.fuel) {
        y = renderFuelSection(doc, plan.fuel, plan.coords, margin, pageW, y);
      }
      if (plan.meteo && plan.meteo.length) {
        y = renderMeteoSection(doc, plan.meteo, margin, pageW, y);
      }
    }
    // OLA2 briefing: SIGMETs y minimos meteo si fueron pasados en opts.
    if (Array.isArray(opts.sigmets) && opts.sigmets.length) {
      y = renderSigmetsSection(doc, opts.sigmets, margin, pageW, y);
    }
    if (opts.wxLimits) {
      y = renderWxLimitsSection(doc, opts.wxLimits, margin, pageW, y);
    }
    // Audit B2: GRAMET (si el operador la cargo en el panel correspondiente
    // y corresponde al plan actual; el caller en app.js valida match).
    if (opts.gramet && opts.gramet.dataUrl) {
      y = renderGrametSection(doc, opts.gramet, margin, pageW, y);
    }

    // TSAs (si hay)
    if (tsas.length > 0) {
      y = renderTSASection(doc, tsas, filterState, margin, y);
    }

    // Corte transversal (si hay ≥ 2 TSAs y SVG válido)
    if (svgEl && tsas.length >= 2) {
      y = await renderCrossSection(doc, svgEl, margin, pageW, y);
    }

    const stamp = ymdhm(new Date());
    const fname = plan
      ? `tsagestor-plan-${plan.origin}-${plan.destination}-${stamp}.pdf`
      : `tsagestor-${stamp}.pdf`;
    // Audit B1: saveDocCompat con Web Share API para iOS + fallback
    // a[download] para Chrome/Edge/Firefox/Safari Mac. await para
    // capturar AbortError si el operador cancela el share-sheet.
    await saveDocCompat(doc, fname);
    return fname;
  }

  // F3.9: After Action Report — PDF con resumen de la sesion Live real
  // vs plan original. snapshot es lo que devuelve
  // livePlan.buildFlownSnapshot(): { meta, coords, plannedEtas,
  // plannedFuelRest, actualPassTimes, fuelOverrides, ..., events[] }.
  async function exportLiveDelta(snapshot) {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF no disponible');
    if (!snapshot) throw new Error('snapshot vacío');

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    _assertAutoTable(doc);
    const margin = 14;
    const pageW = doc.internal.pageSize.getWidth();
    let y = margin;

    // Sanitize WinAnsi (mismo patron que exportReport)
    const SAFE_MAP = [
      [/→/g, '->'], [/←/g, '<-'], [/↑/g, '^'], [/↓/g, 'v'],
      [/≈/g, '~'], [/≥/g, '>='], [/≤/g, '<='],
      [/✓/g, 'OK'], [/✗/g, 'X'], [/⚠/g, '!'], [/Δ/g, 'D'], [/↩/g, '<-'],
    ];
    function safe(s) {
      if (s == null || typeof s !== 'string') return s;
      // Audit m1 (minor): normalizar a NFC para que macOS Safari
      // entrege acentos compuestos correctamente — WinAnsi NFD parte
      // los caracteres como letra + diacritic separados.
      let out = (typeof s.normalize === 'function') ? s.normalize('NFC') : s;
      for (const [re, rep] of SAFE_MAP) out = out.replace(re, rep);
      return out;
    }
    function safeRow(row) {
      return (row || []).map(c => {
        if (typeof c === 'string') return safe(c);
        if (c && typeof c === 'object' && typeof c.content === 'string') {
          return Object.assign({}, c, { content: safe(c.content) });
        }
        return c;
      });
    }
    const _origText = doc.text.bind(doc);
    doc.text = function (str, x, y, opts2) {
      if (Array.isArray(str)) str = str.map(safe);
      else                    str = safe(str);
      return _origText(str, x, y, opts2);
    };
    const _origAutoTable = doc.autoTable.bind(doc);
    doc.autoTable = function (cfg) {
      cfg = cfg || {};
      if (Array.isArray(cfg.head)) cfg.head = cfg.head.map(safeRow);
      if (Array.isArray(cfg.body)) cfg.body = cfg.body.map(safeRow);
      return _origAutoTable(cfg);
    };

    // Cabecera institucional
    const logo = await loadLogoDataURL();
    const logoMaxH = 18;
    let logoW = 0;
    if (logo) {
      const aspect = logo.w / logo.h;
      logoW = logoMaxH * aspect;
      doc.addImage(logo.dataUrl, 'PNG', margin, y, logoW, logoMaxH);
    }
    const textX = margin + (logoW ? logoW + 5 : 0);
    const m = snapshot.meta || {};
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(0, 55, 100);
    const title = `TSAgestor AAR — ${m.origin || '?'} → ${m.destination || '?'}` +
                  (m.rtbEngaged ? ' (RTB)' : '');
    doc.text(title, textX, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(78, 115, 138);
    doc.text('AFTER ACTION REPORT · Sesión Live real vs Plan original', textX, y + 11);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Generado: ${iso(new Date())}`, textX, y + 16);
    y += logoMaxH + 2;
    doc.setDrawColor(173, 46, 28);
    doc.setLineWidth(0.6);
    doc.line(margin, y, pageW / 2, y);
    doc.setDrawColor(250, 194, 0);
    doc.line(pageW / 2, y, pageW - margin, y);
    y += 5;
    doc.setTextColor(0);

    // ── Resumen ──
    y = sectionHeader(doc, 'Resumen del vuelo', y, margin);
    const startMs = Number.isFinite(m.startMs) ? m.startMs : null;
    const endMs   = Number.isFinite(m.endMs)   ? m.endMs   : null;
    const planEndMs = Number.isFinite(m.planEndMs) ? m.planEndMs : null;
    const planStartMs = Number.isFinite(m.planStartMs) ? m.planStartMs : null;
    const realDurMin = (startMs && endMs) ? (endMs - startMs) / 60000 : null;
    const planDurMin = (planStartMs && planEndMs) ? (planEndMs - planStartMs) / 60000 : null;
    const deltaMin = (realDurMin != null && planDurMin != null) ? (realDurMin - planDurMin) : null;
    const summary = [
      ['Origen → Destino',    `${m.origin || '?'} -> ${m.destination || '?'}`],
      ['Despegue (real)',     startMs ? formatUTC(new Date(startMs)) : '—'],
      ['Aterrizaje (real)',   endMs   ? formatUTC(new Date(endMs))   : '—'],
      ['Duración real',       realDurMin != null ? formatDuration(realDurMin) : '—'],
      ['Duración planificada',planDurMin != null ? formatDuration(planDurMin) : '—'],
      ['Delta ETA',           deltaMin != null ? `${deltaMin >= 0 ? '+' : ''}${Math.round(deltaMin)} min` : '—'],
      ['Combustible inicial', m.initialFuel != null ? `${fmtNum(m.initialFuel)} ${m.fuelUnit || ''}` : '—'],
      ['Combustible final',   m.finalFuel != null ? `${fmtNum(m.finalFuel)} ${m.fuelUnit || ''}` : '—'],
      ['Consumo real',        m.fuelConsumed != null ? `${fmtNum(m.fuelConsumed)} ${m.fuelUnit || ''}` : '—'],
      ['Consumo planificado', m.fuelConsumedPlan != null ? `${fmtNum(m.fuelConsumedPlan)} ${m.fuelUnit || ''}` : '—'],
      ['Delta combustible',   (m.fuelConsumed != null && m.fuelConsumedPlan != null)
                                ? `${(m.fuelConsumed - m.fuelConsumedPlan) >= 0 ? '+' : ''}${Math.round(m.fuelConsumed - m.fuelConsumedPlan)} ${m.fuelUnit || ''}` : '—'],
      ['Distancia total',     m.totalDistNM != null ? `${Math.round(m.totalDistNM)} NM` : '—'],
      ['Modo RTB engaged',    m.rtbEngaged ? 'SI' : 'No'],
    ];
    doc.autoTable({
      startY: y, margin: { left: margin, right: margin },
      head: [['Concepto', 'Valor']],
      body: summary,
      styles: { fontSize: 9, cellPadding: 1.5 },
      headStyles: { fillColor: [0, 55, 100], textColor: 255 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 60 } },
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── Tabla delta WP por WP ──
    // Test report: misma logica de numeracion que las tablas del plan
    // — los rows con isSub=true (sub-legs de climb/descent) muestran
    // "↳" en la columna # en lugar de un numero secuencial. Antes
    // el AAR marcaba cada sub-leg como un WP propio.
    y = sectionHeader(doc, 'Delta por waypoint (plan vs real)', y, margin);
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const head = [['#', 'Waypoint', 'FL', 'ETA plan', 'ETA real', 'D min', 'Fuel plan', 'Fuel real', 'D fuel', 'Hold']];
    let _aarRealIdx = 0;
    const body = rows.map((r, i) => {
      const fl = Number.isFinite(r.fl) ? `FL${String(r.fl).padStart(3, '0')}` : '—';
      const etaP = Number.isFinite(r.planEta) ? formatUTC(new Date(r.planEta)).slice(11, 16) : '—';
      const etaR = Number.isFinite(r.liveEta) ? formatUTC(new Date(r.liveEta)).slice(11, 16) : '—';
      const dEta = (Number.isFinite(r.planEta) && Number.isFinite(r.liveEta))
        ? Math.round((r.liveEta - r.planEta) / 60000) : null;
      const fp = Number.isFinite(r.planFuelRest) ? Math.round(r.planFuelRest) : '—';
      const fr = Number.isFinite(r.fuelRest)     ? Math.round(r.fuelRest)     : '—';
      const dF = (Number.isFinite(r.planFuelRest) && Number.isFinite(r.fuelRest))
        ? Math.round(r.fuelRest - r.planFuelRest) : null;
      const hold = Number.isFinite(r.liveHoldMin) && r.liveHoldMin > 0 ? `${r.liveHoldMin}m` : '';
      let displayN;
      if (!r.isSub) {
        _aarRealIdx++;
        displayN = String(_aarRealIdx);
      } else {
        displayN = '↳';
      }
      return [
        displayN,
        r.name || '—',
        fl,
        etaP,
        etaR,
        dEta != null ? (dEta >= 0 ? '+' : '') + dEta : '—',
        fp,
        fr,
        dF != null ? (dF >= 0 ? '+' : '') + dF : '—',
        hold,
      ];
    });
    doc.autoTable({
      startY: y, margin: { left: margin, right: margin },
      head, body,
      styles: { fontSize: 8, cellPadding: 1.2 },
      headStyles: { fillColor: [0, 55, 100], textColor: 255 },
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── Eventos ──
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    if (events.length > 0) {
      y = sectionHeader(doc, 'Eventos durante el vuelo', y, margin);
      const evRows = events.map(e => [
        e.time ? formatUTC(new Date(e.time)).slice(11, 16) : '—',
        e.type || '—',
        e.detail || '—',
      ]);
      doc.autoTable({
        startY: y, margin: { left: margin, right: margin },
        head: [['Hora UTC', 'Tipo', 'Detalle']],
        body: evRows,
        styles: { fontSize: 9, cellPadding: 1.5 },
        headStyles: { fillColor: [0, 55, 100], textColor: 255 },
        columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 35, fontStyle: 'bold' } },
      });
      y = doc.lastAutoTable.finalY + 6;
    }

    // ── OLA3: Event log estructurado (append-only) ──
    const eventLog = Array.isArray(snapshot.eventLog) ? snapshot.eventLog : [];
    if (eventLog.length > 0) {
      y = sectionHeader(doc, 'Event log estructurado (' + eventLog.length + ' eventos)', y, margin);
      const TYPE_LABEL = {
        'start': 'DESPEGUE', 'advance': 'AVANCE', 'back': 'RETROCESO',
        'hold': 'HOLD', 'override-apply': 'OVERRIDE', 'override-clear': 'OV. LIMPIADO',
        'calibrate': 'CALIBRACION', 'rtb-engage': 'RTB ENGAGE', 'rtb-cancel': 'RTB CANCEL',
      };
      const elRows = eventLog.map(ev => {
        const t = new Date(ev.t || 0);
        const hh = String(t.getUTCHours()).padStart(2, '0');
        const mm = String(t.getUTCMinutes()).padStart(2, '0');
        const ss = String(t.getUTCSeconds()).padStart(2, '0');
        const detail = ev.payload
          ? Object.keys(ev.payload).map(k => k + '=' + JSON.stringify(ev.payload[k])).join(' · ')
          : '';
        return [
          hh + ':' + mm + ':' + ss + 'Z',
          'WP#' + ((ev.currentIdx | 0) + 1),
          TYPE_LABEL[ev.type] || ev.type,
          detail,
        ];
      });
      doc.autoTable({
        startY: y, margin: { left: margin, right: margin },
        head: [['UTC', 'En WP', 'Accion', 'Payload']],
        body: elRows,
        styles: { fontSize: 7.5, cellPadding: 1.2, overflow: 'linebreak' },
        headStyles: { fillColor: [0, 55, 100], textColor: 255 },
        columnStyles: {
          0: { cellWidth: 18 },
          1: { cellWidth: 14 },
          2: { cellWidth: 28, fontStyle: 'bold' },
          3: { fontSize: 7 },
        },
        alternateRowStyles: { fillColor: [248, 250, 252] },
      });
      y = doc.lastAutoTable.finalY + 6;
    }

    const stamp = ymdhm(new Date());
    const fname = `tsagestor-aar-${m.origin || 'XX'}-${m.destination || 'XX'}-${stamp}.pdf`;
    await saveDocCompat(doc, fname);
    return fname;
  }

  // Audit B1 secundario: exporta saveDocCompat + downloadAsFile para
  // que callers de KML/JSON/GRAMET PNG puedan usar la misma logica
  // de Web Share API + fallback en lugar de a[download] crudo.
  return { exportReport, exportLiveDelta, saveDocCompat, downloadAsFile, withExportLock };
})();
