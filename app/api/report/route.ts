import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { Resend } from "resend";
import {
  NOTION_TOKEN,
  TIMECARDS_DB_ID,
  CREW_ROSTER_DB_ID,
  TIMECARD_PROPS,
  ROSTER_PROPS,
  PAYROLL_RECIPIENT,
} from "@/lib/notion";
import {
  buildReport,
  addDaysISO,
  lastCompletedWeekStart,
  RawRow,
} from "@/lib/report";
import { buildReportXlsx } from "@/lib/report-excel";
import { buildReportPdf } from "@/lib/report-pdf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REPORT_PIN = "5314";
const FROM = "Ammex Timecard <timecards@send.ammexrebar.com>";

function todayISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// Pull a plain-text value out of almost any Notion property shape.
function readText(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
      return (prop.title || []).map((t: any) => t.plain_text).join("").trim();
    case "rich_text":
      return (prop.rich_text || []).map((t: any) => t.plain_text).join("").trim();
    case "select":
      return prop.select?.name || "";
    case "multi_select":
      return (prop.multi_select || []).map((s: any) => s.name).join(", ");
    case "number":
      return prop.number == null ? "" : String(prop.number);
    case "formula":
      if (prop.formula?.type === "string") return prop.formula.string || "";
      if (prop.formula?.type === "number")
        return prop.formula.number == null ? "" : String(prop.formula.number);
      return "";
    case "rollup": {
      const r = prop.rollup;
      if (!r) return "";
      if (r.type === "number") return r.number == null ? "" : String(r.number);
      if (r.type === "array") {
        return (r.array || [])
          .map((sub: any) => readText(sub))
          .filter(Boolean)
          .join(", ");
      }
      if (r.type === "string") return r.string || "";
      return "";
    }
    default:
      return "";
  }
}

// Relation properties only give page IDs; we resolve titles separately.
function relationIds(prop: any): string[] {
  if (prop?.type === "relation") return (prop.relation || []).map((r: any) => r.id);
  return [];
}

export async function POST(req: Request) {
  if (!NOTION_TOKEN || !process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  if (body.pin !== REPORT_PIN) {
    return NextResponse.json({ error: "Wrong PIN." }, { status: 401 });
  }

  // Week start (a Sunday). Default: most recently completed week.
  let weekStart: string =
    typeof body.weekStart === "string" && body.weekStart
      ? body.weekStart
      : lastCompletedWeekStart(todayISO());
  const weekEnd = addDaysISO(weekStart, 6);
  const flagsOn = body.flags !== false; // default on
  const threshold = 11;

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // 1) Pull all timecard rows in the week
    const raw: any[] = [];
    let cursor: string | undefined = undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: TIMECARDS_DB_ID,
        filter: {
          and: [
            { property: TIMECARD_PROPS.date, date: { on_or_after: weekStart } },
            { property: TIMECARD_PROPS.date, date: { on_or_before: weekEnd } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      });
      raw.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    // 2) Resolve any relation-based Project Helper names
    const needResolve = new Set<string>();
    for (const page of raw) {
      const ph = page.properties?.[TIMECARD_PROPS.projectHelper];
      relationIds(ph).forEach((id) => needResolve.add(id));
    }
    const relTitle = new Map<string, string>();
    for (const id of needResolve) {
      try {
        const pg: any = await notion.pages.retrieve({ page_id: id });
        // find the title property on the related page
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

      // Project name: try text/rollup read first, then relation resolution
      let projectName = readText(props[TIMECARD_PROPS.projectHelper]);
      if (!projectName) {
        const ids = relationIds(props[TIMECARD_PROPS.projectHelper]);
        projectName = ids.map((id) => relTitle.get(id) || "").filter(Boolean).join(", ");
      }
      const jobId = readText(props[TIMECARD_PROPS.jobIdHelper]);

      if (!worker || !dateISO) continue;
      rows.push({ worker, dateISO, hours, jobText, projectName, jobId });
    }

    // 4) Active roster (for the "no hours" section)
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
    const rd = buildReport(rows, activeRoster, weekStart, threshold);
    if (!flagsOn) rd.flags = [];

    const xlsx = buildReportXlsx(rd);
    const pdfBytes = await buildReportPdf(rd);

    const xlsxB64 = Buffer.from(xlsx).toString("base64");
    const pdfB64 = Buffer.from(pdfBytes).toString("base64");

    const fnameBase = `Ammex_Payroll_${weekStart}_to_${weekEnd}`;

    // 6) Email both files
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: FROM,
      to: PAYROLL_RECIPIENT,
      subject: `Weekly Payroll — ${weekStart} to ${weekEnd}`,
      text:
        `Weekly payroll report attached (Excel + PDF).\n\n` +
        `Week: ${weekStart} to ${weekEnd}\n` +
        `Jobs: ${rd.sections.filter((s) => !s.unassigned).length}\n` +
        `Unassigned groups: ${rd.sections.filter((s) => s.unassigned).length}\n` +
        `No hours logged: ${rd.noHours.length}\n` +
        `Flags: ${rd.flags.length}`,
      attachments: [
        { filename: `${fnameBase}.xlsx`, content: xlsxB64 },
        { filename: `${fnameBase}.pdf`, content: pdfB64 },
      ],
    });

    return NextResponse.json({
      ok: true,
      weekStart,
      weekEnd,
      jobs: rd.sections.filter((s) => !s.unassigned).length,
      unassigned: rd.sections.filter((s) => s.unassigned).length,
      noHours: rd.noHours.length,
      flags: rd.flags.length,
    });
  } catch (err: any) {
    console.error("Report failed:", err?.message || err);
    return NextResponse.json(
      { error: "Report generation failed. " + (err?.message || "") },
      { status: 502 }
    );
  }
}
