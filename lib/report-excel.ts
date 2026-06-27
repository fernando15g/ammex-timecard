import * as XLSX from "xlsx";
import { ReportData, groupFlags } from "./report";

// Builds an .xlsx workbook (as a Buffer) from the report data.
// Layout mirrors the payroll grid: names down the left, 7 days across,
// daily hours in cells, X for non-worked days, weekly totals on the right.

export function buildReportXlsx(rd: ReportData): Buffer {
  const aoa: (string | number)[][] = [];

  const header = ["Worker", ...rd.dayLabels, "Total"];

  aoa.push([`Ammex Weekly Payroll — ${rd.weekStartISO} to ${rd.weekEndISO}`]);
  aoa.push([]);

  for (const sec of rd.sections) {
    const label = sec.unassigned
      ? `UNASSIGNED — ${sec.title}`
      : sec.jobId
      ? `${sec.title}  (Job ID: ${sec.jobId})`
      : sec.title;
    aoa.push([label]);
    aoa.push(header);
    for (const p of sec.people) {
      aoa.push([
        p.name,
        ...p.perDay.map((h) => (h == null ? "X" : h)),
        p.total,
      ]);
    }
    aoa.push(["Daily total", ...sec.dailyTotals, sec.grandTotal]);
    aoa.push([]);
  }

  // No hours logged
  aoa.push(["NO HOURS LOGGED THIS WEEK"]);
  if (rd.noHours.length === 0) {
    aoa.push(["(everyone on the roster logged hours)"]);
  } else {
    for (const n of rd.noHours) aoa.push([n]);
  }
  aoa.push([]);

  // Flags
  aoa.push(["FLAGS TO REVIEW"]);
  if (rd.flags.length === 0) {
    aoa.push(["(none)"]);
  } else {
    aoa.push(["Worker", "Date", "Issue"]);
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
