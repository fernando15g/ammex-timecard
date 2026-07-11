import { Client } from "@notionhq/client";
import { Resend } from "resend";
import {
  NOTION_TOKEN,
  TIMECARDS_DB_ID,
  CREW_ROSTER_DB_ID,
  TIMECARD_PROPS,
  ROSTER_PROPS,
  PAYROLL_RECIPIENT,
  RECON_LOG_DB_ID,
  RECON_PROPS,
  SCHEDULE_DB_ID,
  SCHEDULE_PROPS,
} from "./notion";
import { buildReport, RawRow } from "./report";
import { buildReportXlsx, buildWorkerXlsx, buildDailyXlsx } from "./report-excel";
import { buildReportPdf, buildWorkerPdf, buildDailyPdf, buildPayrollGridPdf } from "./report-pdf";
import { buildDailyReport } from "./report-daily";
import { buildPayrollGrid } from "./report-payrollgrid";
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
  reportView?: "job" | "worker" | "daily" | "foremanAll" | "payrollGrid";
}

// The full pipeline: read Notion for the span, build the files, email them.
// startISO..endISO is inclusive. Used by both the manual button and the cron.
// Load all timecard rows in the span plus the active roster. Shared by the
// on-demand report runner and the weekly auto-send bundle.
export async function loadRowsAndRoster(
  startISO: string,
  endISO: string
): Promise<{ rows: RawRow[]; activeRoster: string[] }> {
  const notion = new Client({ auth: NOTION_TOKEN });

  const raw: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: TIMECARDS_DB_ID,
      filter: {
        and: [
          { property: TIMECARD_PROPS.date, date: { on_or_after: startISO } },
          { property: TIMECARD_PROPS.date, date: { on_or_before: endISO } },
          { property: TIMECARD_PROPS.voided, checkbox: { equals: false } },
          { property: TIMECARD_PROPS.underReview, checkbox: { equals: false } },
        ],
      },
      start_cursor: cursor,
      page_size: 100,
    });
    raw.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

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
    const projectPageId = relationIds(props[TIMECARD_PROPS.projectHelper])[0] || "";
    if (!worker || !dateISO) continue;
    rows.push({ worker, dateISO, hours, jobText, projectName, jobId, foreman, projectPageId });
  }

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

  return { rows, activeRoster };
}

// Confirmed-OK flags from the Reconciliation Log for [start,end] as a set of
// `worker|dateISO|kindlabel` — used to hide already-reviewed flags on reports.
// Schedule leads for the report span. Returns the lead foreman per job+date
// (keyed `jobPageId|dateISO`) and the set of all lead names — used to make
// foreman reports schedule-driven (his crew = jobs he led) instead of
// submitter-driven, and to give every lead a page in the weekly bundle even
// if he personally submitted nothing.
async function loadScheduleLeads(
  notion: Client,
  startISO: string,
  endISO: string
): Promise<{ leadByJobDate: Map<string, string>; leadNames: Set<string> }> {
  const leadByJobDate = new Map<string, string>();
  const leadNames = new Set<string>();
  try {
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: SCHEDULE_DB_ID,
        filter: {
          and: [
            { property: SCHEDULE_PROPS.date, date: { on_or_after: startISO } },
            { property: SCHEDULE_PROPS.date, date: { on_or_before: endISO } },
            { property: SCHEDULE_PROPS.isLead, checkbox: { equals: true } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const p = pg.properties || {};
        const worker = (p[SCHEDULE_PROPS.worker]?.title || [])
          .map((t: any) => t.plain_text).join("").trim();
        const date = p[SCHEDULE_PROPS.date]?.date?.start?.slice(0, 10) || "";
        const jobId = (p[SCHEDULE_PROPS.job]?.relation || [])[0]?.id || "";
        if (worker && date && jobId) {
          leadByJobDate.set(`${jobId}|${date}`, worker);
          leadNames.add(worker);
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch { /* schedule unavailable → callers fall back to submitter-based */ }
  return { leadByJobDate, leadNames };
}

async function loadConfirmedFlagKeys(
  notion: Client,
  startISO: string,
  endISO: string
): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    let fc: string | undefined = undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: RECON_LOG_DB_ID,
        filter: {
          and: [
            { property: RECON_PROPS.date, date: { on_or_after: startISO } },
            { property: RECON_PROPS.date, date: { on_or_before: endISO } },
            { property: RECON_PROPS.status, select: { equals: "Confirmed OK" } },
          ],
        },
        start_cursor: fc,
        page_size: 100,
      });
      for (const pg of res.results) {
        const p = pg.properties || {};
        const w = (p[RECON_PROPS.worker]?.title || []).map((t: any) => t.plain_text).join("").trim();
        const d = p[RECON_PROPS.date]?.date?.start?.slice(0, 10) || "";
        const k = p[RECON_PROPS.kind]?.select?.name || "";
        if (w && d && k) keys.add(`${w.toLowerCase()}|${d}|${k.toLowerCase()}`);
      }
      fc = res.has_more ? res.next_cursor : undefined;
    } while (fc);
  } catch { /* log may be empty */ }
  return keys;
}

// Held-for-review rows for [start,end] — excluded from totals but surfaced on
// the report as an "on hold" callout so a forgotten hold can't slip past.
async function loadHeldRows(
  notion: Client,
  startISO: string,
  endISO: string,
  foreman?: string
): Promise<{ worker: string; dateISO: string; job: string; hours: number }[]> {
  const out: { worker: string; dateISO: string; job: string; hours: number }[] = [];
  try {
    let cursor: string | undefined = undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: TIMECARDS_DB_ID,
        filter: {
          and: [
            { property: TIMECARD_PROPS.date, date: { on_or_after: startISO } },
            { property: TIMECARD_PROPS.date, date: { on_or_before: endISO } },
            { property: TIMECARD_PROPS.underReview, checkbox: { equals: true } },
            { property: TIMECARD_PROPS.voided, checkbox: { equals: false } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const page of res.results) {
        const p = page.properties || {};
        const worker = readText(p[TIMECARD_PROPS.worker]);
        const dateISO = p[TIMECARD_PROPS.date]?.date?.start?.slice(0, 10) || "";
        const hours = typeof p[TIMECARD_PROPS.hours]?.number === "number" ? p[TIMECARD_PROPS.hours].number : 0;
        const fm = readText(p[TIMECARD_PROPS.foreman]);
        const job = readText(p[TIMECARD_PROPS.projectHelper]) || readText(p[TIMECARD_PROPS.job]);
        if (!worker || !dateISO) continue;
        if (foreman && fm.trim().toLowerCase() !== foreman.trim().toLowerCase()) continue;
        out.push({ worker, dateISO, job, hours });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch { /* held is optional */ }
  return out;
}

// Weekly auto-send bundle: Master report, Payroll Grid, and Owner Review —
// Daily, all as PDF, in one email. Used by the Monday cron.
export async function runWeeklyBundle(
  startISO: string,
  endISO: string
): Promise<{ ok: boolean; attachments: number }> {
  const { rows, activeRoster } = await loadRowsAndRoster(startISO, endISO);
  const bundleNotion = new Client({ auth: NOTION_TOKEN });
  const confirmedFlagKeys = await loadConfirmedFlagKeys(bundleNotion, startISO, endISO);

  // Master report (job-grouped grid)
  const masterRd = buildReport(rows, activeRoster, startISO, THRESHOLD, endISO, undefined, "en", confirmedFlagKeys);
  masterRd.onHold = await loadHeldRows(bundleNotion, startISO, endISO);
  const masterPdf = await buildReportPdf(masterRd);

  // Payroll Grid
  const pg = buildPayrollGrid(rows, activeRoster, startISO, endISO, "en");
  const pgPdf = await buildPayrollGridPdf(pg);

  // Owner Review — Daily
  const daily = buildDailyReport(rows, startISO, endISO, "en");
  const dailyPdf = await buildDailyPdf(daily);

  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: FROM,
    to: PAYROLL_RECIPIENT,
    subject: `Weekly reports — ${startISO} to ${endISO}`,
    text:
      `Attached are this week's reports (PDF):\n` +
      `• Master report\n• Payroll Grid\n• Owner Review — Daily\n\n` +
      `Week: ${startISO} to ${endISO}`,
    attachments: [
      { filename: `Ammex_Master_${startISO}_to_${endISO}.pdf`, content: b64(masterPdf) },
      { filename: `Ammex_PayrollGrid_${startISO}_to_${endISO}.pdf`, content: b64(pgPdf) },
      { filename: `Ammex_OwnerReview_${startISO}_to_${endISO}.pdf`, content: b64(dailyPdf) },
    ],
  });

  return { ok: true, attachments: 3 };
}

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
      : opts.reportView === "payrollGrid"
      ? "payrollGrid"
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
          { property: TIMECARD_PROPS.voided, checkbox: { equals: false } },
          { property: TIMECARD_PROPS.underReview, checkbox: { equals: false } },
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
    const projectPageId = relationIds(props[TIMECARD_PROPS.projectHelper])[0] || "";

    if (!worker || !dateISO) continue;
    rows.push({ worker, dateISO, hours, jobText, projectName, jobId, foreman, projectPageId });
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

  // 4b) Confirmed-OK flags from the cockpit — removed from the report's flags.
  const confirmedFlagKeys = await loadConfirmedFlagKeys(notion, startISO, endISO);

  // 4c) Schedule leads — makes foreman reports schedule-driven (his crew =
  // jobs he led that day), independent of who submitted the card.
  const schedLeads = await loadScheduleLeads(notion, startISO, endISO);
  const sched = { leadByJobDate: schedLeads.leadByJobDate };

  // 5) Build report + files

  // 5-PG) Payroll Grid: every worker × day, PDF only.
  if (reportView === "payrollGrid") {
    const pg = buildPayrollGrid(rows, activeRoster, startISO, endISO, lang);
    const pgPdf = await buildPayrollGridPdf(pg);
    const pgB64 = Buffer.from(pgPdf).toString("base64");
    const pgName = `Ammex_PayrollGrid_${startISO}_to_${endISO}`;
    if (mode === "view") {
      return {
        ok: true,
        weekStart: startISO,
        weekEnd: endISO,
        jobs: pg.rows.length,
        unassigned: 0,
        noHours: pg.noHours.length,
        flags: 0,
        debug: { workers: pg.rows.length },
        pdfBase64: pgB64,
        filename: `${pgName}.pdf`,
      };
    }
    const resendPg = new Resend(process.env.RESEND_API_KEY);
    await resendPg.emails.send({
      from: FROM,
      to: PAYROLL_RECIPIENT,
      subject: `Payroll Grid — ${startISO} to ${endISO}`,
      text:
        `Payroll Grid attached (PDF).\n\n` +
        `Range: ${startISO} to ${endISO}\n` +
        `Workers with hours: ${pg.rows.length}\n` +
        `No hours: ${pg.noHours.length}`,
      attachments: [{ filename: `${pgName}.pdf`, content: pgB64 }],
    });
    return {
      ok: true,
      weekStart: startISO,
      weekEnd: endISO,
      jobs: pg.rows.length,
      unassigned: 0,
      noHours: pg.noHours.length,
      flags: 0,
      debug: { workers: pg.rows.length },
    };
  }

  // 5-ALL) Foreman breakout: one document with a section per foreman.
  if (reportView === "foremanAll") {
    // Every submitter PLUS every scheduled lead — a lead whose cards were all
    // submitted by someone else still gets his section.
    const foremen = Array.from(
      new Set([
        ...rows.map((r) => (r.foreman || "").trim()).filter(Boolean),
        ...Array.from(schedLeads.leadNames),
      ])
    ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    const pdfParts: Uint8Array[] = [];
    const wbCombined = XLSX.utils.book_new();
    const usedNames = new Set<string>();

    for (const fm of foremen) {
      const rdf = buildReport(rows, activeRoster, startISO, THRESHOLD, endISO, fm, lang, confirmedFlagKeys, sched);
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
            buildReport(rows, activeRoster, startISO, THRESHOLD, endISO, undefined, lang, confirmedFlagKeys)
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
            buildReport(rows, activeRoster, startISO, THRESHOLD, endISO, undefined, lang, confirmedFlagKeys)
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
    lang,
    confirmedFlagKeys,
    foreman ? sched : undefined
  );
  if (!flagsOn) rd.flags = [];
  rd.onHold = await loadHeldRows(notion, startISO, endISO, foreman || undefined);

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
