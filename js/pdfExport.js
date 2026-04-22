// Generates a PDF report using jsPDF + html2canvas.

function formatFilter({ date, startTime, endTime }) {
  const parts = [];
  if (date)      parts.push(`Fecha: ${date}`);
  if (startTime) parts.push(`Desde: ${startTime}`);
  if (endTime)   parts.push(`Hasta: ${endTime}`);
  return parts.length ? parts.join('   ') : 'Sin filtro (todas las TSAs)';
}

function schedText(tsa) {
  return tsa.schedules.map(s => `${s.date} ${s.start}-${s.end}`).join(' | ');
}

export async function exportPDF(tsas, filter) {
  const { jsPDF } = window.jspdf;
  const doc   = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W     = doc.internal.pageSize.getWidth();
  const H     = doc.internal.pageSize.getHeight();
  const mL    = 14;
  const mR    = W - mL;
  const usableW = W - 2 * mL;
  let y = 0;

  // ── Header band ──────────────────────────────────────────────────────────
  doc.setFillColor(22, 27, 34);
  doc.rect(0, 0, W, 28, 'F');

  doc.setTextColor(88, 166, 255);
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('TSAgestor', mL, 14);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(139, 148, 158);
  doc.text('Informe de Espacios Aéreos Segregados Temporales', mL, 22);

  const ts = new Date().toLocaleString('es-ES', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit',
  });
  doc.text(`Generado: ${ts}`, mR, 22, { align: 'right' });

  y = 34;

  // ── Filter summary ────────────────────────────────────────────────────────
  doc.setFillColor(28, 33, 40);
  doc.roundedRect(mL, y, usableW, 10, 2, 2, 'F');
  doc.setFontSize(8.5);
  doc.setTextColor(201, 209, 217);
  doc.setFont('helvetica', 'bold');
  doc.text('Filtro aplicado:', mL + 3, y + 6.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(88, 166, 255);
  doc.text(formatFilter(filter), mL + 34, y + 6.5);
  doc.setTextColor(139, 148, 158);
  doc.text(`${tsas.length} TSA${tsas.length !== 1 ? 's' : ''}`, mR, y + 6.5, { align: 'right' });

  y += 15;

  // ── TSA Table ─────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(88, 166, 255);
  doc.text('Tabla de TSAs Activas', mL, y);
  y += 4;

  // Column config: [label, width, align]
  const cols = [
    { label: 'Nombre',           w: 62, align: 'left'  },
    { label: 'Lím. Inf.',        w: 20, align: 'center' },
    { label: 'Lím. Sup.',        w: 20, align: 'center' },
    { label: 'Fechas / Horarios', w: usableW - 102, align: 'left' },
  ];

  // Header row
  const rowH = 6.5;
  doc.setFillColor(28, 33, 40);
  doc.rect(mL, y, usableW, rowH, 'F');
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(139, 148, 158);
  let cx = mL + 2;
  for (const c of cols) {
    doc.text(c.label, c.align === 'center' ? cx + c.w / 2 : cx, y + 4.5, { align: c.align === 'center' ? 'center' : 'left' });
    cx += c.w;
  }
  y += rowH;

  // Data rows
  doc.setFont('helvetica', 'normal');
  for (let i = 0; i < tsas.length; i++) {
    if (y + rowH > H - 18) {
      addFooter(doc, W, H, mL);
      doc.addPage();
      y = 18;
    }

    const tsa = tsas[i];
    if (i % 2 === 0) {
      doc.setFillColor(22, 27, 34);
      doc.rect(mL, y, usableW, rowH, 'F');
    }

    doc.setFontSize(7.2);
    cx = mL + 2;

    // Name
    doc.setTextColor(201, 209, 217);
    const name = tsa.name.length > 36 ? tsa.name.slice(0, 34) + '…' : tsa.name;
    doc.text(name, cx, y + 4.5); cx += cols[0].w;

    // Lower
    doc.setTextColor(255, 153, 0);
    doc.text(tsa.verticalLimits.lower, cx + cols[1].w / 2, y + 4.5, { align: 'center' }); cx += cols[1].w;

    // Upper
    doc.setTextColor(248, 81, 73);
    doc.text(tsa.verticalLimits.upper, cx + cols[2].w / 2, y + 4.5, { align: 'center' }); cx += cols[2].w;

    // Schedules
    doc.setTextColor(201, 209, 217);
    const sched = schedText(tsa);
    const schedTr = sched.length > 50 ? sched.slice(0, 48) + '…' : sched;
    doc.text(schedTr, cx, y + 4.5);

    // Row border bottom
    doc.setDrawColor(48, 54, 61);
    doc.line(mL, y + rowH, mL + usableW, y + rowH);

    y += rowH;
  }

  y += 10;

  // ── Cross-section capture ─────────────────────────────────────────────────
  if (y > H - 60) {
    addFooter(doc, W, H, mL);
    doc.addPage();
    y = 18;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(88, 166, 255);
  doc.text('Corte Transversal del Espacio Aéreo', mL, y);
  y += 5;

  const svgEl = document.getElementById('cross-section-svg');
  if (svgEl && svgEl.childElementCount > 1) {
    try {
      const canvas = await html2canvas(svgEl, {
        backgroundColor: '#161b22',
        scale: 1.5,
        logging: false,
      });
      const imgData = canvas.toDataURL('image/png');
      const aspect  = canvas.height / canvas.width;
      const imgW    = Math.min(usableW, 180);
      const imgH    = imgW * aspect;

      if (y + imgH > H - 18) {
        addFooter(doc, W, H, mL);
        doc.addPage();
        y = 18;
      }

      doc.addImage(imgData, 'PNG', mL, y, imgW, imgH);
      y += imgH + 4;
    } catch {
      doc.setFontSize(8);
      doc.setTextColor(248, 81, 73);
      doc.text('(No se pudo capturar el corte transversal — navega a esa pestaña primero)', mL, y);
      y += 8;
    }
  } else {
    doc.setFontSize(8);
    doc.setTextColor(139, 148, 158);
    doc.text('(Navega a la pestaña Corte Transversal antes de exportar para incluir el gráfico)', mL, y);
  }

  addFooter(doc, W, H, mL);
  doc.save('TSAgestor_Informe.pdf');
}

function addFooter(doc, W, H, mL) {
  doc.setFontSize(7.5);
  doc.setTextColor(139, 148, 158);
  doc.setDrawColor(48, 54, 61);
  doc.line(mL, H - 10, W - mL, H - 10);
  doc.text('TSAgestor — Informe automático de espacios aéreos TSA', mL, H - 6);
  doc.text(`Pág. ${doc.internal.getCurrentPageInfo().pageNumber}`, W - mL, H - 6, { align: 'right' });
}
