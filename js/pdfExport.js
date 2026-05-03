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

  function iso(d) { return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z'; }
  function ymdhm(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  }

  // Carga el logo EA y lo cachea como dataURL para reutilizar entre exports.
  let _logoCache = null;
  async function loadLogoDataURL() {
    if (_logoCache) return _logoCache;
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          _logoCache = {
            dataUrl: c.toDataURL('image/png'),
            w: img.naturalWidth,
            h: img.naturalHeight,
          };
          resolve(_logoCache);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = 'assets/logo-ea-azul.png';
    });
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
    for (const line of lines) {
      y = ensureSpace(doc, y, 5, margin);
      doc.text(line, margin, y);
      y += 5;
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
        const text = `• ${c.tsa.name}  (${c.tsa.vertical.lowerLabel} – ${c.tsa.vertical.upperLabel})  · segmento ${c.segment.from.name || '—'} → ${c.segment.to.name || '—'}  · paso ${formatUTC(c.tStart)} – ${formatUTC(c.tEnd)}`;
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
    y = ensureSpace(doc, y, 20, margin);
    doc.autoTable({
      startY: y,
      head: [['#', 'Waypoint', 'FL', 'Aerovía', 'Latitud', 'Longitud', 'Tramo NM', 'Acum NM', 'ETA UTC']],
      body: plan.coords.map((c, i) => [
        i + 1,
        c.name,
        c.fl != null ? 'FL' + c.fl : '—',
        c.airway,
        formatLat(c.lat),
        formatLon(c.lon),
        i === 0 ? '—' : (c.legDistKm / 1.852).toFixed(1),
        c.cumDistNM.toFixed(1),
        formatUTC(c.etaUTC),
      ]),
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

  function renderFuelSection(doc, fuel, margin, pageW, y) {
    y = sectionHeader(doc, 'Log de vuelo y combustible', y, margin);
    const u = fuel.unit || '';

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);
    const lines = [
      `Inicial: ${fmtNum(fuel.initialFuel)} ${u}        Consumo base: ${fmtNum(fuel.fuelFlow)} ${u}/h        Velocidad base: ${fuel.defaultSpeedKt} kt`,
      `Total consumido: ${fmtNum(fuel.totalFuelUsed)} ${u}        Restante en destino: ${fmtNum(fuel.finalRemaining)} ${u}        Tiempo total: ${formatDuration(fuel.totalTimeMin)}`,
    ];
    if (fuel.jokerFuel != null) {
      lines.push(`JOKER: ${fmtNum(fuel.jokerFuel)} ${u}` + (fuel.firstJokerIdx != null ? `  (alcanzado en wpt #${fuel.firstJokerIdx + 1})` : '  (no alcanzado)'));
    }
    if (fuel.bingoFuel != null) {
      lines.push(`BINGO: ${fmtNum(fuel.bingoFuel)} ${u}` + (fuel.firstBingoIdx != null ? `  (alcanzado en wpt #${fuel.firstBingoIdx + 1})` : '  (no alcanzado)'));
    }
    for (const line of lines) {
      y = ensureSpace(doc, y, 5, margin);
      doc.text(line, margin, y);
      y += 5;
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

    // Tabla por tramos
    y = ensureSpace(doc, y, 20, margin);
    doc.autoTable({
      startY: y,
      head: [['#', 'Waypoint', 'Tramo NM', 'Vel kt', 'T tramo', 'T total', `Cons ${u}/h`, `Comb tramo ${u}`, `Restante ${u}`, 'Estado']],
      body: fuel.rows.map(r => [
        r.index + 1,
        r.name,
        r.index === 0 ? '—' : r.legDistNM.toFixed(1),
        r.index === 0 ? '—' : Math.round(r.legSpeedKt),
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
          if (data.column.index === 9) data.cell.styles.fontStyle = 'bold';
        } else if (r.status === 'joker') {
          data.cell.styles.fillColor = [254, 240, 138];
          if (data.column.index === 9) data.cell.styles.fontStyle = 'bold';
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
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const margin = 14;
    const pageW = doc.internal.pageSize.getWidth();
    let y = margin;

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
        y = renderFuelSection(doc, plan.fuel, margin, pageW, y);
      }
      if (plan.meteo && plan.meteo.length) {
        y = renderMeteoSection(doc, plan.meteo, margin, pageW, y);
      }
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
    doc.save(fname);
    return fname;
  }

  return { exportReport };
})();
