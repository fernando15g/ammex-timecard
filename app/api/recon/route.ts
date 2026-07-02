import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  TIMECARDS_DB_ID,
  TIMECARD_PROPS,
  CREW_ROSTER_DB_ID,
  ROSTER_PROPS,
  PROJECTS_DB_ID,
  PROJECT_PROPS,
  RECON_LOG_DB_ID,
  RECON_PROPS,
} from "@/lib/notion";

export const dynamic = "force-dynamic";

const notion = new Client({ auth: NOTION_TOKEN });

const rt = (p: any): string =>
  (p?.rich_text || p?.title || []).map((t: any) => t.plain_text).join("").trim();
const relIds = (p: any): string[] =>
  (p?.relation || []).map((r: any) => r.id).filter(Boolean);

type TCEntry = {
  id: string;
  worker: string;
  date: string;
  job: string;
  projectName: string;
  projectId: string;
  hours: number;
  foreman: string;
  notes: string;
  voided: boolean;
  voidNote: string;
};

function mapRow(page: any): TCEntry {
  const p = page.properties || {};
  return {
    id: page.id,
    worker: rt(p[TIMECARD_PROPS.worker]),
    date: p[TIMECARD_PROPS.date]?.date?.start?.slice(0, 10) || "",
    job: rt(p[TIMECARD_PROPS.job]),
    projectName: "",
    projectId: relIds(p[TIMECARD_PROPS.projectHelper])[0] || "",
    hours: typeof p[TIMECARD_PROPS.hours]?.number === "number" ? p[TIMECARD_PROPS.hours].number : 0,
    foreman: rt(p[TIMECARD_PROPS.foreman]),
    notes: rt(p[TIMECARD_PROPS.notes]),
    voided: !!p[TIMECARD_PROPS.voided]?.checkbox,
    voidNote: rt(p[TIMECARD_PROPS.voidNote]),
  };
}

async function resolveProjectNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of Array.from(new Set(ids))) {
    try {
      const pg: any = await notion.pages.retrieve({ page_id: id });
      const nm = (pg.properties?.[PROJECT_PROPS.name]?.title || [])
        .map((t: any) => t.plain_text).join("").trim();
      if (nm) map.set(id, nm);
    } catch { /* ignore */ }
  }
  return map;
}

async function queryEntries(startISO: string, endISO: string, worker?: string): Promise<TCEntry[]> {
  const and: any[] = [
    { property: TIMECARD_PROPS.date, date: { on_or_after: startISO } },
    { property: TIMECARD_PROPS.date, date: { on_or_before: endISO } },
  ];
  if (worker) and.push({ property: TIMECARD_PROPS.worker, title: { equals: worker } });
  const out: TCEntry[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: TIMECARDS_DB_ID,
      filter: { and },
      start_cursor: cursor,
      page_size: 100,
    });
    res.results.forEach((r: any) => out.push(mapRow(r)));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  const nmeMap = await resolveProjectNames(out.map((e) => e.projectId).filter(Boolean));
  out.forEach((e) => { if (e.projectId) e.projectName = nmeMap.get(e.projectId) || ""; });
  return out;
}

function computeFlags(entries: TCEntry[]) {
  const live = entries.filter((e) => !e.voided);
  const flags: Record<string, string[]> = {};
  const add = (id: string, f: string) => { (flags[id] = flags[id] || []).push(f); };
  const byWD = new Map<string, TCEntry[]>();
  for (const e of live) {
    const k = `${e.worker.toLowerCase()}|${e.date}`;
    if (!byWD.has(k)) byWD.set(k, []);
    byWD.get(k)!.push(e);
  }
  for (const [, group] of byWD) {
    const byJob = new Map<string, TCEntry[]>();
    for (const e of group) {
      const jk = (e.projectName || e.job).toLowerCase();
      if (!byJob.has(jk)) byJob.set(jk, []);
      byJob.get(jk)!.push(e);
    }
    for (const [, dupes] of byJob) if (dupes.length > 1) dupes.forEach((e) => add(e.id, "duplicate"));
    if (byJob.size > 1) group.forEach((e) => add(e.id, "multi_job"));
    const dayTotal = group.reduce((s, e) => s + e.hours, 0);
    if (dayTotal > 11) group.forEach((e) => add(e.id, "over_hours"));
  }
  for (const e of live) if (e.hours > 11) add(e.id, "single_high");
  return flags;
}

async function confirmedReviews(startISO: string, endISO: string): Promise<
  { key: string; refs: string; pageId: string }[]
> {
  const out: { key: string; refs: string; pageId: string }[] = [];
  let cursor: string | undefined;
  try {
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
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const p = pg.properties || {};
        const w = (p[RECON_PROPS.worker]?.title || []).map((t: any) => t.plain_text).join("").trim();
        const d = p[RECON_PROPS.date]?.date?.start?.slice(0, 10) || "";
        const k = p[RECON_PROPS.kind]?.select?.name || "";
        const refs = rt(p[RECON_PROPS.refs]);
        if (w && d && k) out.push({ key: `${w.toLowerCase()}|${d}|${k.toLowerCase()}`, refs, pageId: pg.id });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch { /* log may be empty */ }
  return out;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "roster") {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const res: any = await notion.databases.query({
          database_id: CREW_ROSTER_DB_ID,
          filter: { property: ROSTER_PROPS.active, checkbox: { equals: true } },
          start_cursor: cursor,
          page_size: 100,
        });
        res.results.forEach((pg: any) => {
          const n = rt(pg.properties?.[ROSTER_PROPS.name]);
          if (n) names.push(n);
        });
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);
      names.sort((a, b) => a.localeCompare(b));
      return NextResponse.json({ ok: true, workers: names });
    }

    if (action === "projects") {
      const jobs: { id: string; name: string; jobId: string }[] = [];
      let cursor: string | undefined;
      do {
        const res: any = await notion.databases.query({
          database_id: PROJECTS_DB_ID,
          start_cursor: cursor,
          page_size: 100,
        });
        for (const pg of res.results) {
          const props = pg.properties || {};
          const name = (props[PROJECT_PROPS.name]?.title || []).map((t: any) => t.plain_text).join("").trim();
          const jobId = rt(props[PROJECT_PROPS.jobId]);
          if (name) jobs.push({ id: pg.id, name, jobId });
        }
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);
      jobs.sort((a, b) => (a.jobId || a.name).localeCompare(b.jobId || b.name, undefined, { numeric: true, sensitivity: "base" }));
      return NextResponse.json({ ok: true, projects: jobs });
    }

    if (action === "needs_project") {
      // Non-voided timecards in range missing a Project Helper — for bulk fix.
      const s = url.searchParams.get("start") || "";
      const e2 = url.searchParams.get("end") || s;
      if (!s) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });
      const all = await queryEntries(s, e2);
      const missing = all.filter((x) => !x.voided && !x.projectId);
      return NextResponse.json({ ok: true, entries: missing });
    }

    const start = url.searchParams.get("start") || "";
    const end = url.searchParams.get("end") || start;
    const worker = url.searchParams.get("worker") || undefined;
    if (!start) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });

    const entries = await queryEntries(start, end, worker);
    const flags = computeFlags(entries);
    const confirmed = await confirmedReviews(start, end);
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.worker.localeCompare(b.worker));
    return NextResponse.json({ ok: true, entries, flags, confirmed });
  } catch (err: any) {
    console.error("recon GET failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { op } = body;

    if (op === "edit") {
      const { id, hours, job, foreman, projectId } = body;
      const props: any = {};
      if (typeof hours === "number") props[TIMECARD_PROPS.hours] = { number: hours };
      if (typeof job === "string") props[TIMECARD_PROPS.job] = { rich_text: [{ text: { content: job } }] };
      if (typeof foreman === "string") props[TIMECARD_PROPS.foreman] = { rich_text: [{ text: { content: foreman } }] };
      if (typeof projectId === "string")
        props[TIMECARD_PROPS.projectHelper] = { relation: projectId ? [{ id: projectId }] : [] };
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
    }

    if (op === "void") {
      const { id, voided, note } = body;
      const props: any = { [TIMECARD_PROPS.voided]: { checkbox: !!voided } };
      if (typeof note === "string")
        props[TIMECARD_PROPS.voidNote] = { rich_text: [{ text: { content: note } }] };
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
    }

    if (op === "add") {
      const { worker, date, job, hours, foreman } = body;
      const props: any = {
        [TIMECARD_PROPS.worker]: { title: [{ text: { content: worker } }] },
        [TIMECARD_PROPS.date]: { date: { start: date } },
        [TIMECARD_PROPS.hours]: { number: typeof hours === "number" ? hours : 0 },
      };
      if (job) props[TIMECARD_PROPS.job] = { rich_text: [{ text: { content: job } }] };
      if (foreman) props[TIMECARD_PROPS.foreman] = { rich_text: [{ text: { content: foreman } }] };
      const created = await notion.pages.create({
        parent: { database_id: TIMECARDS_DB_ID },
        properties: props,
      });
      return NextResponse.json({ ok: true, id: (created as any).id });
    }

    if (op === "bulk_project") {
      // Set Project Helper on many timecards at once (bulk fix by job name).
      const { ids, projectId } = body;
      if (!Array.isArray(ids) || !projectId)
        return NextResponse.json({ ok: false, error: "ids and projectId required" }, { status: 400 });
      const done: string[] = [];
      const failed: string[] = [];
      for (const id of ids) {
        try {
          await notion.pages.update({
            page_id: id,
            properties: { [TIMECARD_PROPS.projectHelper]: { relation: [{ id: projectId }] } },
          });
          done.push(id);
        } catch {
          failed.push(id);
        }
      }
      return NextResponse.json({ ok: true, done: done.length, failed: failed.length });
    }

    if (op === "log") {
      const { worker, date, kind, status, note, refs } = body;
      const props: any = {
        [RECON_PROPS.worker]: { title: [{ text: { content: worker } }] },
        [RECON_PROPS.kind]: { select: { name: kind } },
        [RECON_PROPS.status]: { select: { name: status } },
      };
      if (date) props[RECON_PROPS.date] = { date: { start: date } };
      if (note) props[RECON_PROPS.note] = { rich_text: [{ text: { content: note } }] };
      if (refs) props[RECON_PROPS.refs] = { rich_text: [{ text: { content: refs } }] };
      await notion.pages.create({ parent: { database_id: RECON_LOG_DB_ID }, properties: props });
      return NextResponse.json({ ok: true });
    }

    if (op === "unlog") {
      // Undo a review — archive (soft-delete) the log record.
      const { pageId } = body;
      await notion.pages.update({ page_id: pageId, archived: true });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unknown op" }, { status: 400 });
  } catch (err: any) {
    console.error("recon POST failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 502 });
  }
}
