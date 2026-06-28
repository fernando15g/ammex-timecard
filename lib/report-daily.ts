// Owner Review — Daily. Groups timecard rows by day → job → foreman → crew,
// with per-job daily subtotals. Read-only presentation of existing data.

import { RawRow, prettifyJob, addDaysISO } from "./report";
import { ReportLang } from "./report-i18n";

export interface DailyCrewLine {
  name: string;
  hours: number;
}

export interface DailyForemanGroup {
  foreman: string;
  crew: DailyCrewLine[];
  total: number;
}

export interface DailyJobGroup {
  title: string;
  jobId: string;
  foremen: DailyForemanGroup[];
  total: number;
}

export interface DailyDay {
  dateISO: string;
  dateLabel: string; // e.g., "Monday, June 22"
  jobs: DailyJobGroup[];
  total: number;
}

export interface DailyReport {
  weekStartISO: string;
  weekEndISO: string;
  days: DailyDay[];
  grandTotal: number;
  lang: ReportLang;
  foremanReport: boolean;
  foremanName: string;
}

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const DAYS_EN = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const DAYS_ES = [
  "Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado",
];

function longDate(iso: string, lang: ReportLang): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (lang === "es") {
    return `${DAYS_ES[dow]}, ${d} de ${MONTHS_ES[m - 1]}`;
  }
  return `${DAYS_EN[dow]}, ${MONTHS_EN[m - 1]} ${d}`;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildDailyReport(
  rows: RawRow[],
  weekStartISO: string,
  weekEndISO: string,
  lang: ReportLang = "en",
  foremanFilter?: string
): DailyReport {
  const ff = foremanFilter ? foremanFilter.trim().toLowerCase() : "";

  // date -> job key -> foreman -> crew map
  type FMap = Map<string, DailyCrewLine[]>; // foreman -> crew
  type JMap = Map<string, { title: string; jobId: string; foremen: FMap }>;
  const byDate = new Map<string, JMap>();

  for (const r of rows) {
    if (r.dateISO < weekStartISO || r.dateISO > weekEndISO) continue;
    const rowForeman = (r.foreman || "").trim();
    if (ff && rowForeman.toLowerCase() !== ff) continue;

    const assigned = !!r.projectName.trim();
    const title = assigned ? r.projectName.trim() : prettifyJob(r.jobText);
    const jobId = assigned ? r.jobId.trim() : "";
    const jobKey = assigned
      ? `P:${title.toLowerCase()}`
      : `J:${(r.jobText || "").trim().toLowerCase()}`;

    let jmap = byDate.get(r.dateISO);
    if (!jmap) {
      jmap = new Map();
      byDate.set(r.dateISO, jmap);
    }
    let jrec = jmap.get(jobKey);
    if (!jrec) {
      jrec = { title, jobId, foremen: new Map() };
      jmap.set(jobKey, jrec);
    }
    if (assigned && !jrec.jobId && jobId) jrec.jobId = jobId;

    const fKey = rowForeman || "—";
    let crew = jrec.foremen.get(fKey);
    if (!crew) {
      crew = [];
      jrec.foremen.set(fKey, crew);
    }
    crew.push({ name: r.worker, hours: r.hours });
  }

  // Assemble, sorted chronologically; within a day, jobs alphabetical;
  // within a job, foremen alphabetical; crew alphabetical.
  const days: DailyDay[] = [];
  const dateKeys = Array.from(byDate.keys()).sort();
  for (const dateISO of dateKeys) {
    const jmap = byDate.get(dateISO)!;
    const jobs: DailyJobGroup[] = [];
    for (const [, jrec] of jmap) {
      const foremen: DailyForemanGroup[] = [];
      for (const [foreman, crew] of jrec.foremen) {
        crew.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
        const ftotal = r2(crew.reduce((s, c) => s + c.hours, 0));
        foremen.push({ foreman: foreman === "—" ? "" : foreman, crew, total: ftotal });
      }
      foremen.sort((a, b) =>
        a.foreman.localeCompare(b.foreman, undefined, { sensitivity: "base" })
      );
      const jtotal = r2(foremen.reduce((s, f) => s + f.total, 0));
      jobs.push({ title: jrec.title, jobId: jrec.jobId, foremen, total: jtotal });
    }
    jobs.sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    );
    const dtotal = r2(jobs.reduce((s, j) => s + j.total, 0));
    days.push({
      dateISO,
      dateLabel: longDate(dateISO, lang),
      jobs,
      total: dtotal,
    });
  }

  const grandTotal = r2(days.reduce((s, d) => s + d.total, 0));

  return {
    weekStartISO,
    weekEndISO,
    days,
    grandTotal,
    lang,
    foremanReport: !!ff,
    foremanName: foremanFilter ? foremanFilter.trim() : "",
  };
}
