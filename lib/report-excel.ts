import * as XLSX from "xlsx";
import { ReportData, groupFlags } from "./report";
import { RT } from "./report-i18n";

// Builds an .xlsx workbook (as a Buffer) from the report data.
// Layout mirrors the payroll grid: names down the left, 7 days across,
// daily hours in cells, X for non-worked days, weekly totals on the right.

export function buildReportXlsx(rd: ReportData): Buffer {
  const aoa: (string | number)[][] = [];
  const tr = RT[rd.lang];

  const header = [tr.worker, ...rd.dayLabels, tr.total];

  aoa.push([`Ammex ${tr.payrollTitle} — ${rd.weekStartISO} ${tr.rangeJoin} ${rd.weekEndISO}`]);
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
        flagged ? `⚑ ${p.name}` : p.name,
        ...p.perDay.map((h) => (h == null ? "X" : h)),
        p.total,
      ]);
    }
    aoa.push([tr.dailyTotal, ...sec.dailyTotals, sec.grandTotal]);
    aoa.push([]);
  }

  // No hours logged (only for the full roster report)
  if (!rd.foremanReport) {
    aoa.push([tr.noHoursHeader]);
    if (rd.noHours.length === 0) {
      aoa.push([tr.everyoneLogged]);
    } else {
      for (const n of rd.noHours) aoa.push([n]);
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
