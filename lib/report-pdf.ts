import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from "pdf-lib";
import { ReportData, groupFlags, fmtNumericDate } from "./report";
import { RT } from "./report-i18n";
import { DailyReport } from "./report-daily";
import { PayrollGrid } from "./report-payrollgrid";

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
const flagRowBg = rgb(1, 0.95, 0.88);
const zebraBg = rgb(0.965, 0.965, 0.955);
const faintDot = rgb(0.72, 0.72, 0.72);

export async function buildReportPdf(rd: ReportData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Mark rows by (worker + specific job) so a flag only appears on the job(s)
  // it actually involves — not on every job the worker was on that week.
  // Name-only flags (e.g. off-roster) mark all of that worker's rows.
  const flaggedJobKeys = new Set<string>();
  const flaggedNameOnly = new Set<string>();
  for (const f of rd.flags) {
    const w = f.worker.trim().toLowerCase();
    if (f.jobs && f.jobs.length) {
      for (const j of f.jobs) flaggedJobKeys.add(`${w}|${j.trim().toLowerCase()}`);
    } else {
      flaggedNameOnly.add(w);
    }
  }
  const tr = RT[rd.lang];

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
  page.drawText(`${tr.payrollTitle} — ${fmtNumericDate(rd.weekStartISO)} ${tr.rangeJoin} ${fmtNumericDate(rd.weekEndISO)}`, {
    x: MARGIN,
    y,
    size: 11,
    font,
    color: gray,
  });
  y -= 18;
  if (rd.foremanReport && rd.foremanName) {
    page.drawText(`${tr.foremanLabel}: ${rd.foremanName.toUpperCase()}`, {
      x: MARGIN,
      y,
      size: 12,
      font: bold,
      color: safety,
    });
    y -= 18;
    // Days this foreman worked as crew under another lead — points to where
    // the rest of that day's crew hours live.
    for (const note of rd.crewNotes || []) {
      page.drawText(`• ${note}`, {
        x: MARGIN,
        y,
        size: 8.5,
        font,
        color: gray,
      });
      y -= 12;
    }
  }
  y -= 6;

  const drawHeaderRow = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH + 4,
      width: PAGE_W - MARGIN * 2,
      height: rowH,
      color: lightBg,
    });
    page.drawText(tr.worker, { x: MARGIN + 4, y: y - rowH + 9, size: 9, font: bold, color: steel });
    rd.dayLabels.forEach((d, i) => {
      page.drawText(d, { x: colX(i) + 4, y: y - rowH + 9, size: 8, font: bold, color: steel });
    });
    page.drawText(tr.total, { x: totalX + 4, y: y - rowH + 9, size: 9, font: bold, color: steel });
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
      ? `${tr.unassigned} — ${sec.title}`
      : sec.jobId
      ? `${sec.title}   (${tr.jobId}: ${sec.jobId})`
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

    sec.people.forEach((p, ri) => {
      ensure(rowH + 4);
      const wkey = p.name.trim().toLowerCase();
      const flagged =
        flaggedNameOnly.has(wkey) ||
        flaggedJobKeys.has(`${wkey}|${sec.title.trim().toLowerCase()}`);
      if (flagged) {
        // Shade the flagged person's row (takes priority over zebra).
        page.drawRectangle({
          x: MARGIN,
          y: y - rowH + 3,
          width: PAGE_W - MARGIN * 2,
          height: rowH,
          color: flagRowBg,
        });
        // Small flag icon at the left of the row.
        const fx = MARGIN + 4;
        const fy = y - rowH + 6; // baseline-ish
        try {
          page.drawRectangle({ x: fx, y: fy, width: 1.1, height: 9, color: safety });
          page.drawSvgPath("M0,0 L6,2 L0,4 Z", {
            x: fx + 1,
            y: y - rowH + 17,
            color: safety,
            scale: 1,
          });
        } catch {
          /* icon is decorative; ignore if it can't draw */
        }
      } else if (ri % 2 === 1) {
        // Zebra striping on alternating non-flagged rows.
        page.drawRectangle({
          x: MARGIN,
          y: y - rowH + 3,
          width: PAGE_W - MARGIN * 2,
          height: rowH,
          color: zebraBg,
        });
      }
      const nameX = flagged ? MARGIN + 14 : MARGIN + 4;
      drawCellText(clip(p.name.toUpperCase(), font, 9, nameW - (flagged ? 18 : 8)), nameX, y - rowH + 9, font, 9);
      p.perDay.forEach((h, i) => {
        if (h == null) {
          // Faint dot marks a non-worked day (quiet, keeps a column anchor).
          drawCellText("·", colX(i) + 6, y - rowH + 10, font, 12, faintDot);
        } else {
          drawCellText(String(h), colX(i) + 4, y - rowH + 9, bold, 10, steel);
        }
      });
      drawCellText(String(p.total), totalX + 4, y - rowH + 9, bold, 10);
      y -= rowH;
    });

    // Daily totals row
    ensure(rowH + 4);
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH + 4,
      width: PAGE_W - MARGIN * 2,
      height: rowH,
      color: lightBg,
    });
    drawCellText(tr.dailyTotal, MARGIN + 4, y - rowH + 9, bold, 9);
    sec.dailyTotals.forEach((tt, i) => {
      drawCellText(String(tt), colX(i) + 4, y - rowH + 9, bold, 10);
    });
    drawCellText(String(sec.grandTotal), totalX + 4, y - rowH + 9, bold, 10, safety);
    y -= rowH + 14;
  }

  // Week grand total (reconciliation line) — full report only.
  if (!rd.foremanReport) {
    ensure(28);
    page.drawText(`${tr.weekTotal}: ${rd.grandTotal} ${tr.hrs}`, {
      x: MARGIN,
      y: y - 12,
      size: 12,
      font: bold,
      color: safety,
    });
    y -= 30;
  }

  // No hours logged (only meaningful for the full roster report)
  if (!rd.foremanReport) {
    ensure(40);
    page.drawText(tr.noHoursHeader, { x: MARGIN, y: y - 12, size: 11, font: bold, color: steel });
  y -= 20;
  if (rd.noHours.length === 0) {
    page.drawText(tr.everyoneLogged, { x: MARGIN, y: y - 10, size: 9, font, color: gray });
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
      page.drawText(`• ${n.toUpperCase()}`, { x: MARGIN + col * colWidth, y: yy, size: 9, font, color: steel });
    });
    y = startY - 10 - perCol * 14 - 6;
  }
  y -= 10;
  }

  // Flags
  ensure(40);
  page.drawRectangle({
    x: MARGIN,
    y: y - 18,
    width: PAGE_W - MARGIN * 2,
    height: 20,
    color: flagBg,
  });
  page.drawText(tr.flagsHeader, { x: MARGIN + 4, y: y - 13, size: 11, font: bold, color: steel });
  y -= 26;
  if (rd.flags.length === 0) {
    page.drawText(tr.none, { x: MARGIN, y: y - 10, size: 9, font, color: gray });
  } else {
    const groups = groupFlags(rd.flags, rd.overHoursThreshold);
    for (const g of groups) {
      ensure(16 + g.lines.length * 14 + 6);
      page.drawText(`${g.worker} — ${g.dateISO}`, {
        x: MARGIN,
        y: y - 10,
        size: 9.5,
        font: bold,
        color: steel,
      });
      y -= 15;
      for (const line of g.lines) {
        ensure(14);
        const maxW = PAGE_W - MARGIN * 2 - 16;
        page.drawText(`•  ${clip(line, font, 9, maxW)}`, {
          x: MARGIN + 12,
          y: y - 10,
          size: 9,
          font,
          color: steel,
        });
        y -= 13;
      }
      y -= 4;
    }
  }

  // On hold — held-for-review hours, EXCLUDED from the totals above. Down-the-
  // middle prominence: a labeled amber block so a forgotten hold is noticed.
  if (rd.onHold && rd.onHold.length > 0) {
    y -= 14;
    const held = rd.onHold;
    const totalHeld = held.reduce((s, h) => s + (h.hours || 0), 0);
    ensure(30 + held.length * 13 + 10);
    page.drawRectangle({
      x: MARGIN,
      y: y - 18,
      width: PAGE_W - MARGIN * 2,
      height: 20,
      color: rgb(0.98, 0.85, 0.6),
    });
    page.drawText(
      `ON HOLD — NOT INCLUDED ABOVE  (${held.length} ${held.length === 1 ? "entry" : "entries"} · ${totalHeld} hrs)`,
      { x: MARGIN + 4, y: y - 13, size: 10, font: bold, color: steel }
    );
    y -= 28;
    page.drawText("These hours are held for review and are excluded from the totals above.", {
      x: MARGIN,
      y: y - 8,
      size: 8.5,
      font,
      color: gray,
    });
    y -= 18;
    for (const h of held) {
      ensure(14);
      const maxW = PAGE_W - MARGIN * 2 - 16;
      const jobPart = h.job ? ` · ${h.job}` : "";
      page.drawText(
        `•  ${clip(`${h.worker} — ${h.dateISO} — ${h.hours} hrs${jobPart}`, font, 9, maxW)}`,
        { x: MARGIN + 12, y: y - 10, size: 9, font, color: steel }
      );
      y -= 13;
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

// Worker-grouped view: each worker, the jobs they worked (ordered by earliest
// day) with hours, and a weekly total. Portrait, paginates automatically.
export async function buildWorkerPdf(rd: ReportData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const tr = RT[rd.lang];

  const PW = 612; // portrait Letter
  const PH = 792;
  let page = pdf.addPage([PW, PH]);
  let y = PH - MARGIN;

  function ensure(h: number) {
    if (y - h < MARGIN) {
      page = pdf.addPage([PW, PH]);
      y = PH - MARGIN;
    }
  }

  page.drawText("AMMEX REBAR PLACERS", {
    x: MARGIN, y, size: 15, font: bold, color: steel,
  });
  y -= 18;
  page.drawText(`${tr.workerReportTitle} — ${fmtNumericDate(rd.weekStartISO)} ${tr.rangeJoin} ${fmtNumericDate(rd.weekEndISO)}`, {
    x: MARGIN, y, size: 11, font, color: gray,
  });
  y -= 18;
  if (rd.foremanReport && rd.foremanName) {
    page.drawText(`${tr.foremanLabel}: ${rd.foremanName.toUpperCase()}`, {
      x: MARGIN, y, size: 12, font: bold, color: safety,
    });
    y -= 18;
  }
  y -= 10;

  const rightX = PW - MARGIN;
  for (const w of rd.workerSummaries) {
    ensure(20 + w.jobs.length * 15 + 10);
    // Worker name (uppercase) + total on one line
    page.drawText(w.name.toUpperCase(), { x: MARGIN, y, size: 12, font: bold, color: steel });
    const totalStr = `${w.total} ${tr.hrs}`;
    page.drawText(totalStr, {
      x: rightX - bold.widthOfTextAtSize(totalStr, 12),
      y, size: 12, font: bold, color: safety,
    });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y: y },
      end: { x: rightX, y: y },
      thickness: 0.5,
      color: line,
    });
    y -= 13;
    // Job lines — hours on the right with a clear dotted leader to guide the eye.
    for (const j of w.jobs) {
      const left = j.jobId
        ? `${j.firstDayLabel}  ·  ${j.title} (${j.jobId})`
        : `${j.firstDayLabel}  ·  ${j.title}`;
      const leftClipped = clip(left, font, 10, PW - MARGIN * 2 - 90);
      page.drawText(leftClipped, { x: MARGIN + 6, y, size: 10, font, color: steel });
      const hrs = `${j.hours}`;
      const hrsW = bold.widthOfTextAtSize(hrs, 11);
      const hrsX = rightX - hrsW;
      page.drawText(hrs, { x: hrsX, y, size: 11, font: bold, color: steel });
      const leftEnd = MARGIN + 6 + font.widthOfTextAtSize(leftClipped, 10) + 6;
      if (hrsX - 6 > leftEnd) {
        page.drawLine({
          start: { x: leftEnd, y: y + 3 },
          end: { x: hrsX - 6, y: y + 3 },
          thickness: 0.7,
          color: rgb(0.55, 0.57, 0.6),
          dashArray: [1.5, 2.5],
        });
      }
      y -= 15;
    }
    y -= 8;
  }

  // Week grand total
  if (!rd.foremanReport) {
    ensure(24);
    page.drawText(`${tr.weekTotal}: ${rd.grandTotal} ${tr.hrs}`, {
      x: MARGIN, y: y - 4, size: 12, font: bold, color: safety,
    });
  }

  return pdf.save();
}

// Owner Review — Daily PDF: a readable daily log (day → job → foreman → crew).
// Portrait, generous-but-not-airy spacing, paginates automatically.
export async function buildDailyPdf(rd: DailyReport): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const tr = RT[rd.lang];

  const PW = 612;
  const PH = 792;
  let page = pdf.addPage([PW, PH]);
  let y = PH - MARGIN;
  const rightX = PW - MARGIN;

  function ensure(h: number) {
    if (y - h < MARGIN) {
      page = pdf.addPage([PW, PH]);
      y = PH - MARGIN;
    }
  }

  page.drawText("AMMEX REBAR PLACERS", { x: MARGIN, y, size: 15, font: bold, color: steel });
  y -= 18;
  page.drawText(`${tr.dailyReportTitle} — ${fmtNumericDate(rd.weekStartISO)} ${tr.rangeJoin} ${fmtNumericDate(rd.weekEndISO)}`, {
    x: MARGIN, y, size: 11, font, color: gray,
  });
  y -= 18;
  if (rd.foremanReport && rd.foremanName) {
    page.drawText(`${tr.foremanLabel}: ${rd.foremanName.toUpperCase()}`, {
      x: MARGIN, y, size: 12, font: bold, color: safety,
    });
    y -= 18;
  }
  y -= 8;

  rd.days.forEach((day, di) => {
    // Each day starts on its own page; the first day stays under the header.
    if (di > 0) {
      page = pdf.addPage([PW, PH]);
      y = PH - MARGIN;
    }
    ensure(40);
    // Day header band — date centered + uppercased; day total on the right.
    page.drawRectangle({
      x: MARGIN - 4, y: y - 16, width: PW - MARGIN * 2 + 8, height: 22, color: flagBg,
    });
    const dLabel = day.dateLabel.toUpperCase();
    const dLabelW = bold.widthOfTextAtSize(dLabel, 13);
    page.drawText(dLabel, { x: (PW - dLabelW) / 2, y: y - 11, size: 13, font: bold, color: steel });
    const dtot = `${day.total} ${tr.hrs}`;
    page.drawText(dtot, {
      x: rightX - bold.widthOfTextAtSize(dtot, 12), y: y - 11, size: 12, font: bold, color: steel,
    });
    y -= 30;

    for (const job of day.jobs) {
      ensure(34);
      // Job title once, then each foreman's crew grouped underneath it.
      const jobLine = job.jobId ? `${job.title} (${job.jobId})` : job.title;
      page.drawText(jobLine, { x: MARGIN + 6, y, size: 11, font: bold, color: steel });
      y -= 15;
      for (const fg of job.foremen) {
        ensure(16 + fg.crew.length * 13 + 4);
        if (fg.foreman) {
          page.drawText(`${tr.foremanLabel}: ${fg.foreman.toUpperCase()}`, {
            x: MARGIN + 6, y, size: 9.5, font, color: safety,
          });
          y -= 13;
        }
        // Crew lines — hours on the right with a clear dotted leader.
        for (const c of fg.crew) {
          const nameTxt = clip(c.name.toUpperCase(), font, 10, PW - MARGIN * 2 - 90);
          page.drawText(nameTxt, { x: MARGIN + 18, y, size: 10, font, color: steel });
          const h = `${c.hours}`;
          const hW = bold.widthOfTextAtSize(h, 11);
          const hX = rightX - hW;
          page.drawText(h, { x: hX, y, size: 11, font: bold, color: steel });
          const nameEnd = MARGIN + 18 + font.widthOfTextAtSize(nameTxt, 10) + 6;
          if (hX - 6 > nameEnd) {
            page.drawLine({
              start: { x: nameEnd, y: y + 3 },
              end: { x: hX - 6, y: y + 3 },
              thickness: 0.7,
              color: rgb(0.55, 0.57, 0.6),
              dashArray: [1.5, 2.5],
            });
          }
          y -= 13;
        }
      }
      // One job total across all foremen on this job.
      const jt = `${tr.jobTotal}: ${job.total} ${tr.hrs}`;
      page.drawText(jt, { x: MARGIN + 12, y, size: 9, font: bold, color: gray });
      y -= 18;
    }
    y -= 6;
  });

  if (!rd.foremanReport) {
    ensure(24);
    page.drawText(`${tr.weekTotal}: ${rd.grandTotal} ${tr.hrs}`, {
      x: MARGIN, y: y - 4, size: 12, font: bold, color: safety,
    });
  }

  return pdf.save();
}

// Payroll Grid PDF: every worker (with hours) × day, daily totals (or splits
// like "5 | 3"), alphabetical; no-hours roster listed below. Landscape grid.
export async function buildPayrollGridPdf(pg: PayrollGrid): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const tr = RT[pg.lang];

  // Portrait Letter.
  const PWP = 612;
  const PHP = 792;
  let page = pdf.addPage([PWP, PHP]);
  let y = PHP - MARGIN;

  const gridColor = rgb(0.62, 0.65, 0.68);
  const nCols = pg.dayLabels.length;
  const nameW = 132;
  const totalW = 44;
  const usable = PWP - MARGIN * 2 - nameW - totalW;
  const colW = usable / nCols; // thin, even day columns (gridlines separate them)
  const rowH = 19;

  const xName = MARGIN;
  const xDays = MARGIN + nameW;
  const colX = (i: number) => xDays + i * colW;
  const totalX = xDays + nCols * colW;
  const xRight = totalX + totalW;

  // Column boundary x positions for vertical rules.
  const xBounds: number[] = [xName, xDays];
  for (let i = 1; i <= nCols; i++) xBounds.push(xDays + i * colW);
  xBounds.push(xRight);

  // Draw the gridlines (4 borders + internal rules) for a row of height rowH
  // whose top edge is at yTop.
  function rowGrid(yTop: number) {
    const yBot = yTop - rowH;
    // horizontal top & bottom
    page.drawLine({ start: { x: xName, y: yTop }, end: { x: xRight, y: yTop }, thickness: 0.5, color: gridColor });
    page.drawLine({ start: { x: xName, y: yBot }, end: { x: xRight, y: yBot }, thickness: 0.5, color: gridColor });
    // verticals
    for (const bx of xBounds) {
      page.drawLine({ start: { x: bx, y: yTop }, end: { x: bx, y: yBot }, thickness: 0.5, color: gridColor });
    }
  }

  function header() {
    page.drawText("AMMEX REBAR PLACERS", { x: MARGIN, y, size: 14, font: bold, color: steel });
    y -= 16;
    page.drawText(`${tr.payrollGridTitle} — ${fmtNumericDate(pg.weekStartISO)} ${tr.rangeJoin} ${fmtNumericDate(pg.weekEndISO)}`, {
      x: MARGIN, y, size: 10.5, font, color: gray,
    });
    y -= 22;
  }
  function colHeaders() {
    const yTop = y;
    page.drawRectangle({ x: xName, y: yTop - rowH, width: xRight - xName, height: rowH, color: lightBg });
    page.drawText(tr.worker, { x: xName + 4, y: yTop - rowH + 6, size: 8.5, font: bold, color: steel });
    pg.dayLabels.forEach((d, i) =>
      page.drawText(clip(d, bold, 7.5, colW - 4), { x: colX(i) + 2, y: yTop - rowH + 6, size: 7.5, font: bold, color: steel })
    );
    page.drawText(tr.total, { x: totalX + 3, y: yTop - rowH + 6, size: 8, font: bold, color: steel });
    rowGrid(yTop);
    y -= rowH;
  }
  function ensure(h: number, repeatHead = true) {
    if (y - h < MARGIN) {
      page = pdf.addPage([PWP, PHP]);
      y = PHP - MARGIN;
      if (repeatHead) colHeaders();
    }
  }

  header();
  colHeaders();

  pg.rows.forEach((r, ri) => {
    ensure(rowH);
    const yTop = y;
    if (ri % 2 === 1) {
      page.drawRectangle({ x: xName, y: yTop - rowH, width: xRight - xName, height: rowH, color: zebraBg });
    }
    page.drawText(clip(r.name.toUpperCase(), font, 8.5, nameW - 8), { x: xName + 4, y: yTop - rowH + 6, size: 8.5, font, color: steel });
    r.cells.forEach((c, i) => {
      if (c.text) {
        const t = clip(c.text, bold, 9.5, colW - 4);
        page.drawText(t, { x: colX(i) + 3, y: yTop - rowH + 6, size: 9.5, font: bold, color: steel });
      }
    });
    page.drawText(String(r.total), { x: totalX + 3, y: yTop - rowH + 6, size: 9.5, font: bold, color: steel });
    rowGrid(yTop);
    y -= rowH;
  });

  // Grand total
  y -= 6;
  ensure(20, false);
  page.drawText(`${tr.weekTotal}: ${pg.grandTotal} ${tr.hrs}`, {
    x: MARGIN, y: y - 8, size: 11, font: bold, color: safety,
  });
  y -= 26;

  // No-hours roster, grouped below
  if (pg.noHours.length > 0) {
    ensure(24, false);
    page.drawText(tr.noHoursShort, { x: MARGIN, y: y - 8, size: 10.5, font: bold, color: steel });
    y -= 18;
    const perRow = 3;
    const colWidth = (PWP - MARGIN * 2) / perRow;
    for (let i = 0; i < pg.noHours.length; i += perRow) {
      ensure(14, false);
      for (let k = 0; k < perRow && i + k < pg.noHours.length; k++) {
        page.drawText(`•  ${pg.noHours[i + k].toUpperCase()}`, {
          x: MARGIN + k * colWidth, y: y - 8, size: 9, font, color: gray,
        });
      }
      y -= 13;
    }
  }

  return pdf.save();
}
