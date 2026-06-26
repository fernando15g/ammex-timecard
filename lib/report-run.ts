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
import { buildReportXlsx } from "./report-excel";
import { buildReportPdf } from "./report-pdf";

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
}

// The full pipeline: read Notion for the span, build the files, email them.
// startISO..endISO is inclusive. Used by both the manual button and the cron.
export async function runReport(
  startISO: string,
  endISO: string,
  flagsOn: boolean
): Promise<RunResult> {
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

    if (!worker || !dateISO) continue;
    rows.push({ worker, dateISO, hours, jobText, projectName, jobId });
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
  const rd = buildReport(rows, activeRoster, startISO, THRESHOLD, endISO);
  if (!flagsOn) rd.flags = [];

  const xlsx = buildReportXlsx(rd);
  const pdfBytes = await buildReportPdf(rd);
  const xlsxB64 = Buffer.from(xlsx).toString("base64");
  const pdfB64 = Buffer.from(pdfBytes).toString("base64");
  const fnameBase = `Ammex_Payroll_${startISO}_to_${endISO}`;

  // 6) Email both files
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: FROM,
    to: PAYROLL_RECIPIENT,
    subject: `Weekly Payroll — ${startISO} to ${endISO}`,
    text:
      `Payroll report attached (Excel + PDF).\n\n` +
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

  // Diagnostic sample (helps pinpoint relation/rollup issues)
  const sample =
    raw.find((p: any) => {
      const ph = p.properties?.[TIMECARD_PROPS.projectHelper];
      return readText(ph) || relationIds(ph).length > 0;
    }) || raw[0];
  const allNames = sample ? Object.keys(sample.properties || {}) : [];
  const debug = {
    totalRows: raw.length,
    rowsWithProjectName: rows.filter((r) => r.projectName).length,
    rowsWithJobId: rows.filter((r) => r.jobId).length,
    allPropertyNames: allNames,
    projectHelperType:
      sample?.properties?.[TIMECARD_PROPS.projectHelper]?.type || "NOT FOUND",
    jobIdHelperType:
      sample?.properties?.[TIMECARD_PROPS.jobIdHelper]?.type || "NOT FOUND",
  };

  return {
    ok: true,
    weekStart: startISO,
    weekEnd: endISO,
    jobs: rd.sections.filter((s) => !s.unassigned).length,
    unassigned: rd.sections.filter((s) => s.unassigned).length,
    noHours: rd.noHours.length,
    flags: rd.flags.length,
    debug,
  };
}
