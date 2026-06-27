import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from "pdf-lib";
import { ReportData } from "./report";

// Builds a readable PDF of the weekly payroll report (landscape), mirroring
// the Excel grid. Paginates automatically as sections fill the page.

const PAGE_W = 792; // Letter landscape
const PAGE_H = 612;
const MARGIN = 36;

const steel = rgb(0.11, 0.13, 0.15);
const safety = rgb(1, 0.42, 0.07);
const gray = rgb(0.45, 0.48, 0.52);
const line = rgb(0.8, 0.8, 0.8);
const lightBg = rgb(0.96, 0.96, 0.94);
const flagBg = rgb(1, 0.93, 0.85);

export async function buildReportPdf(rd: ReportData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (need: number) => {
    if (y - need < MARGIN) newPage();
  };

  // Column geometry: name col + N day cols + total col
  const nDays = rd.dayLabels.length || 7;
  const nameW = 150;
  const totalW = 60;
  const gridW = PAGE_W - MARGIN * 2 - nameW - totalW;
  const dayW = gridW / nDays;
  const colX = (i: number) => MARGIN + nameW + i * dayW;
  const totalX = MARGIN + nameW + nDays * dayW;
  const rowH = 18;

  // Title
  page.drawText("AMMEX REBAR PLACERS", {
    x: MARGIN,
    y,
    size: 15,
    font: bold,
    color: steel,
  });
  y -= 18;
  page.drawText(`Weekly Payroll — ${rd.weekStartISO} to ${rd.weekEndISO}`, {
    x: MARGIN,
    y,
    size: 11,
    font,
    color: gray,
  });
  y -= 24;

  const drawHeaderRow = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH + 4,
      width: PAGE_W - MARGIN * 2,
      height: rowH,
      color: lightBg,
    });
    page.drawText("Worker", { x: MARGIN + 4, y: y - rowH + 9, size: 9, font: bold, color: steel });
    rd.dayLabels.forEach((d, i) => {
      page.drawText(d, { x: colX(i) + 4, y: y - rowH + 9, size: 8, font: bold, color: steel });
    });
    page.drawText("Total", { x: totalX + 4, y: y - rowH + 9, size: 9, font: bold, color: steel });
    y -= rowH;
  };

  const drawCellText = (
    text: string,
    x: number,
    yy: number,
    f: PDFFont,
    size: number,
    color = steel
  ) => {
    page.drawText(text, { x, y: yy, size, font: f, color });
  };

  for (const sec of rd.sections) {
    ensure(rowH * 3 + 10);

    // Section header
    const secLabel = sec.unassigned
      ? `UNASSIGNED — ${sec.title}`
      : sec.jobId
      ? `${sec.title}   (Job ID: ${sec.jobId})`
      : sec.title;
    page.drawText(secLabel, {
      x: MARGIN,
      y: y - 12,
      size: 11,
      font: bold,
      color: sec.unassigned ? safety : steel,
    });
    y -= 20;

    drawHeaderRow();

    for (const p of sec.people) {
      ensure(rowH + 4);
      if (y !== PAGE_H - MARGIN && y < MARGIN + rowH) {
        // safety
      }
      drawCellText(clip(p.name, font, 9, nameW - 8), MARGIN + 4, y - rowH + 9, font, 9);
      p.perDay.forEach((h, i) => {
        const txt = h == null ? "X" : String(h);
        const c = h == null ? gray : steel;
        drawCellText(txt, colX(i) + 4, y - rowH + 9, font, 9, c);
      });
      drawCellText(String(p.total), totalX + 4, y - rowH + 9, bold, 9);
      // row separator
      page.drawLine({
        start: { x: MARGIN, y: y - rowH + 2 },
        end: { x: PAGE_W - MARGIN, y: y - rowH + 2 },
        thickness: 0.3,
        color: line,
      });
      y -= rowH;
    }

    // Daily totals row
    ensure(rowH + 4);
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH + 4,
      width: PAGE_W - MARGIN * 2,
      height: rowH,
      color: lightBg,
    });
    drawCellText("Daily total", MARGIN + 4, y - rowH + 9, bold, 9);
    sec.dailyTotals.forEach((tt, i) => {
      drawCellText(String(tt), colX(i) + 4, y - rowH + 9, bold, 9);
    });
    drawCellText(String(sec.grandTotal), totalX + 4, y - rowH + 9, bold, 9, safety);
    y -= rowH + 14;
  }

  // No hours logged
  ensure(40);
  page.drawText("NO HOURS LOGGED THIS WEEK", { x: MARGIN, y: y - 12, size: 11, font: bold, color: steel });
  y -= 20;
  if (rd.noHours.length === 0) {
    page.drawText("Everyone on the roster logged hours.", { x: MARGIN, y: y - 10, size: 9, font, color: gray });
    y -= 18;
  } else {
    // Lay names out in columns to save space
    const perCol = Math.ceil(rd.noHours.length / 3);
    const colWidth = (PAGE_W - MARGIN * 2) / 3;
    const startY = y;
    rd.noHours.forEach((n, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const yy = startY - 10 - row * 14;
      ensure(0);
      page.drawText(`• ${n}`, { x: MARGIN + col * colWidth, y: yy, size: 9, font, color: steel });
    });
    y = startY - 10 - perCol * 14 - 6;
  }
  y -= 10;

  // Flags
  ensure(40);
  page.drawRectangle({
    x: MARGIN,
    y: y - 18,
    width: PAGE_W - MARGIN * 2,
    height: 20,
    color: flagBg,
  });
  page.drawText("FLAGS TO REVIEW", { x: MARGIN + 4, y: y - 13, size: 11, font: bold, color: steel });
  y -= 26;
  if (rd.flags.length === 0) {
    page.drawText("None.", { x: MARGIN, y: y - 10, size: 9, font, color: gray });
  } else {
    for (const f of rd.flags) {
      ensure(16);
      const kind =
        f.kind === "over_hours"
          ? `Over ${rd.overHoursThreshold} hrs/day`
          : f.kind === "double_entry"
          ? "Possible double entry"
          : f.kind === "multi_job"
          ? "On multiple jobs same day"
          : f.kind === "single_high"
          ? "Single entry too high"
          : f.kind === "off_roster"
          ? "Not on active roster"
          : "Review";
      page.drawText(`${f.worker} — ${f.dateISO} — ${kind} (${f.detail})`, {
        x: MARGIN,
        y: y - 10,
        size: 9,
        font,
        color: steel,
      });
      y -= 15;
    }
  }

  return pdf.save();
}

function clip(s: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  let t = s;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxW) {
    t = t.slice(0, -1);
  }
  return t + "…";
}
