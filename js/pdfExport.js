// Exportador de informe PDF con jsPDF + autoTable + captura del corte.

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

  function buildRows(tsas) {
    const rows = [];
    for (const tsa of tsas) {
      if (!tsa.schedules.length) {
        rows.push([tsa.name, tsa.vertical.lowerLabel, tsa.vertical.upperLabel, '—', '—', '—']);
        continue;
      }
      for (const s of tsa.schedules) {
        rows.push([
          tsa.name,
          tsa.vertical.lowerLabel,
          tsa.vertical.upperLabel,
          s.startUTC.toISOString().slice(0, 10),
          s.startUTC.toISOString().slice(11, 16) + 'Z',
          s.endUTC.toISOString().slice(11, 16) + 'Z',
        ]);
      }
    }
    return rows;
  }

  async function exportReport(tsas, filterState, svgEl) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('jsPDF no disponible');
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    const margin = 14;
    const pageW = doc.internal.pageSize.getWidth();
    let y = margin;

    // Cabecera
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('TSAgestor — Informe de TSAs', margin, y);
    y += 7;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text(`Generado: ${iso(new Date())}`, margin, y);
    y += 4;
    doc.text(`Filtro: ${filters.summaryText(filterState)}`, margin, y);
    y += 4;
    doc.text(`TSAs incluidas: ${tsas.length}`, margin, y);
    y += 6;
    doc.setTextColor(0);

    // Tabla
    doc.autoTable({
      startY: y,
      head: [['Nombre', 'Lím. inferior', 'Lím. superior', 'Fecha (UTC)', 'Apertura', 'Cierre']],
      body: buildRows(tsas),
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255 },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      margin: { left: margin, right: margin },
    });
    y = doc.lastAutoTable.finalY + 8;

    // Corte transversal
    if (svgEl && tsas.length >= 2) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      if (y > 240) { doc.addPage(); y = margin; }
      doc.text('Corte transversal', margin, y);
      y += 4;

      try {
        const png = await crossSection.toPNGDataURL(svgEl, 2);
        const imgW = pageW - margin * 2;
        // estimamos la altura con aspect ratio del viewBox
        const vb = svgEl.viewBox.baseVal;
        const aspect = (vb && vb.height && vb.width) ? (vb.height / vb.width) : 0.62;
        const imgH = imgW * aspect;
        if (y + imgH > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage();
          y = margin;
        }
        doc.addImage(png, 'PNG', margin, y, imgW, imgH);
        y += imgH + 4;
      } catch (err) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(200, 50, 50);
        doc.text('No se pudo insertar el corte transversal: ' + err.message, margin, y);
        doc.setTextColor(0);
      }
    }

    const fname = `tsagestor-${ymdhm(new Date())}.pdf`;
    doc.save(fname);
    return fname;
  }

  return { exportReport };
})();
