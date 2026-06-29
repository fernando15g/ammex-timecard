import { Client } from "@notionhq/client";
import { Resend } from "resend";
import {
  NOTION_TOKEN,
  TIMECARDS_DB_ID,
  CREW_ROSTER_DB_ID,
  TIMECARD_PROPS,
  ROSTER_PROPS,
  PAYROLL_RECIPIENT,
} from "./notion";
import { buildReport, RawRow } from "./report";
import { buildReportXlsx, buildWorkerXlsx, buildDailyXlsx } from "./report-excel";
import { buildReportPdf, buildWorkerPdf, buildDailyPdf } from "./report-pdf";
import { buildDailyReport } from "./report-daily";
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";

// Merge several finished PDFs into one (each part starts on its own page).
async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const p of parts) {
    const src = await PDFDocument.load(p);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((pg) => out.addPage(pg));
  }
  return out.save();
}

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\\/?*\[\]:]/g, "").slice(0, 28) || "Foreman";
  let n = base;
  let i = 2;
  while (used.has(n)) n = `${base} ${i++}`.slice(0, 31);
  used.add(n);
  return n;
}

const FROM = "Ammex Timecard <timecards@send.ammexrebar.com>";
const THRESHOLD = 11;

// Pull a plain-text value out of almost any Notion property shape.
export function readText(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
      return (prop.title || []).map((t: any) => t.plain_text).join("").trim();
    case "rich_text":
      return (prop.rich_text || []).map((t: any) => t.plain_text).join("").trim();
    case "select":
      return prop.select?.name || "";
    case "status":
      return prop.status?.name || "";
    case "multi_select":
      return (prop.multi_select || []).map((s: any) => s.name).join(", ");
    case "number":
      return prop.number == null ? "" : String(prop.number);
    case "date":
      return prop.date?.start || "";
    case "formula":
      if (prop.formula?.type === "string") return prop.formula.string || "";
      if (prop.formula?.type === "number")
        return prop.formula.number == null ? "" : String(prop.formula.number);
      return "";
    case "rollup": {
      const r = prop.rollup;
      if (!r) return "";
      if (r.type === "number") return r.number == null ? "" : String(r.number);
      if (r.type === "date") return r.date?.start || "";
      if (r.type === "string") return r.string || "";
      if (r.type === "array") {
        return (r.array || [])
          .map((sub: any) => readText(sub))
          .filter(Boolean)
          .join(", ");
      }
      return "";
    }
    default:
      return "";
  }
}

export function relationIds(prop: any): string[] {
  if (!prop) return [];
  if (prop.type === "relation") return (prop.relation || []).map((r: any) => r.id);
  if (prop.type === "rollup" && prop.rollup?.type === "array") {
    const ids: string[] = [];
    for (const sub of prop.rollup.array || []) {
      if (sub?.type === "relation") {
        for (const r of sub.relation || []) ids.push(r.id);
      }
    }
    return ids;
  }
  return [];
}

export interface RunResult {
  ok: true;
  weekStart: string;
  weekEnd: string;
  jobs: number;
  unassigned: number;
  noHours: number;
  flags: number;
  debug: any;
  pdfBase64?: string; // present in "view" mode
  filename?: string;
}

export interface RunOptions {
  foreman?: string; // filter grid to this foreman
  lang?: "en" | "es";
  mode?: "email" | "view"; // email = send PDF+Excel; view = return PDF only
  reportView?: "job" | "worker" | "daily" | "foremanAll"; // grid, worker, daily, or all-foremen breakout
}

// The full pipeline: read Notion for the span, build the files, email them.
// startISO..endISO is inclusive. Used by both the manual button and the cron.
export async function runReport(
  startISO: string,
  endISO: string,
  flagsOn: boolean,
  opts: RunOptions = {}
): Promise<RunResult> {
  const foreman = opts.foreman?.trim() || "";
  const lang = opts.lang === "es" ? "es" : "en";
  const mode = opts.mode === "view" ? "view" : "email";
  const reportView =
    opts.reportView === "worker"
      ? "worker"
      : opts.reportView === "daily"
      ? "daily"
      : opts.reportView === "foremanAll"
      ? "foremanAll"
      : "job";
  const notion = new Client({ auth: NOTION_TOKEN });

  // 1) Pull all timecard rows in the span
  const raw: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: TIMECARDS_DB_ID,
      filter: {
        and: [
          { property: TIMECARD_PROPS.date, date: { on_or_after: startISO } },
          { property: TIMECARD_PROPS.date, date: { on_or_before: endISO } },
        ],
      },
      start_cursor: cursor,
      page_size: 100,
    });
    raw.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  // 2) Resolve relation-based Project Helper names
  const needResolve = new Set<string>();
  for (const page of raw) {
    const ph = page.properties?.[TIMECARD_PROPS.projectHelper];
    relationIds(ph).forEach((id) => needResolve.add(id));
  }
  const relTitle = new Map<string, string>();
  for (const id of needResolve) {
    try {
      const pg: any = await notion.pages.retrieve({ page_id: id });
      let title = "";
      for (const key of Object.keys(pg.properties || {})) {
        const p = pg.properties[key];
        if (p?.type === "title") {
          title = (p.title || []).map((t: any) => t.plain_text).join("").trim();
          break;
        }
      }
      if (title) relTitle.set(id, title);
    } catch {
      /* ignore unresolved */
    }
  }

  // 3) Shape rows
  const rows: RawRow[] = [];
  for (const page of raw) {
    const props = page.properties || {};
    const worker = readText(props[TIMECARD_PROPS.worker]);
    const dateISO = props[TIMECARD_PROPS.date]?.date?.start?.slice(0, 10) || "";
    const hoursVal = props[TIMECARD_PROPS.hours]?.number;
    const hours = typeof hoursVal === "number" ? hoursVal : 0;
    const jobText = readText(props[TIMECARD_PROPS.job]);

    let projectName = readText(props[TIMECARD_PROPS.projectHelper]);
    if (!projectName) {
      const ids = relationIds(props[TIMECARD_PROPS.projectHelper]);
      projectName = ids.map((id) => relTitle.get(id) || "").filter(Boolean).join(", ");
    }
    const jobId = readText(props[TIMECARD_PROPS.jobIdHelper]);
    const foreman = readText(props[TIMECARD_PROPS.foreman]);

    if (!worker || !dateISO) continue;
    rows.push({ worker, dateISO, hours, jobText, projectName, jobId, foreman });
  }

  // 4) Active roster
  const activeRoster: string[] = [];
  let rc: string | undefined = undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: CREW_ROSTER_DB_ID,
      filter: { property: ROSTER_PROPS.active, checkbox: { equals: true } },
      start_cursor: rc,
      page_size: 100,
    });
    for (const pg of res.results) {
      const nm = readText(pg.properties?.[ROSTER_PROPS.name]);
      if (nm) activeRoster.push(nm);
    }
    rc = res.has_more ? res.next_cursor : undefined;
  } while (rc);

  // 5) Build report + files

  // 5-ALL) Foreman breakout: one document with a section per foreman.
  if (reportView === "foremanAll") {
    const foremen = Array.from(
      new Set(rows.map((r) => (r.foreman || "").trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    const pdfParts: Uint8Array[] = [];
    const wbCombined = XLSX.utils.book_new();
    const usedNames = new Set<string>();

    for (const fm of foremen) {
      const rdf = buildReport(rows, activeRoster, startISO, THRESHOLD, endISO, fm, lang);
      if (!flagsOn) rdf.flags = [];
      pdfParts.push(await buildReportPdf(rdf));
      if (mode === "email") {
        const wbBuf = buildReportXlsx(rdf);
        const wb = XLSX.read(wbBuf, { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        XLSX.utils.book_append_sheet(wbCombined, sheet, safeSheetName(fm, usedNames));
      }
    }

    const mergedPdf =
      pdfParts.length > 0
        ? await mergePdfs(pdfParts)
        : await buildReportPdf(
            buildReport(rows, activeRoster, startISO, THRESHOLD, endISO, undefined, lang)
          );
    const pdfB64All = Buffer.from(mergedPdf).toString("base64");
    const fnameAll = `Ammex_Payroll_${startISO}_to_${endISO}_allForemen`;

    if (mode === "view") {
      return {
        ok: true,
        weekStart: startISO,
        weekEnd: endISO,
        jobs: foremen.length,
        unassigned: 0,
        noHours: 0,
        flags: 0,
        debug: { foremen },
        pdfBase64: pdfB64All,
        filename: `${fnameAll}.pdf`,
      };
    }

    const xlsxAll =
      foremen.length > 0
        ? (XLSX.write(wbCombined, { type: "buffer", bookType: "xlsx" }) as Buffer)
        : buildReportXlsx(
            buildReport(rows, activeRoster, startISO, THRESHOLD, endISO, undefined, lang)
          );
    const resendAll = new Resend(process.env.RESEND_API_KEY);
    await resendAll.emails.send({
      from: FROM,
      to: PAYROLL_RECIPIENT,
      subject: `Weekly Payroll — All Foremen — ${startISO} to ${endISO}`,
      text:
        `Per-foreman payroll breakout attached (PDF + Excel).\n\n` +
        `Range: ${startISO} to ${endISO}\n` +
        `Foremen: ${foremen.length} (${foremen.join(", ")})`,
      attachments: [
        { filename: `${fnameAll}.xlsx`, content: Buffer.from(xlsxAll).toString("base64") },
        { filename: `${fnameAll}.pdf`, content: pdfB64All },
      ],
    });
    return {
      ok: true,
      weekStart: startISO,
      weekEnd: endISO,
      jobs: foremen.length,
      unassigned: 0,
      noHours: 0,
      flags: 0,
      debug: { foremen },
    };
  }

  const rd = buildReport(
    rows,
    activeRoster,
    startISO,
    THRESHOLD,
    endISO,
    foreman || undefined,
    lang
  );
  if (!flagsOn) rd.flags = [];

  const isWorker = reportView === "worker";
  const isDaily = reportView === "daily";
  const dailyRd = isDaily
    ? buildDailyReport(rows, startISO, endISO, lang, foreman || undefined)
    : null;

  const pdfBytes = isDaily
    ? await buildDailyPdf(dailyRd!)
    : isWorker
    ? await buildWorkerPdf(rd)
    : await buildReportPdf(rd);
  const pdfB64 = Buffer.from(pdfBytes).toString("base64");
  const who = foreman ? `_${foreman.replace(/[^A-Za-z0-9]+/g, "")}` : "";
  const viewSuffix = isDaily ? "_daily" : isWorker ? "_byWorker" : "";
  const fnameBase = `Ammex_Payroll_${startISO}_to_${endISO}${who}${viewSuffix}`;

  // 6a) View mode: return the PDF for on-screen viewing/sharing. No email.
  if (mode === "view") {
    return {
      ok: true,
      weekStart: startISO,
      weekEnd: endISO,
      jobs: rd.sections.filter((s) => !s.unassigned).length,
      unassigned: rd.sections.filter((s) => s.unassigned).length,
      noHours: rd.noHours.length,
      flags: rd.flags.length,
      debug: buildDebug(raw, rows),
      pdfBase64: pdfB64,
      filename: `${fnameBase}.pdf`,
    };
  }

  // 6b) Email mode: send PDF + Excel as a record.
  const xlsx = isDaily
    ? buildDailyXlsx(dailyRd!)
    : isWorker
    ? buildWorkerXlsx(rd)
    : buildReportXlsx(rd);
  const xlsxB64 = Buffer.from(xlsx).toString("base64");
  const subjectWho = foreman ? ` (${foreman})` : "";
  const subjectView = isDaily ? " Daily Review" : isWorker ? " by Worker" : "";

  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: FROM,
    to: PAYROLL_RECIPIENT,
    subject: `Weekly Payroll${subjectView} — ${startISO} to ${endISO}${subjectWho}`,
    text:
      `Payroll report attached (Excel + PDF).\n\n` +
      (foreman ? `Foreman: ${foreman}\n` : ``) +
      `Range: ${startISO} to ${endISO}\n` +
      `Jobs: ${rd.sections.filter((s) => !s.unassigned).length}\n` +
      `Unassigned groups: ${rd.sections.filter((s) => s.unassigned).length}\n` +
      `No hours logged: ${rd.noHours.length}\n` +
      `Flags: ${rd.flags.length}`,
    attachments: [
      { filename: `${fnameBase}.xlsx`, content: xlsxB64 },
      { filename: `${fnameBase}.pdf`, content: pdfB64 },
    ],
  });

  return {
    ok: true,
    weekStart: startISO,
    weekEnd: endISO,
    jobs: rd.sections.filter((s) => !s.unassigned).length,
    unassigned: rd.sections.filter((s) => s.unassigned).length,
    noHours: rd.noHours.length,
    flags: rd.flags.length,
    debug: buildDebug(raw, rows),
  };
}

function buildDebug(raw: any[], rows: RawRow[]): any {
  const sample =
    raw.find((p: any) => {
      const ph = p.properties?.[TIMECARD_PROPS.projectHelper];
      return readText(ph) || relationIds(ph).length > 0;
    }) || raw[0];
  const allNames = sample ? Object.keys(sample.properties || {}) : [];
  return {
    totalRows: raw.length,
    rowsWithProjectName: rows.filter((r) => r.projectName).length,
    rowsWithJobId: rows.filter((r) => r.jobId).length,
    allPropertyNames: allNames,
    projectHelperType:
      sample?.properties?.[TIMECARD_PROPS.projectHelper]?.type || "NOT FOUND",
    jobIdHelperType:
      sample?.properties?.[TIMECARD_PROPS.jobIdHelper]?.type || "NOT FOUND",
  };
}
