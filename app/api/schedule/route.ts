import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { Resend } from "resend";
import {
  NOTION_TOKEN,
  SCHEDULE_DB_ID,
  SCHEDULE_PROPS,
  PROJECT_PROPS,
  PAYROLL_RECIPIENT,
} from "@/lib/notion";
import { buildSchedulePdf, ScheduleData, ScheduleJob } from "@/lib/schedule-pdf";

export const dynamic = "force-dynamic";

const FROM = "Ammex Schedule <timecards@send.ammexrebar.com>";
const PIN = "5314";

interface Assignment {
  worker: string;
  jobPageId: string;
  jobName: string;
  jobId: string;
  isLead: boolean;
}

// Resolve a Projects page id -> { name, jobId }, cached per request.
async function jobLookup(notion: Client, ids: string[]) {
  const map = new Map<string, { name: string; jobId: string }>();
  const unique = Array.from(new Set(ids));
  for (const id of unique) {
    try {
      const pg: any = await notion.pages.retrieve({ page_id: id });
      const props = pg.properties || {};
      const name =
        (props[PROJECT_PROPS.name]?.title || [])
          .map((t: any) => t.plain_text)
          .join("") || "";
      const jobId =
        (props[PROJECT_PROPS.jobId]?.rich_text || [])
          .map((t: any) => t.plain_text)
          .join("") || "";
      map.set(id, { name, jobId });
    } catch {
      map.set(id, { name: "(unknown job)", jobId: "" });
    }
  }
  return map;
}

// GET ?date=ISO  -> that day's schedule (for reopen/edit)
// GET ?recent=1  -> the most recent saved schedule (for carry-over)
export async function GET(req: NextRequest) {
  if (!NOTION_TOKEN) {
    return NextResponse.json({ error: "NOTION_TOKEN not set" }, { status: 500 });
  }
  const notion = new Client({ auth: NOTION_TOKEN });
  const date = req.nextUrl.searchParams.get("date")?.trim();
  const recent = req.nextUrl.searchParams.get("recent");

  try {
    let targetDate = date || "";

    if (recent === "1" && !date) {
      // Find the most recent date that has any schedule rows.
      const r: any = await notion.databases.query({
        database_id: SCHEDULE_DB_ID,
        sorts: [{ property: SCHEDULE_PROPS.date, direction: "descending" }],
        page_size: 1,
      });
      if (r.results.length === 0) {
        return NextResponse.json({ date: null, jobs: [] });
      }
      targetDate =
        r.results[0].properties?.[SCHEDULE_PROPS.date]?.date?.start || "";
    }

    if (!targetDate) return NextResponse.json({ date: null, jobs: [] });

    // Pull all rows for that date.
    const rows: any[] = [];
    let cursor: string | undefined = undefined;
    do {
      const resp: any = await notion.databases.query({
        database_id: SCHEDULE_DB_ID,
        start_cursor: cursor,
        page_size: 100,
        filter: {
          property: SCHEDULE_PROPS.date,
          date: { equals: targetDate },
        },
      });
      rows.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    // Resolve job names.
    const jobIds = rows
      .map((r) => r.properties?.[SCHEDULE_PROPS.job]?.relation?.[0]?.id)
      .filter(Boolean);
    const lookup = await jobLookup(notion, jobIds);

    // Group by job page id.
    const byJob = new Map<string, ScheduleJob>();
    for (const r of rows) {
      const props = r.properties || {};
      const worker =
        (props[SCHEDULE_PROPS.worker]?.title || [])
          .map((t: any) => t.plain_text)
          .join("") || "";
      const jobPageId = props[SCHEDULE_PROPS.job]?.relation?.[0]?.id || "";
      const isLead = !!props[SCHEDULE_PROPS.isLead]?.checkbox;
      if (!worker || !jobPageId) continue;
      const info = lookup.get(jobPageId) || { name: "(unknown)", jobId: "" };
      let jg = byJob.get(jobPageId);
      if (!jg) {
        jg = { jobPageId, name: info.name, jobId: info.jobId, crew: [] };
        byJob.set(jobPageId, jg);
      }
      jg.crew.push({ worker, isLead });
    }

    return NextResponse.json({
      date: targetDate,
      jobs: Array.from(byJob.values()),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to load schedule" },
      { status: 502 }
    );
  }
}

// POST: save a schedule (overwrite the date) and email a PDF.
export async function POST(req: NextRequest) {
  if (!NOTION_TOKEN) {
    return NextResponse.json({ error: "NOTION_TOKEN not set" }, { status: 500 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (body?.pin !== PIN) {
    return NextResponse.json({ error: "Bad PIN" }, { status: 401 });
  }
  const date: string = (body?.date || "").trim();
  const assignments: Assignment[] = Array.isArray(body?.assignments)
    ? body.assignments
    : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Bad date" }, { status: 400 });
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // 1) Archive (overwrite) any existing rows for this date.
    let cursor: string | undefined = undefined;
    const existing: string[] = [];
    do {
      const resp: any = await notion.databases.query({
        database_id: SCHEDULE_DB_ID,
        start_cursor: cursor,
        page_size: 100,
        filter: { property: SCHEDULE_PROPS.date, date: { equals: date } },
      });
      existing.push(...resp.results.map((r: any) => r.id));
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    for (const id of existing) {
      await notion.pages.update({ page_id: id, archived: true });
    }

    // 2) Create new rows.
    for (const a of assignments) {
      if (!a.worker || !a.jobPageId) continue;
      await notion.pages.create({
        parent: { database_id: SCHEDULE_DB_ID },
        properties: {
          [SCHEDULE_PROPS.worker]: {
            title: [{ text: { content: a.worker } }],
          },
          [SCHEDULE_PROPS.date]: { date: { start: date } },
          [SCHEDULE_PROPS.job]: { relation: [{ id: a.jobPageId }] },
          [SCHEDULE_PROPS.isLead]: { checkbox: !!a.isLead },
        },
      });
    }

    // 3) Build a formatted PDF and email it.
    const jobsMap = new Map<string, ScheduleJob>();
    for (const a of assignments) {
      let jg = jobsMap.get(a.jobPageId);
      if (!jg) {
        jg = { jobPageId: a.jobPageId, name: a.jobName, jobId: a.jobId, crew: [] };
        jobsMap.set(a.jobPageId, jg);
      }
      jg.crew.push({ worker: a.worker, isLead: a.isLead });
    }
    const data: ScheduleData = {
      date,
      jobs: Array.from(jobsMap.values()),
    };
    const pdf = await buildSchedulePdf(data);
    const pdfB64 = Buffer.from(pdf).toString("base64");
    const fname = `Ammex_Schedule_${date}.pdf`;

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: FROM,
      to: PAYROLL_RECIPIENT,
      subject: `Daily Schedule — ${date}`,
      text:
        `Schedule for ${date} attached.\n\n` +
        `Jobs: ${data.jobs.length}\n` +
        `Crew assignments: ${assignments.length}`,
      attachments: [{ filename: fname, content: pdfB64 }],
    });

    return NextResponse.json({
      ok: true,
      date,
      jobs: data.jobs.length,
      assignments: assignments.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to save schedule" },
      { status: 502 }
    );
  }
}
