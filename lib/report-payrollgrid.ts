// Payroll Grid — every worker with hours, one row each, daily totals across the
// week. When a worker was on multiple jobs in a day, the cell shows the split
// (e.g., "5 | 3", earliest job first) instead of a combined total. No-work
// roster members are listed below. Read-only presentation of existing data.

import { RawRow, prettifyJob, addDaysISO } from "./report";
import { ReportLang, DAY_NAMES } from "./report-i18n";

export interface PayrollGridCell {
  text: string; // "" if no work, "8", or "5 | 3" for a split day
}

export interface PayrollGridRow {
  name: string;
  cells: PayrollGridCell[]; // one per visible day
  total: number;
}

export interface PayrollGrid {
  weekStartISO: string;
  weekEndISO: string;
  dayLabels: string[];
  rows: PayrollGridRow[]; // workers with hours, alphabetical
  noHours: string[]; // active roster names with zero hours
  grandTotal: number;
  lang: ReportLang;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtDay(iso: string, lang: ReportLang): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAY_NAMES[lang][dow]} ${m}/${d}`;
}

export function buildPayrollGrid(
  rows: RawRow[],
  activeRoster: string[],
  weekStartISO: string,
  weekEndISO: string,
  lang: ReportLang = "en"
): PayrollGrid {
  // Build a 7-slot week (Sun..Sat) keyed by day offset from weekStartISO.
  const nDays = 7;
  // worker -> dayIdx -> array of {hours, job, firstSeq} to support splits
  type DayJobs = Map<string, { hours: number; order: number }>; // job -> hours + first-seen order
  const byWorker = new Map<string, Map<number, DayJobs>>();
  let seq = 0;

  function dayIndex(iso: string): number {
    const a = new Date(weekStartISO + "T00:00:00Z").getTime();
    const b = new Date(iso + "T00:00:00Z").getTime();
    return Math.round((b - a) / 86400000);
  }

  for (const r of rows) {
    const idx = dayIndex(r.dateISO);
    if (idx < 0 || idx >= nDays) continue;
    const job = r.projectName.trim() || prettifyJob(r.jobText) || "—";
    let days = byWorker.get(r.worker);
    if (!days) {
      days = new Map();
      byWorker.set(r.worker, days);
    }
    let dj = days.get(idx);
    if (!dj) {
      dj = new Map();
      days.set(idx, dj);
    }
    const ex = dj.get(job);
    if (ex) ex.hours = r2(ex.hours + r.hours);
    else dj.set(job, { hours: r.hours, order: seq++ });
  }

  // Week runs Monday(idx0)..Sunday(idx6). Hide the trailing Sunday unless
  // someone worked it.
  let sundayWorked = false;
  for (const days of byWorker.values()) {
    const d6 = days.get(6);
    if (d6 && d6.size > 0) {
      sundayWorked = true;
      break;
    }
  }
  const startIdx = 0;
  const endIdx = sundayWorked ? 7 : 6; // exclude Sunday column if unworked

  const dayLabels: string[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    dayLabels.push(fmtDay(addDaysISO(weekStartISO, i), lang));
  }

  const gridRows: PayrollGridRow[] = [];
  for (const [name, days] of byWorker) {
    const cells: PayrollGridCell[] = [];
    let total = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const dj = days.get(i);
      if (!dj || dj.size === 0) {
        cells.push({ text: "" });
        continue;
      }
      // earliest job first
      const jobs = Array.from(dj.values()).sort((a, b) => a.order - b.order);
      const dayTotal = jobs.reduce((s, j) => s + j.hours, 0);
      total += dayTotal;
      const text =
        jobs.length === 1
          ? String(r2(jobs[0].hours))
          : jobs.map((j) => r2(j.hours)).join(" / ");
      cells.push({ text });
    }
    gridRows.push({ name, cells, total: r2(total) });
  }
  gridRows.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  const worked = new Set(byWorker.keys());
  const noHours = activeRoster
    .filter((n) => !worked.has(n))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const grandTotal = r2(gridRows.reduce((s, r) => s + r.total, 0));

  return {
    weekStartISO,
    weekEndISO,
    dayLabels,
    rows: gridRows,
    noHours,
    grandTotal,
    lang,
  };
}
