import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  SITE_VISIT_DB_ID,
  VISIT_PROPS,
  PROJECTS_DB_ID,
  PROJECT_PROPS,
} from "@/lib/notion";

const notion = new Client({ auth: NOTION_TOKEN });

function rt(prop: any): string {
  return (prop?.rich_text || prop?.title || []).map((t: any) => t.plain_text).join("").trim();
}

// One cached Projects id→name map (short TTL) so we can resolve the visit's job.
let projCache: { map: Map<string, string>; ts: number } | null = null;
async function projectMap(): Promise<Map<string, string>> {
  if (projCache && Date.now() - projCache.ts < 5 * 60 * 1000) return projCache.map;
  const map = new Map<string, string>();
  try {
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: PROJECTS_DB_ID,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const nm = (pg.properties?.[PROJECT_PROPS.name]?.title || [])
          .map((t: any) => t.plain_text).join("").trim();
        if (nm) map.set(pg.id, nm);
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    projCache = { map, ts: Date.now() };
  } catch { /* ignore */ }
  return map;
}

// GET ?action=projects  → job list for the picker
// GET (default) ?start&end → visits in range (or recent if no range)
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const action = url.searchParams.get("action");

  if (action === "projects") {
    const map = await projectMap();
    const projects = Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    // also grab jobId if available
    try {
      const res: any = await notion.databases.query({ database_id: PROJECTS_DB_ID, page_size: 100 });
      const withId = res.results.map((pg: any) => ({
        id: pg.id,
        name: (pg.properties?.[PROJECT_PROPS.name]?.title || []).map((t: any) => t.plain_text).join("").trim(),
        jobId: rt(pg.properties?.[PROJECT_PROPS.jobId]),
      })).filter((p: any) => p.name);
      if (withId.length) return NextResponse.json({ ok: true, projects: withId });
    } catch { /* fall back */ }
    return NextResponse.json({ ok: true, projects });
  }

  // list visits
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const filter: any = start && end
    ? {
        and: [
          { property: VISIT_PROPS.arrival, date: { on_or_after: start } },
          { property: VISIT_PROPS.arrival, date: { on_or_before: `${end}T23:59:59.999-07:00` } },
        ],
      }
    : undefined;
  const pmap = await projectMap();
  const visits: any[] = [];
  try {
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: SITE_VISIT_DB_ID,
        ...(filter ? { filter } : {}),
        sorts: [{ property: VISIT_PROPS.arrival, direction: "descending" }],
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const p = pg.properties || {};
        const jobId = (p[VISIT_PROPS.job]?.relation || [])[0]?.id || "";
        visits.push({
          id: pg.id,
          jobId,
          jobName: pmap.get(jobId) || rt(p[VISIT_PROPS.title]) || "(job)",
          arrival: p[VISIT_PROPS.arrival]?.date?.start || "",
          departure: p[VISIT_PROPS.departure]?.date?.start || "",
          notes: rt(p[VISIT_PROPS.notes]),
        });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "list failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, visits });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const op = body.op;

  try {
    if (op === "log") {
      const { jobId, jobName, arrival, departure, notes } = body;
      const props: any = {
        [VISIT_PROPS.title]: {
          title: [{ text: { content: `${jobName || "Visit"} — ${labelDate(arrival)}` } }],
        },
        [VISIT_PROPS.arrival]: { date: { start: arrival } },
      };
      if (jobId) props[VISIT_PROPS.job] = { relation: [{ id: jobId }] };
      if (departure) props[VISIT_PROPS.departure] = { date: { start: departure } };
      if (notes) props[VISIT_PROPS.notes] = { rich_text: [{ text: { content: notes } }] };
      const created = await notion.pages.create({
        parent: { database_id: SITE_VISIT_DB_ID },
        properties: props,
      });
      return NextResponse.json({ ok: true, id: (created as any).id });
    }

    if (op === "update") {
      const { id, arrival, departure, notes, clearDeparture } = body;
      const props: any = {};
      if (typeof arrival === "string" && arrival) props[VISIT_PROPS.arrival] = { date: { start: arrival } };
      if (clearDeparture) props[VISIT_PROPS.departure] = { date: null };
      else if (typeof departure === "string" && departure)
        props[VISIT_PROPS.departure] = { date: { start: departure } };
      if (typeof notes === "string") props[VISIT_PROPS.notes] = { rich_text: [{ text: { content: notes } }] };
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
    }

    if (op === "delete") {
      await notion.pages.update({ page_id: body.id, archived: true });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unknown op" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "write failed" }, { status: 500 });
  }
}

function labelDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return (iso || "").slice(0, 10);
  }
}
