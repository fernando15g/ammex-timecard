import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

export interface ScheduleCrew {
  worker: string;
  isLead: boolean;
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
const safety = rgb(1, 0.42, 0.07);
const blue = rgb(0.12, 0.45, 0.85);
const gray = rgb(0.45, 0.48, 0.52);
const line = rgb(0.78, 0.8, 0.82);
const headBg = rgb(1, 0.93, 0.85);
const MARGIN = 36;

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

function clip(s: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  let t = s;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxW) t = t.slice(0, -1);
  return t + "…";
}

// Wrap a long name onto up to 2 lines within a column width.
function wrap(s: string, font: PDFFont, size: number, maxW: number): string[] {
  if (font.widthOfTextAtSize(s, size) <= maxW) return [s];
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(test, size) <= maxW) cur = test;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  // cap at 2 lines, clip the second
  if (lines.length > 2) {
    lines.length = 2;
    lines[1] = clip(lines[1], font, size, maxW);
  }
  return lines;
}

// Column-per-job layout, mirroring the handwritten schedule. Landscape; jobs
// laid out left-to-right in order. Columns that don't fit across wrap to a new
// page; a very tall crew column continues on the next page in the same slot.
export async function buildSchedulePdf(data: ScheduleData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Landscape Letter.
  const PW = 792;
  const PH = 612;

  const nJobs = Math.max(data.jobs.length, 1);
  // Fit as many columns across as we can; aim for all jobs on one row when
  // there are 8 or fewer. Column width adapts to the count.
  const maxAcross = Math.min(nJobs, 8);
  const gap = 10;
  const usableW = PW - MARGIN * 2;
  const colW = Math.floor((usableW - gap * (maxAcross - 1)) / maxAcross);

  const headerH = 52; // top title block on page 1
  const colTop = PH - MARGIN - headerH;
  const rowH = 14;

  let page = pdf.addPage([PW, PH]);
  // Title block
  page.drawText("AMMEX REBAR PLACERS", { x: MARGIN, y: PH - MARGIN - 4, size: 15, font: bold, color: steel });
  const dl = longDate(data.date).toUpperCase();
  page.drawText(dl, { x: MARGIN, y: PH - MARGIN - 24, size: 12, font: bold, color: steel });
  const totalCrew = data.jobs.reduce((s, j) => s + j.crew.length, 0);
  page.drawText(`${data.jobs.length} jobs · ${totalCrew} crew`, { x: MARGIN, y: PH - MARGIN - 40, size: 10, font, color: gray });

  // Draw one job column at slot (col index) on the current page.
  function drawJobColumn(pg: PDFPage, slot: number, job: ScheduleJob, topY: number) {
    const x = MARGIN + slot * (colW + gap);
    let y = topY;
    // Job header — fixed height (2 lines reserved) so all columns align.
    const nameLines = wrap(job.name, bold, 9.5, colW - 8);
    const headH = 40;
    pg.drawRectangle({ x, y: y - headH, width: colW, height: headH, color: headBg });
    let hy = y - 12;
    for (const nl of nameLines) {
      pg.drawText(nl, { x: x + 4, y: hy, size: 9.5, font: bold, color: steel });
      hy -= 11;
    }
    if (job.jobId) pg.drawText(`#${job.jobId}`, { x: x + 4, y: y - headH + 6, size: 8, font, color: gray });
    y -= headH;
    pg.drawLine({ start: { x, y }, end: { x: x + colW, y }, thickness: 0.6, color: line });
    y -= 14;

    // Lead first, then crew alphabetical.
    const lead = job.crew.find((c) => c.isLead);
    const others = job.crew.filter((c) => !c.isLead).sort((a, b) =>
      a.worker.localeCompare(b.worker, undefined, { sensitivity: "base" })
    );
    const ordered = lead ? [lead, ...others] : others;

    for (const c of ordered) {
      const isLead = c.isLead;
      const nm = c.worker.toUpperCase();
      const lines = wrap(nm, isLead ? bold : font, 8.5, colW - 8);
      for (let li = 0; li < lines.length; li++) {
        pg.drawText(lines[li], {
          x: x + (li === 0 ? 4 : 10),
          y,
          size: 8.5,
          font: isLead ? bold : font,
          color: isLead ? blue : steel,
        });
        y -= rowH;
      }
      if (isLead) {
        // "Foreman" marker on its own line so it never overflows the column.
        pg.drawText("FOREMAN", { x: x + 10, y: y + 2, size: 6.5, font: bold, color: blue });
        y -= 11;
      }
    }
    return y;
  }

  // Lay out jobs across slots; wrap to a new page row when slots fill.
  let slot = 0;
  let pageTop = colTop; // page 1 columns start below the full title block
  for (const job of data.jobs) {
    if (slot >= maxAcross) {
      // new page for the next group of columns
      page = pdf.addPage([PW, PH]);
      page.drawText(`${longDate(data.date).toUpperCase()} (cont.)`, {
        x: MARGIN, y: PH - MARGIN - 4, size: 11, font: bold, color: steel,
      });
      pageTop = PH - MARGIN - 24;
      slot = 0;
    }
    drawJobColumn(page, slot, job, pageTop);
    slot++;
  }

  return pdf.save();
}
