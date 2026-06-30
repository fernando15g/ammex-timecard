import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";

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
const line = rgb(0.8, 0.8, 0.8);
const MARGIN = 40;

const DAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

function clip(s: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  let t = s;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxW) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

// A clean daily schedule that mirrors the handwritten sheet: each job as a
// block, the lead foreman marked, the crew listed under it.
export async function buildSchedulePdf(data: ScheduleData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const PW = 612;
  const PH = 792;
  let page = pdf.addPage([PW, PH]);
  let y = PH - MARGIN;

  function ensure(h: number) {
    if (y - h < MARGIN) {
      page = pdf.addPage([PW, PH]);
      y = PH - MARGIN;
    }
  }

  // Header
  page.drawText("AMMEX REBAR PLACERS", { x: MARGIN, y, size: 16, font: bold, color: steel });
  y -= 20;
  page.drawText(`Daily Schedule — ${longDate(data.date)}`, {
    x: MARGIN, y, size: 12, font, color: gray,
  });
  y -= 14;
  const totalCrew = data.jobs.reduce((s, j) => s + j.crew.length, 0);
  page.drawText(`${data.jobs.length} jobs · ${totalCrew} crew`, {
    x: MARGIN, y, size: 10, font, color: gray,
  });
  y -= 24;

  const rightX = PW - MARGIN;

  for (const job of data.jobs) {
    ensure(40 + job.crew.length * 15);
    // Job heading
    const jobLine = job.jobId ? `${job.name} (${job.jobId})` : job.name;
    page.drawText(clip(jobLine, bold, 13, PW - MARGIN * 2), {
      x: MARGIN, y, size: 13, font: bold, color: steel,
    });
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: rightX, y }, thickness: 0.6, color: line });
    y -= 16;

    // Lead foreman first (highlighted in blue), then the rest of the crew.
    const lead = job.crew.find((c) => c.isLead);
    const others = job.crew.filter((c) => !c.isLead);
    if (lead) {
      page.drawText("Foreman:", { x: MARGIN + 6, y, size: 10.5, font: bold, color: blue });
      page.drawText(lead.worker.toUpperCase(), {
        x: MARGIN + 6 + bold.widthOfTextAtSize("Foreman:  ", 10.5),
        y, size: 10.5, font: bold, color: blue,
      });
      y -= 16;
    }
    for (const c of others) {
      page.drawText(c.worker.toUpperCase(), { x: MARGIN + 18, y, size: 10.5, font, color: steel });
      y -= 14;
    }
    if (!lead && others.length === 0) {
      page.drawText("(no crew assigned)", { x: MARGIN + 18, y, size: 9.5, font, color: gray });
      y -= 14;
    }
    y -= 12;
  }

  return pdf.save();
}
