import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  TIMECARDS_DB_ID,
  TIMECARD_PROPS,
  CREW_ROSTER_DB_ID,
  ROSTER_PROPS,
  RECON_LOG_DB_ID,
  RECON_PROPS,
} from "@/lib/notion";

const notion = new Client({ auth: NOTION_TOKEN });

const rt = (p: any): string =>
  (p?.rich_text || p?.title || []).map((t: any) => t.plain_text).join("").trim();

type TCEntry = {
  id: string;
  worker: string;
  date: string;
  job: string;
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
    hours: typeof p[TIMECARD_PROPS.hours]?.number === "number" ? p[TIMECARD_PROPS.hours].number : 0,
    foreman: rt(p[TIMECARD_PROPS.foreman]),
    notes: rt(p[TIMECARD_PROPS.notes]),
    voided: !!p[TIMECARD_PROPS.voided]?.checkbox,
    voidNote: rt(p[TIMECARD_PROPS.voidNote]),
  };
}

// Query timecards in a date range, optionally filtered to one worker.
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
  return out;
}

// Compute simple per-entry flags (data-sanity, independent of the schedule).
// Cross-row flags (duplicate, multi-job) computed over the given set.
function computeFlags(entries: TCEntry[]) {
  const live = entries.filter((e) => !e.voided);
  const flags: Record<string, string[]> = {};
  const add = (id: string, f: string) => {
    (flags[id] = flags[id] || []).push(f);
  };
  // group by worker+date
  const byWD = new Map<string, TCEntry[]>();
  for (const e of live) {
    const k = `${e.worker.toLowerCase()}|${e.date}`;
    (byWD.get(k) || byWD.set(k, []).get(k)!).push(e);
  }
  for (const [, group] of byWD) {
    // duplicate: same worker+date+job more than once
    const byJob = new Map<string, TCEntry[]>();
    for (const e of group) {
      const jk = e.job.toLowerCase();
      (byJob.get(jk) || byJob.set(jk, []).get(jk)!).push(e);
    }
    for (const [, dupes] of byJob) {
      if (dupes.length > 1) dupes.forEach((e) => add(e.id, "duplicate"));
    }
    // multi-job: same worker+date on 2+ different jobs
    if (byJob.size > 1) group.forEach((e) => add(e.id, "multi_job"));
    // over hours: worker's day total > 11
    const dayTotal = group.reduce((s, e) => s + e.hours, 0);
    if (dayTotal > 11) group.forEach((e) => add(e.id, "over_hours"));
  }
  // single high: any single entry > 11
  for (const e of live) if (e.hours > 11) add(e.id, "single_high");
  return flags;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "roster") {
      // active worker names for the search dropdown
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

    // default: search entries
    const start = url.searchParams.get("start") || "";
    const end = url.searchParams.get("end") || start;
    const worker = url.searchParams.get("worker") || undefined;
    if (!start) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });

    const entries = await queryEntries(start, end, worker);
    const flags = computeFlags(entries);
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.worker.localeCompare(b.worker));
    return NextResponse.json({ ok: true, entries, flags });
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
      // Edit an existing timecard: hours / job / foreman (any subset).
      const { id, hours, job, foreman } = body;
      const props: any = {};
      if (typeof hours === "number") props[TIMECARD_PROPS.hours] = { number: hours };
      if (typeof job === "string") props[TIMECARD_PROPS.job] = { rich_text: [{ text: { content: job } }] };
      if (typeof foreman === "string") props[TIMECARD_PROPS.foreman] = { rich_text: [{ text: { content: foreman } }] };
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
    }

    if (op === "void") {
      // Void-not-delete: mark voided + note. Reversible.
      const { id, voided, note } = body;
      const props: any = { [TIMECARD_PROPS.voided]: { checkbox: !!voided } };
      if (typeof note === "string")
        props[TIMECARD_PROPS.voidNote] = { rich_text: [{ text: { content: note } }] };
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
    }

    if (op === "add") {
      // Add a missing timecard (deliberate — not auto-filled).
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

    if (op === "log") {
      // Write a reconciliation outcome record.
      const { worker, date, kind, status, note } = body;
      const props: any = {
        [RECON_PROPS.worker]: { title: [{ text: { content: worker } }] },
        [RECON_PROPS.kind]: { select: { name: kind } },
        [RECON_PROPS.status]: { select: { name: status } },
      };
      if (date) props[RECON_PROPS.date] = { date: { start: date } };
      if (note) props[RECON_PROPS.note] = { rich_text: [{ text: { content: note } }] };
      await notion.pages.create({
        parent: { database_id: RECON_LOG_DB_ID },
        properties: props,
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unknown op" }, { status: 400 });
  } catch (err: any) {
    console.error("recon POST failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 502 });
  }
}
