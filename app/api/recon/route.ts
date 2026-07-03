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
  SCHEDULE_DB_ID,
  SCHEDULE_PROPS,
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

// --- Schedule vs. actual reconciliation ---

type SchedRow = {
  worker: string;
  date: string;
  jobId: string;
  jobName: string;
  isLead: boolean;
};

async function querySchedule(startISO: string, endISO: string): Promise<SchedRow[]> {
  const out: SchedRow[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: SCHEDULE_DB_ID,
      filter: {
        and: [
          { property: SCHEDULE_PROPS.date, date: { on_or_after: startISO } },
          { property: SCHEDULE_PROPS.date, date: { on_or_before: endISO } },
        ],
      },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const pg of res.results) {
      const p = pg.properties || {};
      out.push({
        worker: rt(p[SCHEDULE_PROPS.worker]),
        date: p[SCHEDULE_PROPS.date]?.date?.start?.slice(0, 10) || "",
        jobId: relIds(p[SCHEDULE_PROPS.job])[0] || "",
        jobName: "",
        isLead: !!p[SCHEDULE_PROPS.isLead]?.checkbox,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  const nmeMap = await resolveProjectNames(out.map((s) => s.jobId).filter(Boolean));
  out.forEach((s) => { if (s.jobId) s.jobName = nmeMap.get(s.jobId) || ""; });
  return out;
}

function daysAgo(dateISO: string, todayISO: string): number {
  const a = Date.parse(dateISO + "T00:00:00Z");
  const b = Date.parse(todayISO + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

// Compute schedule-vs-actual discrepancies.
async function reconcile(startISO: string, endISO: string, todayISO: string) {
  const [sched, cards] = await Promise.all([
    querySchedule(startISO, endISO),
    queryEntries(startISO, endISO),
  ]);
  const live = cards.filter((c) => !c.voided);

  // scheduled foreman (lead) per job+date
  const leadByJobDate = new Map<string, string>();
  for (const s of sched) {
    if (s.isLead) leadByJobDate.set(`${s.jobId}|${s.date}`, s.worker);
  }

  // Did anyone log ON this specific job+date? (immune to a worker logging
  // elsewhere masking a foreman's un-submitted card.) Match on the timecard's
  // real project (projectId) = the scheduled jobId.
  const loggedOnJobDate = new Set<string>(); // `${jobId}|${date}`
  const loggedWorkerOnJobDate = new Set<string>(); // `${worker}|${jobId}|${date}`
  for (const c of live) {
    if (c.projectId) {
      loggedOnJobDate.add(`${c.projectId}|${c.date}`);
      loggedWorkerOnJobDate.add(`${c.worker.toLowerCase()}|${c.projectId}|${c.date}`);
    }
  }

  // crew context per job+date: total scheduled, and how many logged ON that job.
  // Also collect the scheduled crew names + who's still missing (for the popup).
  const crewByJobDate = new Map<
    string,
    { total: number; logged: number; foreman: string; jobName: string; date: string; jobId: string;
      crew: { worker: string; logged: boolean }[] }
  >();
  for (const s of sched) {
    const jk = `${s.jobId}|${s.date}`;
    if (!crewByJobDate.has(jk)) {
      crewByJobDate.set(jk, {
        total: 0, logged: 0,
        foreman: leadByJobDate.get(jk) || "",
        jobName: s.jobName, date: s.date, jobId: s.jobId, crew: [],
      });
    }
    const rec = crewByJobDate.get(jk)!;
    const didLog = loggedWorkerOnJobDate.has(`${s.worker.toLowerCase()}|${s.jobId}|${s.date}`);
    rec.total += 1;
    if (didLog) rec.logged += 1;
    rec.crew.push({ worker: s.worker, logged: didLog });
    if (s.jobName && !rec.jobName) rec.jobName = s.jobName;
  }

  // Missing cards: a foreman never submitted for a job+date (nobody logged on
  // that job that day), and it's a past/current date (not future).
  const missingCards: { foreman: string; jobName: string; date: string; jobId: string; crewCount: number }[] = [];
  for (const [jk, rec] of crewByJobDate) {
    if (daysAgo(rec.date, todayISO) < 0) continue; // future
    if (!loggedOnJobDate.has(jk)) {
      missingCards.push({
        foreman: rec.foreman,
        jobName: rec.jobName || "(job)",
        date: rec.date,
        jobId: rec.jobId,
        crewCount: rec.total,
      });
    }
  }
  missingCards.sort((a, b) => b.date.localeCompare(a.date)); // newest first


  // index timecards by worker+date
  const tcByWD = new Map<string, typeof live>();
  for (const c of live) {
    const k = `${c.worker.toLowerCase()}|${c.date}`;
    if (!tcByWD.has(k)) tcByWD.set(k, []);
    tcByWD.get(k)!.push(c);
  }
  // index schedule by worker+date
  const schedByWD = new Map<string, SchedRow[]>();
  for (const s of sched) {
    const k = `${s.worker.toLowerCase()}|${s.date}`;
    if (!schedByWD.has(k)) schedByWD.set(k, []);
    schedByWD.get(k)!.push(s);
  }

  type Disc = {
    kind: string; // No timecard / Different job / Not scheduled / Wrong foreman
    severity: "attention" | "pending" | "glance";
    worker: string;
    date: string;
    scheduledJob: string;
    scheduledJobId: string;
    scheduledForeman: string;
    loggedJob: string;
    loggedForeman: string;
    hours: number;
    crewLogged: number;
    crewTotal: number;
  };
  const discs: Disc[] = [];

  // 1 & 2 & 4: iterate schedule assignments
  const seenWD = new Set<string>();
  for (const [wd, rows] of schedByWD) {
    seenWD.add(wd);
    const s = rows[0]; // a worker on a date (use first scheduled job)
    const tcs = tcByWD.get(wd) || [];
    if (tcs.length === 0) {
      // scheduled but no timecard — skip future dates
      const ago = daysAgo(s.date, todayISO);
      if (ago < 0) continue;
      const scheduledForeman = leadByJobDate.get(`${s.jobId}|${s.date}`) || "";
      const crew = crewByJobDate.get(`${s.jobId}|${s.date}`) || { total: 0, logged: 0 };
      discs.push({
        kind: "No timecard",
        severity: ago >= 2 ? "attention" : "pending",
        worker: s.worker,
        date: s.date,
        scheduledJob: s.jobName || "(job)",
        scheduledJobId: s.jobId,
        scheduledForeman,
        loggedJob: "",
        loggedForeman: "",
        hours: 0,
        crewLogged: crew.logged,
        crewTotal: crew.total,
      });
      continue;
    }
    // logged something — check job & foreman against schedule
    const schedJobIds = new Set(rows.map((r) => r.jobId));
    for (const tc of tcs) {
      const scheduledForeman = leadByJobDate.get(`${tc.projectId}|${tc.date}`) ||
        leadByJobDate.get(`${s.jobId}|${s.date}`) || "";
      if (tc.projectId && !schedJobIds.has(tc.projectId)) {
        // different job (only when the timecard has a real project)
        discs.push({
          kind: "Different job",
          severity: "glance",
          worker: tc.worker,
          date: tc.date,
          scheduledJob: rows.map((r) => r.jobName).filter(Boolean).join(", ") || "(job)",
          scheduledJobId: s.jobId,
          scheduledForeman,
          loggedJob: tc.projectName || tc.job,
          loggedForeman: tc.foreman,
          hours: tc.hours,
          crewLogged: 0,
          crewTotal: 0,
        });
      } else {
        // same job (or unverifiable) — check foreman
        if (
          scheduledForeman &&
          tc.foreman &&
          scheduledForeman.toLowerCase() !== tc.foreman.toLowerCase()
        ) {
          discs.push({
            kind: "Wrong foreman",
            severity: "glance",
            worker: tc.worker,
            date: tc.date,
            scheduledJob: tc.projectName || tc.job || (s.jobName || "(job)"),
            scheduledJobId: s.jobId,
            scheduledForeman,
            loggedJob: tc.projectName || tc.job,
            loggedForeman: tc.foreman,
            hours: tc.hours,
            crewLogged: 0,
            crewTotal: 0,
          });
        }
      }
    }
  }

  // 3: logged but not scheduled
  for (const [wd, tcs] of tcByWD) {
    if (seenWD.has(wd)) continue;
    for (const tc of tcs) {
      discs.push({
        kind: "Not scheduled",
        severity: "glance",
        worker: tc.worker,
        date: tc.date,
        scheduledJob: "",
        scheduledJobId: "",
        scheduledForeman: "",
        loggedJob: tc.projectName || tc.job,
        loggedForeman: tc.foreman,
        hours: tc.hours,
        crewLogged: 0,
        crewTotal: 0,
      });
    }
  }

  // filter out resolved discrepancies (no-show / confirmed / fixed in the log)
  const resolved = new Set<string>();
  try {
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: RECON_LOG_DB_ID,
        filter: {
          and: [
            { property: RECON_PROPS.date, date: { on_or_after: startISO } },
            { property: RECON_PROPS.date, date: { on_or_before: endISO } },
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
        const st = p[RECON_PROPS.status]?.select?.name || "";
        if (w && d && k && st) resolved.add(`${w.toLowerCase()}|${d}|${k.toLowerCase()}`);
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch { /* ignore */ }

  const open = discs.filter(
    (x) => !resolved.has(`${x.worker.toLowerCase()}|${x.date}|${x.kind.toLowerCase()}`)
  );
  open.sort((a, b) => a.date.localeCompare(b.date) || a.worker.localeCompare(b.worker));

  // scheduled crew per job+date (for the "view crew" popup): who was scheduled
  // and whether each logged on that job.
  const crews: Record<string, { worker: string; logged: boolean }[]> = {};
  for (const [jk, rec] of crewByJobDate) {
    crews[jk] = rec.crew.slice().sort((a, b) => a.worker.localeCompare(b.worker));
  }

  return { discrepancies: open, missingCards, crews };
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

    if (action === "foremen") {
      // Active roster excluding Rodbusters — for the foreman picker.
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
          const role = rt(pg.properties?.[ROSTER_PROPS.role]);
          if (n && role.toLowerCase() !== "rodbuster") names.push(n);
        });
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);
      names.sort((a, b) => a.localeCompare(b));
      return NextResponse.json({ ok: true, foremen: names });
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

    if (action === "reconcile") {
      const s = url.searchParams.get("start") || "";
      const e2 = url.searchParams.get("end") || s;
      const today = url.searchParams.get("today") || s;
      if (!s) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });
      const result = await reconcile(s, e2, today);
      return NextResponse.json({ ok: true, ...result });
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

      // Always log the change (auto description + optional note) to the
      // Reconciliation Log — a durable activity trail. No name (sole admin).
      const { logWorker, logDate, changeDesc, note } = body;
      if (changeDesc && logWorker) {
        try {
          const full = note ? `${changeDesc} — ${note}` : changeDesc;
          const lp: any = {
            [RECON_PROPS.worker]: { title: [{ text: { content: logWorker } }] },
            [RECON_PROPS.status]: { select: { name: "Fixed" } },
            [RECON_PROPS.note]: { rich_text: [{ text: { content: full } }] },
            [RECON_PROPS.refs]: { rich_text: [{ text: { content: id } }] },
          };
          if (logDate) lp[RECON_PROPS.date] = { date: { start: logDate } };
          await notion.pages.create({ parent: { database_id: RECON_LOG_DB_ID }, properties: lp });
        } catch { /* logging failure shouldn't block the edit */ }
      }
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
      const { worker, date, job, hours, foreman, projectId } = body;
      const props: any = {
        [TIMECARD_PROPS.worker]: { title: [{ text: { content: worker } }] },
        [TIMECARD_PROPS.date]: { date: { start: date } },
        [TIMECARD_PROPS.hours]: { number: typeof hours === "number" ? hours : 0 },
      };
      if (job) props[TIMECARD_PROPS.job] = { rich_text: [{ text: { content: job } }] };
      if (foreman) props[TIMECARD_PROPS.foreman] = { rich_text: [{ text: { content: foreman } }] };
      if (projectId) props[TIMECARD_PROPS.projectHelper] = { relation: [{ id: projectId }] };
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
