import * as XLSX from "xlsx";
import { ReportData, groupFlags, fmtNumericDate } from "./report";
import { RT } from "./report-i18n";
import { DailyReport } from "./report-daily";

// Builds an .xlsx workbook (as a Buffer) from the report data.
// Layout mirrors the payroll grid: names down the left, 7 days across,
// daily hours in cells, X for non-worked days, weekly totals on the right.

export function buildReportXlsx(rd: ReportData): Buffer {
  const aoa: (string | number)[][] = [];
  const tr = RT[rd.lang];

  const header = [tr.worker, ...rd.dayLabels, tr.total];

  aoa.push([`Ammex ${tr.payrollTitle} — ${fmtNumericDate(rd.weekStartISO)} ${tr.rangeJoin} ${fmtNumericDate(rd.weekEndISO)}`]);
  if (rd.foremanReport && rd.foremanName) {
    aoa.push([`${tr.foremanLabel}: ${rd.foremanName}`]);
  }
  aoa.push([]);

  const flaggedNames = new Set(
    rd.flags.map((f) => f.worker.trim().toLowerCase())
  );

  for (const sec of rd.sections) {
    const label = sec.unassigned
      ? `${tr.unassigned} — ${sec.title}`
      : sec.jobId
      ? `${sec.title}  (${tr.jobId}: ${sec.jobId})`
      : sec.title;
    aoa.push([label]);
    aoa.push(header);
    for (const p of sec.people) {
      const flagged = flaggedNames.has(p.name.trim().toLowerCase());
      aoa.push([
        flagged ? `⚑ ${p.name.toUpperCase()}` : p.name.toUpperCase(),
        ...p.perDay.map((h) => (h == null ? "" : h)),
        p.total,
      ]);
    }
    aoa.push([tr.dailyTotal, ...sec.dailyTotals, sec.grandTotal]);
    aoa.push([]);
  }

  // Week grand total (reconciliation line) — full report only.
  if (!rd.foremanReport) {
    aoa.push([`${tr.weekTotal}: ${rd.grandTotal} ${tr.hrs}`]);
    aoa.push([]);
  }

  // No hours logged (only for the full roster report)
  if (!rd.foremanReport) {
    aoa.push([tr.noHoursHeader]);
    if (rd.noHours.length === 0) {
      aoa.push([tr.everyoneLogged]);
    } else {
      for (const n of rd.noHours) aoa.push([n.toUpperCase()]);
    }
    aoa.push([]);
  }

  // Flags
  aoa.push([tr.flagsHeader]);
  if (rd.flags.length === 0) {
    aoa.push([tr.none]);
  } else {
    aoa.push([tr.worker, "Date", "Issue"]);
    const groups = groupFlags(rd.flags, rd.overHoursThreshold);
    for (const g of groups) {
      g.lines.forEach((line, i) => {
        if (i === 0) {
          aoa.push([g.worker, g.dateISO, line]);
        } else {
          aoa.push(["", "", line]);
        }
      });
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Column widths: name + one per day + total
  ws["!cols"] = [
    { wch: 26 },
    ...rd.dayLabels.map(() => ({ wch: 10 })),
    { wch: 10 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Payroll");

  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return out as Buffer;
}

// Worker-grouped view: one row per worker-job line (Worker, Date, Job, Job ID,
// Hours), with a worker total row after each worker. Easy to sort/key from.
export function buildWorkerXlsx(rd: ReportData): Buffer {
  const aoa: (string | number)[][] = [];
  const tr = RT[rd.lang];

  aoa.push([`Ammex ${tr.workerReportTitle} — ${fmtNumericDate(rd.weekStartISO)} ${tr.rangeJoin} ${fmtNumericDate(rd.weekEndISO)}`]);
  if (rd.foremanReport && rd.foremanName) {
    aoa.push([`${tr.foremanLabel}: ${rd.foremanName}`]);
  }
  aoa.push([]);
  aoa.push([tr.worker, "Date", "Job", tr.jobId, tr.total]);

  for (const w of rd.workerSummaries) {
    for (const j of w.jobs) {
      aoa.push([w.name.toUpperCase(), j.firstDayLabel, j.title, j.jobId, j.hours]);
    }
    aoa.push([`${w.name.toUpperCase()} — ${tr.total}`, "", "", "", w.total]);
    aoa.push([]);
  }

  if (!rd.foremanReport) {
    aoa.push([`${tr.weekTotal}`, "", "", "", rd.grandTotal]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 24 },
    { wch: 12 },
    { wch: 26 },
    { wch: 10 },
    { wch: 10 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Payroll by Worker");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return out as Buffer;
}

// Owner Review — Daily Excel: a flat, sortable table
// (Date / Job / Job ID / Foreman / Worker / Hours).
export function buildDailyXlsx(rd: DailyReport): Buffer {
  const aoa: (string | number)[][] = [];
  const tr = RT[rd.lang];

  aoa.push([`Ammex ${tr.dailyReportTitle} — ${fmtNumericDate(rd.weekStartISO)} ${tr.rangeJoin} ${fmtNumericDate(rd.weekEndISO)}`]);
  if (rd.foremanReport && rd.foremanName) {
    aoa.push([`${tr.foremanLabel}: ${rd.foremanName}`]);
  }
  aoa.push([]);
  aoa.push(["Date", "Job", tr.jobId, tr.foremanLabel, tr.worker, tr.total]);

  for (const day of rd.days) {
    for (const job of day.jobs) {
      for (const fg of job.foremen) {
        for (const c of fg.crew) {
          aoa.push([day.dateLabel, job.title, job.jobId, fg.foreman.toUpperCase(), c.name.toUpperCase(), c.hours]);
        }
      }
    }
  }
  aoa.push([]);
  if (!rd.foremanReport) {
    aoa.push([`${tr.weekTotal}`, "", "", "", "", rd.grandTotal]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 22 }, { wch: 26 }, { wch: 10 }, { wch: 20 }, { wch: 22 }, { wch: 8 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Daily Review");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return out as Buffer;
}
