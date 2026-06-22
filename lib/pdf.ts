import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface TimecardData {
  foreman: string;
  date: string; // YYYY-MM-DD
  job: string;
  workDone: string;
  notes: string;
  workers: { name: string; hours: number }[];
}

// Format a YYYY-MM-DD string as a readable date without timezone drift.
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

export async function buildTimecardPdf(data: TimecardData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const steel = rgb(0.11, 0.13, 0.15);
  const safety = rgb(1, 0.42, 0.07);
  const gray = rgb(0.45, 0.48, 0.52);
  const lineColor = rgb(0.82, 0.82, 0.82);

  const margin = 50;
  const width = 612 - margin * 2;
  let y = 792 - margin;

  // Header band
  page.drawRectangle({
    x: 0,
    y: 792 - 8,
    width: 612,
    height: 8,
    color: safety,
  });

  page.drawText("AMMEX REBAR PLACERS", {
    x: margin,
    y,
    size: 18,
    font: bold,
    color: steel,
  });
  y -= 22;
  page.drawText("Daily Timecard", {
    x: margin,
    y,
    size: 12,
    font,
    color: gray,
  });
  y -= 30;

  // Meta block: Job, Date, Foreman
  const meta = [
    ["Job", data.job || "—"],
    ["Date", prettyDate(data.date)],
    ["Foreman", data.foreman || "—"],
  ];
  for (const [label, value] of meta) {
    page.drawText(label.toUpperCase(), {
      x: margin,
      y,
      size: 8,
      font: bold,
      color: gray,
    });
    page.drawText(value, {
      x: margin + 70,
      y,
      size: 12,
      font: bold,
      color: steel,
    });
    y -= 20;
  }

  y -= 8;
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + width, y },
    thickness: 1,
    color: lineColor,
  });
  y -= 24;

  // Worker table header
  page.drawText("WORKER", {
    x: margin,
    y,
    size: 9,
    font: bold,
    color: gray,
  });
  page.drawText("HOURS", {
    x: margin + width - 60,
    y,
    size: 9,
    font: bold,
    color: gray,
  });
  y -= 6;
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + width, y },
    thickness: 0.5,
    color: lineColor,
  });
  y -= 20;

  // Worker rows
  let total = 0;
  for (const w of data.workers) {
    total += w.hours;
    page.drawText(w.name, {
      x: margin,
      y,
      size: 12,
      font,
      color: steel,
    });
    const hrsText = String(w.hours);
    const hrsWidth = font.widthOfTextAtSize(hrsText, 12);
    page.drawText(hrsText, {
      x: margin + width - 30 - hrsWidth,
      y,
      size: 12,
      font,
      color: steel,
    });
    y -= 20;

    // Simple page-break guard for very large crews
    if (y < 140) {
      y = 792 - margin;
      pdf.addPage([612, 792]);
    }
  }

  y -= 4;
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + width, y },
    thickness: 1,
    color: lineColor,
  });
  y -= 26;

  // Total
  page.drawText("TOTAL HOURS", {
    x: margin,
    y,
    size: 12,
    font: bold,
    color: steel,
  });
  const totalText = String(Math.round(total * 100) / 100);
  const totalWidth = bold.widthOfTextAtSize(totalText, 16);
  page.drawText(totalText, {
    x: margin + width - 30 - totalWidth,
    y: y - 2,
    size: 16,
    font: bold,
    color: safety,
  });
  y -= 40;

  // Work done
  if (data.workDone?.trim()) {
    page.drawText("WORK DONE", {
      x: margin,
      y,
      size: 8,
      font: bold,
      color: gray,
    });
    y -= 16;
    y = drawWrapped(page, data.workDone, margin, y, width, 11, font, steel);
    y -= 16;
  }

  // Notes
  if (data.notes?.trim()) {
    page.drawText("NOTES", {
      x: margin,
      y,
      size: 8,
      font: bold,
      color: gray,
    });
    y -= 16;
    y = drawWrapped(page, data.notes, margin, y, width, 11, font, steel);
  }

  return pdf.save();
}

// Word-wrap helper for free-text fields.
function drawWrapped(
  page: any,
  text: string,
  x: number,
  startY: number,
  maxWidth: number,
  size: number,
  font: any,
  color: any
): number {
  const words = text.split(/\s+/);
  let line = "";
  let y = startY;
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth) {
      page.drawText(line, { x, y, size, font, color });
      y -= size + 4;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font, color });
    y -= size + 4;
  }
  return y;
}
