import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { Resend } from "resend";
import {
  NOTION_TOKEN,
  SCHEDULE_DB_ID,
  SCHEDULE_PROPS,
  PROJECT_PROPS,
  PROJECTS_DB_ID,
  PAYROLL_RECIPIENT,
  TIMECARDS_DB_ID,
  TIMECARD_PROPS,
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


// Actual hours worked per job for a date, from the Timecards DB. Used to show
// what really happened against the plan: who showed up (and for how long), and
// who worked the job without being scheduled. Payable hours only (voided and
// on-hold cards excluded), consistent with the reports.
async function actualsForDate(
  notion: Client,
  dateISO: string
): Promise<Map<string, Map<string, { worker: string; hours: number }>>> {
  const byJob = new Map<string, Map<string, { worker: string; hours: number }>>();
  try {
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: TIMECARDS_DB_ID,
        filter: {
          and: [
            { property: TIMECARD_PROPS.date, date: { equals: dateISO } },
            { property: TIMECARD_PROPS.voided, checkbox: { equals: false } },
            { property: TIMECARD_PROPS.underReview, checkbox: { equals: false } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const p = pg.properties || {};
        const worker = (p[TIMECARD_PROPS.worker]?.title || [])
          .map((t: any) => t.plain_text).join("").replace(/\s+/g, " ").trim();
        const jobPageId = p[TIMECARD_PROPS.projectHelper]?.relation?.[0]?.id || "";
        const hours = typeof p[TIMECARD_PROPS.hours]?.number === "number" ? p[TIMECARD_PROPS.hours].number : 0;
        if (!worker || !jobPageId) continue;
        let m = byJob.get(jobPageId);
        if (!m) { m = new Map(); byJob.set(jobPageId, m); }
        const k = worker.toLowerCase();
        const ex = m.get(k);
        if (ex) ex.hours = Math.round((ex.hours + hours) * 100) / 100;
        else m.set(k, { worker, hours });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch { /* actuals are additive — never block the schedule */ }
  return byJob;
}


// Load a full ScheduleData (plan + actuals) for one date. Shared by the
// on-demand PDF export so the exported sheet matches what's on screen.
async function loadScheduleForDate(notion: Client, dateISO: string): Promise<ScheduleData> {
  const rows: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const resp: any = await notion.databases.query({
      database_id: SCHEDULE_DB_ID,
      start_cursor: cursor,
      page_size: 100,
      filter: { property: SCHEDULE_PROPS.date, date: { equals: dateISO } },
    });
    rows.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  const jobIds = rows
    .map((r) => r.properties?.[SCHEDULE_PROPS.job]?.relation?.[0]?.id)
    .filter(Boolean);
  const lookup = await jobLookup(notion, jobIds);

  const byJob = new Map<string, ScheduleJob>();
  for (const r of rows) {
    const props = r.properties || {};
    const worker = (props[SCHEDULE_PROPS.worker]?.title || [])
      .map((t: any) => t.plain_text).join("") || "";
    const jobPageId = props[SCHEDULE_PROPS.job]?.relation?.[0]?.id || "";
    const isLead = !!props[SCHEDULE_PROPS.isLead]?.checkbox;
    if (!worker || !jobPageId) continue;
    const info = lookup.get(jobPageId) || { name: "(unknown)", jobId: "" };
    let jg = byJob.get(jobPageId);
    if (!jg) { jg = { jobPageId, name: info.name, jobId: info.jobId, crew: [] }; byJob.set(jobPageId, jg); }
    jg.crew.push({ worker, isLead });
  }

  const actuals = await actualsForDate(notion, dateISO);
  const jobs = Array.from(byJob.values());
  for (const jg of jobs) {
    const worked = actuals.get(jg.jobPageId);
    if (!worked) continue;
    const scheduledKeys = new Set(jg.crew.map((c) => c.worker.toLowerCase()));
    for (const c of jg.crew) {
      const hit = worked.get(c.worker.toLowerCase());
      if (hit) c.hours = hit.hours;
    }
    for (const [k, v] of worked) {
      if (!scheduledKeys.has(k)) jg.crew.push({ worker: v.worker, isLead: false, hours: v.hours, unscheduled: true });
    }
  }
  return { date: dateISO, jobs };
}

// Resolve a Projects page id -> { name, jobId }, cached per request.
// Job id → {name, jobId}. One cached Projects-DB query instead of a sequential
// page-retrieve per id (same speed pattern as the recon route).
let schedProjCache: { map: Map<string, { name: string; jobId: string }>; ts: number } | null = null;
const SCHED_PROJ_TTL = 5 * 60 * 1000;

async function jobLookup(notion: Client, ids: string[]) {
  const unique = Array.from(new Set(ids));
  if (!schedProjCache || Date.now() - schedProjCache.ts > SCHED_PROJ_TTL) {
    const map = new Map<string, { name: string; jobId: string }>();
    try {
      let cursor: string | undefined;
      do {
        const res: any = await notion.databases.query({
          database_id: PROJECTS_DB_ID,
          start_cursor: cursor,
          page_size: 100,
        });
        for (const pg of res.results) {
          const props = pg.properties || {};
          const name = (props[PROJECT_PROPS.name]?.title || [])
            .map((t: any) => t.plain_text).join("") || "";
          const jobId = (props[PROJECT_PROPS.jobId]?.rich_text || [])
            .map((t: any) => t.plain_text).join("") || "";
          if (name) map.set(pg.id, { name, jobId });
        }
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);
      schedProjCache = { map, ts: Date.now() };
    } catch { /* fall through */ }
  }
  const all = schedProjCache?.map || new Map();
  const out = new Map<string, { name: string; jobId: string }>();
  for (const id of unique) {
    const hit = all.get(id);
    if (hit) { out.set(id, hit); continue; }
    // Rare: brand-new project inside the TTL window — fetch just that one.
    try {
      const pg: any = await notion.pages.retrieve({ page_id: id });
      const props = pg.properties || {};
      const name = (props[PROJECT_PROPS.name]?.title || [])
        .map((t: any) => t.plain_text).join("") || "";
      const jobId = (props[PROJECT_PROPS.jobId]?.rich_text || [])
        .map((t: any) => t.plain_text).join("") || "";
      out.set(id, { name: name || "(unknown job)", jobId });
      if (name) schedProjCache?.map.set(id, { name, jobId });
    } catch {
      out.set(id, { name: "(unknown job)", jobId: "" });
    }
  }
  return out;
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
  const before = req.nextUrl.searchParams.get("before")?.trim(); // review mode: most recent day <= this
  const after = req.nextUrl.searchParams.get("after")?.trim(); // review mode: earliest day >= this
  const exportRange = req.nextUrl.searchParams.get("export")?.trim(); // "day" | "week"

  // On-demand PDF export of the schedule WITH actuals (who showed, who walked
  // on). Returns base64 so the client can download it. "week" covers Mon–Sun
  // of the week containing `date`, one page-set per day that has a schedule.
  if (exportRange && date) {
    try {
      const dates: string[] = [];
      if (exportRange === "week") {
        const d = new Date(date + "T00:00:00Z");
        const dow = d.getUTCDay();               // 0=Sun
        const monOffset = dow === 0 ? -6 : 1 - dow;
        const mon = new Date(d.getTime() + monOffset * 86400000);
        for (let i = 0; i < 7; i++) {
          dates.push(new Date(mon.getTime() + i * 86400000).toISOString().slice(0, 10));
        }
      } else {
        dates.push(date);
      }

      const { PDFDocument } = await import("pdf-lib");
      const merged = await PDFDocument.create();
      let included = 0;
      for (const dt of dates) {
        const data = await loadScheduleForDate(notion, dt);
        if (!data.jobs.length) continue; // skip days with no schedule
        const bytes = await buildSchedulePdf(data);
        const doc = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
        included++;
      }
      if (!included) {
        return NextResponse.json({ ok: false, error: "No schedule found for that range." }, { status: 404 });
      }
      const out = await merged.save();
      const name =
        exportRange === "week"
          ? `Ammex_Schedule_Week_${dates[0]}_to_${dates[6]}.pdf`
          : `Ammex_Schedule_${date}.pdf`;
      return NextResponse.json({
        ok: true,
        filename: name,
        pdf: Buffer.from(out).toString("base64"),
        days: included,
      });
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err?.message || "Export failed" }, { status: 502 });
    }
  }

  try {
    let targetDate = date || "";

    if (recent === "1" && !date) {
      // Find the most recent date that has any schedule rows.
      // With ?before=<ISO> (review mode), only look at days on or before it —
      // "open to today; if empty, walk back to the last day with a schedule."
      // With ?after=<ISO>, find the earliest scheduled day on or after it (Next ›).
      const r: any = await notion.databases.query({
        database_id: SCHEDULE_DB_ID,
        ...(before
          ? { filter: { property: SCHEDULE_PROPS.date, date: { on_or_before: before } } }
          : after
          ? { filter: { property: SCHEDULE_PROPS.date, date: { on_or_after: after } } }
          : {}),
        sorts: [{ property: SCHEDULE_PROPS.date, direction: after ? "ascending" : "descending" }],
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

    // Overlay what ACTUALLY happened — ONLY when explicitly requested
    // (?actuals=1, used by the read-only past-schedules view). The planning
    // editor never asks for it, so walk-ons can't reach a view that saves.
    const jobs = Array.from(byJob.values());
    const wantActuals = req.nextUrl.searchParams.get("actuals") === "1";
    const actuals = wantActuals
      ? await actualsForDate(notion, targetDate)
      : new Map<string, Map<string, { worker: string; hours: number }>>();
    for (const jg of jobs) {
      const worked = actuals.get(jg.jobPageId);
      if (!worked) continue;
      const scheduledKeys = new Set(jg.crew.map((c: any) => c.worker.toLowerCase()));
      for (const c of jg.crew as any[]) {
        const hit = worked.get(c.worker.toLowerCase());
        if (hit) c.hours = hit.hours; // showed up
      }
      for (const [k, v] of worked) {
        if (!scheduledKeys.has(k)) {
          (jg.crew as any[]).push({ worker: v.worker, isLead: false, hours: v.hours, unscheduled: true });
        }
      }
    }

    return NextResponse.json({ date: targetDate, jobs });
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
