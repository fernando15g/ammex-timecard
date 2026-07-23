import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

export interface ScheduleCrew {
  worker: string;
  isLead: boolean;
  hours?: number;       // actual payable hours logged on this job that day
  unscheduled?: boolean; // worked this job without being scheduled on it
}
export interface ScheduleJob {
  jobPageId: string;
  name: string;
  jobId: string;
  crew: ScheduleCrew[];
}
export interface ScheduleData {
  date: string; // YYYY-MM-DD
  jobs: ScheduleJob[];
}

const steel = rgb(0.11, 0.13, 0.15);
const blue = rgb(0.12, 0.45, 0.85);
const gray = rgb(0.45, 0.48, 0.52);
const line = rgb(0.78, 0.8, 0.82);
const amber = rgb(0.72, 0.5, 0.05);   // worked the job but wasn't scheduled
const green = rgb(0.20, 0.55, 0.32);  // scheduled and showed up
const faded = rgb(0.62, 0.64, 0.67);  // scheduled but no hours logged
const headBg = rgb(1, 0.93, 0.85);
const MARGIN = 36;

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

function wrap(s: string, font: PDFFont, size: number, maxW: number, maxLines = 2): string[] {
  if (font.widthOfTextAtSize(s, size) <= maxW) return [s];
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(test, size) <= maxW) cur = test;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let t = lines[maxLines - 1];
    while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxW) t = t.slice(0, -1);
    lines[maxLines - 1] = t + "…";
  }
  return lines;
}

// Portrait, up to 4 job columns per row, rows wrap below. A row that would
// bleed past the page bottom moves whole to the next page (never split a
// column). Lead foreman is listed first in blue (no separate label).
export async function buildSchedulePdf(data: ScheduleData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const PW = 612;
  const PH = 792;
  const COLS = 4;
  const gap = 12;
  const usableW = PW - MARGIN * 2;
  const colW = (usableW - gap * (COLS - 1)) / COLS;
  const headH = 40;
  const rowGap = 18;
  const lineH = 13;

  // Order each job's crew: lead first, then the rest alphabetical.
  const jobs = data.jobs.map((j) => {
    const lead = j.crew.find((c) => c.isLead);
    const others = j.crew
      .filter((c) => !c.isLead)
      .sort((a, b) => a.worker.localeCompare(b.worker, undefined, { sensitivity: "base" }));
    return { ...j, ordered: lead ? [lead, ...others] : others };
  });

  // Group into rows of up to COLS.
  const rows: typeof jobs[] = [];
  for (let i = 0; i < jobs.length; i += COLS) rows.push(jobs.slice(i, i + COLS));

  let page = pdf.addPage([PW, PH]);
  // Title block
  page.drawText("AMMEX REBAR PLACERS", { x: MARGIN, y: PH - MARGIN - 4, size: 15, font: bold, color: steel });
  page.drawText(longDate(data.date).toUpperCase(), { x: MARGIN, y: PH - MARGIN - 24, size: 12, font: bold, color: steel });
  const totalCrew = data.jobs.reduce((s, j) => s + j.crew.filter((c) => !c.unscheduled).length, 0);
  page.drawText(`${data.jobs.length} jobs · ${totalCrew} crew`, { x: MARGIN, y: PH - MARGIN - 40, size: 10, font, color: gray });

  // Key — explains what the name colours / hours mean on this sheet.
  {
    const ky = PH - MARGIN - 54;
    let kx = MARGIN;
    const chip = (label: string, color: any) => {
      page.drawText(label, { x: kx, y: ky, size: 7.5, font, color });
      kx += font.widthOfTextAtSize(label, 7.5) + 14;
    };
    chip("* 8h = scheduled & worked", steel);
    chip("NAME 8h = worked, not scheduled", amber);
    chip("NAME = scheduled, no hours", faded);
  }
  let y = PH - MARGIN - 70;

  function drawColumn(pg: PDFPage, x: number, topY: number, job: typeof jobs[number]) {
    let yy = topY;
    const nameLines = wrap(job.name, bold, 9.5, colW - 8);
    pg.drawRectangle({ x, y: yy - headH, width: colW, height: headH, color: headBg });
    let hy = yy - 12;
    for (const nl of nameLines) {
      pg.drawText(nl, { x: x + 4, y: hy, size: 9.5, font: bold, color: steel });
      hy -= 11;
    }
    if (job.jobId) pg.drawText(`#${job.jobId}`, { x: x + 4, y: yy - headH + 6, size: 8, font, color: gray });
    yy -= headH;
    pg.drawLine({ start: { x, y: yy }, end: { x: x + colW, y: yy }, thickness: 0.6, color: line });
    yy -= 14;
    for (const c of job.ordered) {
      const worked = c.hours != null;
      // Name colour reflects what actually happened against the plan.
      const nameColor = c.unscheduled
        ? amber                       // worked here, wasn't scheduled
        : c.isLead
        ? blue
        : worked
        ? steel                       // scheduled and showed up
        : faded;                      // scheduled, no hours logged
      const suffix = worked ? `  ${c.unscheduled ? "" : "* "}${c.hours}h` : "";
      const nm = c.worker.toUpperCase() + suffix;
      const lines = wrap(nm, c.isLead ? bold : font, 8.5, colW - 8);
      for (let li = 0; li < lines.length; li++) {
        pg.drawText(lines[li], {
          x: x + (li === 0 ? 4 : 10),
          y: yy,
          size: 8.5,
          font: c.isLead ? bold : font,
          color: nameColor,
        });
        yy -= lineH;
      }
    }
  }

  for (const row of rows) {
    // Row height = header + tallest column's crew lines.
    let maxLines = 0;
    for (const job of row) {
      let lines = 0;
      for (const c of job.ordered) {
        lines += wrap(c.worker.toUpperCase(), c.isLead ? bold : font, 8.5, colW - 8).length;
      }
      maxLines = Math.max(maxLines, lines);
    }
    const rowH = headH + 14 + maxLines * lineH + rowGap;

    // If the row won't fit, move the whole row to a new page.
    if (y - rowH < MARGIN && y < PH - MARGIN - 60) {
      page = pdf.addPage([PW, PH]);
      page.drawText(`${longDate(data.date).toUpperCase()} (cont.)`, {
        x: MARGIN, y: PH - MARGIN - 4, size: 11, font: bold, color: steel,
      });
      y = PH - MARGIN - 24;
    }

    row.forEach((job, ci) => {
      const x = MARGIN + ci * (colW + gap);
      drawColumn(page, x, y, job);
    });
    y -= rowH;
  }

  return pdf.save();
}
