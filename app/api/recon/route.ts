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
  underReview: boolean;
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
    underReview: !!p[TIMECARD_PROPS.underReview]?.checkbox,
  };
}

// Project id→name map. One Projects-DB query instead of a page-retrieve per id,
// cached in module memory for a short TTL (warm serverless invocations reuse it).
let projectNameCache: { map: Map<string, string>; ts: number } | null = null;
const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000;

async function getProjectNameMap(): Promise<Map<string, string>> {
  if (projectNameCache && Date.now() - projectNameCache.ts < PROJECT_CACHE_TTL_MS) {
    return projectNameCache.map;
  }
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
    projectNameCache = { map, ts: Date.now() };
  } catch { /* fall through with whatever we got */ }
  return map;
}

async function resolveProjectNames(ids: string[]): Promise<Map<string, string>> {
  const all = await getProjectNameMap();
  const map = new Map<string, string>();
  const missing: string[] = [];
  for (const id of Array.from(new Set(ids))) {
    const nm = all.get(id);
    if (nm) map.set(id, nm);
    else missing.push(id);
  }
  // Rare: a brand-new project created within the cache TTL — fetch just those.
  for (const id of missing) {
    try {
      const pg: any = await notion.pages.retrieve({ page_id: id });
      const nm = (pg.properties?.[PROJECT_PROPS.name]?.title || [])
        .map((t: any) => t.plain_text).join("").trim();
      if (nm) {
        map.set(id, nm);
        projectNameCache?.map.set(id, nm);
      }
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

// Roster rows a foreman created that the owner hasn't confirmed yet
// Missing cards the owner has manually closed (logged with kind "Missing card").
// Keyed by jobId|date so a closed card stays closed for that job+day.
async function closedMissingKeys(startISO: string, endISO: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: RECON_LOG_DB_ID,
        filter: {
          and: [
            { property: RECON_PROPS.kind, select: { equals: "Missing card" } },
            { property: RECON_PROPS.date, date: { on_or_after: startISO } },
            { property: RECON_PROPS.date, date: { on_or_before: endISO } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const p = pg.properties || {};
        // Refs holds "jobId|date"
        const refs = (p[RECON_PROPS.refs]?.rich_text || []).map((t: any) => t.plain_text).join("").trim();
        if (refs) out.add(refs);
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch { /* non-critical */ }
  return out;
}

// (Status = "Unconfirmed"). Surfaced in Reconcile with a confirm/reject action.
async function queryUnconfirmed(): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  try {
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: CREW_ROSTER_DB_ID,
        filter: {
          property: ROSTER_PROPS.status,
          rich_text: { equals: "Unconfirmed" },
        },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const name = (pg.properties?.[ROSTER_PROPS.name]?.title || [])
          .map((t: any) => t.plain_text).join("").trim();
        if (name) out.push({ id: pg.id, name });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch { /* non-critical */ }
  return out;
}

// Compute schedule-vs-actual discrepancies.
async function reconcile(startISO: string, endISO: string, todayISO: string) {
  const [sched, cards, unconfirmedWorkers, closedMissing] = await Promise.all([
    querySchedule(startISO, endISO),
    queryEntries(startISO, endISO),
    queryUnconfirmed(),
    closedMissingKeys(startISO, endISO),
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
  const loggedWorkerAnyDate = new Set<string>(); // `${worker}|${date}` (any job)
  const loggedJobByWorkerDate = new Map<string, string>(); // `${worker}|${date}` → job name logged
  for (const c of live) {
    loggedWorkerAnyDate.add(`${c.worker.toLowerCase()}|${c.date}`);
    const wd = `${c.worker.toLowerCase()}|${c.date}`;
    if (!loggedJobByWorkerDate.has(wd)) loggedJobByWorkerDate.set(wd, c.projectName || c.job || "");
    if (c.projectId) {
      loggedOnJobDate.add(`${c.projectId}|${c.date}`);
      loggedWorkerOnJobDate.add(`${c.worker.toLowerCase()}|${c.projectId}|${c.date}`);
    }
  }

  // crew context per job+date: total scheduled, and how many logged ON that job.
  // Also collect the scheduled crew names + who's still missing (for the popup).
  const crewByJobDate = new Map<
    string,
    { total: number; logged: number; elsewhere: number; foreman: string; jobName: string; date: string; jobId: string;
      crew: { worker: string; logged: boolean; elsewhereJob: string }[] }
  >();
  for (const s of sched) {
    const jk = `${s.jobId}|${s.date}`;
    if (!crewByJobDate.has(jk)) {
      crewByJobDate.set(jk, {
        total: 0, logged: 0, elsewhere: 0,
        foreman: leadByJobDate.get(jk) || "",
        jobName: s.jobName, date: s.date, jobId: s.jobId, crew: [],
      });
    }
    const rec = crewByJobDate.get(jk)!;
    const didLog = loggedWorkerOnJobDate.has(`${s.worker.toLowerCase()}|${s.jobId}|${s.date}`);
    const loggedAnywhere = loggedWorkerAnyDate.has(`${s.worker.toLowerCase()}|${s.date}`);
    rec.total += 1;
    if (didLog) rec.logged += 1;
    else if (loggedAnywhere) rec.elsewhere += 1; // logged, but on another job
    const elsewhereJob = !didLog && loggedAnywhere
      ? loggedJobByWorkerDate.get(`${s.worker.toLowerCase()}|${s.date}`) || ""
      : "";
    rec.crew.push({ worker: s.worker, logged: didLog, elsewhereJob });
    if (s.jobName && !rec.jobName) rec.jobName = s.jobName;
  }

  // Missing cards. Judged PER LEAD FOREMAN: a card is missing if the scheduled
  // lead foreman himself hasn't logged that job+date — so a second foreman
  // submitting his own crew no longer hides the lead's un-submitted card.
  // Fallback: if a job+date has NO marked lead, keep the old rule (missing if
  // nobody logged it) so nothing that flags today silently stops flagging.
  const missingCards: { foreman: string; jobName: string; date: string; jobId: string; crewCount: number }[] = [];
  for (const [jk, rec] of crewByJobDate) {
    if (daysAgo(rec.date, todayISO) < 0) continue; // future
    const lead = leadByJobDate.get(jk); // scheduled lead foreman for this job+date
    let isMissing: boolean;
    if (lead) {
      // missing if the LEAD hasn't logged this exact job+date
      isMissing = !loggedWorkerOnJobDate.has(`${lead.toLowerCase()}|${rec.jobId}|${rec.date}`);
    } else {
      // no marked lead → old behavior: missing if nobody logged this job+date
      isMissing = !loggedOnJobDate.has(jk);
    }
    if (isMissing && !closedMissing.has(`${rec.jobId}|${rec.date}`)) {
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
    crewElsewhere: number;
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
      const crew = crewByJobDate.get(`${s.jobId}|${s.date}`) || { total: 0, logged: 0, elsewhere: 0 };
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
        crewElsewhere: crew.elsewhere,
      });
      continue;
    }
    // logged something — check job & foreman against schedule
    const schedJobIds = new Set(rows.map((r) => r.jobId));
    for (const tc of tcs) {
      // Lead of the job he was SCHEDULED on (for the "scheduled for" line).
      const scheduledJobLead = leadByJobDate.get(`${s.jobId}|${s.date}`) || "";
      if (tc.projectId && !schedJobIds.has(tc.projectId)) {
        // different job (only when the timecard has a real project).
        // "Scheduled for" must show the SCHEDULED job's lead — never the lead
        // of the job he wandered to (that lead is unrelated to his schedule).
        discs.push({
          kind: "Different job",
          severity: "glance",
          worker: tc.worker,
          date: tc.date,
          scheduledJob: rows.map((r) => r.jobName).filter(Boolean).join(", ") || "(job)",
          scheduledJobId: s.jobId,
          scheduledForeman: scheduledJobLead,
          loggedJob: tc.projectName || tc.job,
          loggedForeman: tc.foreman,
          hours: tc.hours,
          crewLogged: 0,
          crewTotal: 0,
          crewElsewhere: 0,
        });
      } else {
        // same job (or unverifiable) — check foreman. Here the logged job IS
        // the scheduled job, so the scheduled job's lead is the right comparison.
        const scheduledForeman = scheduledJobLead;
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
            crewElsewhere: 0,
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
        crewElsewhere: 0,
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
  const crews: Record<string, { worker: string; logged: boolean; elsewhereJob: string }[]> = {};
  for (const [jk, rec] of crewByJobDate) {
    crews[jk] = rec.crew.slice().sort((a, b) => a.worker.localeCompare(b.worker));
  }

  return { discrepancies: open, missingCards, crews, unconfirmedWorkers };
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

    if (action === "cards") {
      // Card browser: all crew cards for the range — submitted (grouped by
      // job+foreman+date) and missing (whole crew blank). Read-only.
      const s = url.searchParams.get("start") || "";
      const e2 = url.searchParams.get("end") || s;
      const today = url.searchParams.get("today") || s;
      if (!s) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });
      const [result, all] = await Promise.all([
        reconcile(s, e2, today), // gives missingCards
        queryEntries(s, e2),
      ]);
      const live = all.filter((e) => !e.voided && !e.underReview);
      // group submitted entries by project+foreman+date
      const map = new Map<
        string,
        { job: string; projectId: string; foreman: string; date: string; entries: any[] }
      >();
      for (const e of live) {
        const key = `${e.projectId || e.job}|${e.foreman}|${e.date}`;
        if (!map.has(key)) {
          map.set(key, {
            job: e.projectName || e.job || "(no job)",
            projectId: e.projectId || "",
            foreman: e.foreman || "",
            date: e.date,
            entries: [],
          });
        }
        map.get(key)!.entries.push({
          id: e.id, worker: e.worker, hours: e.hours, job: e.job,
          projectName: e.projectName, projectId: e.projectId, foreman: e.foreman, date: e.date,
          underReview: e.underReview,
        });
      }
      const submitted = Array.from(map.values()).sort(
        (a, b) => b.date.localeCompare(a.date) || a.job.localeCompare(b.job)
      );
      return NextResponse.json({ ok: true, submitted, missing: result.missingCards });
    }

    if (action === "held_cards") {
      // All entries currently Under Review, grouped by card (job+foreman+date).
      const s = url.searchParams.get("start") || "";
      const e2 = url.searchParams.get("end") || s;
      if (!s) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });
      const all = await queryEntries(s, e2);
      const held = all.filter((e) => e.underReview && !e.voided);
      const map = new Map<
        string,
        { job: string; projectId: string; foreman: string; date: string; entries: any[] }
      >();
      for (const e of held) {
        const key = `${e.projectId || e.job}|${e.foreman}|${e.date}`;
        if (!map.has(key)) {
          map.set(key, {
            job: e.projectName || e.job || "(no job)",
            projectId: e.projectId || "",
            foreman: e.foreman || "",
            date: e.date,
            entries: [],
          });
        }
        map.get(key)!.entries.push({
          id: e.id, worker: e.worker, hours: e.hours, job: e.job,
          projectName: e.projectName, projectId: e.projectId, foreman: e.foreman, date: e.date,
          underReview: true,
        });
      }
      const cards = Array.from(map.values()).sort(
        (a, b) => b.date.localeCompare(a.date) || a.job.localeCompare(b.job)
      );
      const totalHeld = held.length;
      const totalHours = held.reduce((sum, e) => sum + (e.hours || 0), 0);
      return NextResponse.json({ ok: true, cards, totalHeld, totalHours });
    }

    if (action === "all_flags") {
      // Every worker with an open data-sanity flag in the range (for the Lookup
      // flags overview). Returns per-worker flag summary + confirmed keys.
      const s = url.searchParams.get("start") || "";
      const e2 = url.searchParams.get("end") || s;
      if (!s) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });
      const [all, confirmed] = await Promise.all([queryEntries(s, e2), confirmedReviews(s, e2)]);
      const flags = computeFlags(all.filter((e) => !e.underReview && !e.voided));
      // build per (worker|date) flag groups, excluding fully-confirmed ones
      const byWorker = new Map<
        string,
        { worker: string; date: string; flags: string[]; job: string }[]
      >();
      for (const e of all) {
        const efl = flags[e.id];
        if (!efl || !efl.length) continue;
        const key = e.worker;
        if (!byWorker.has(key)) byWorker.set(key, []);
        // dedupe by worker+date (a person+day shows once with its flag set)
        const list = byWorker.get(key)!;
        const existing = list.find((x) => x.date === e.date);
        const label = e.projectName || e.job;
        if (existing) {
          for (const f of efl) if (!existing.flags.includes(f)) existing.flags.push(f);
        } else {
          list.push({ worker: e.worker, date: e.date, flags: [...efl], job: label });
        }
      }
      const workers = Array.from(byWorker.entries())
        .map(([worker, days]) => ({ worker, days }))
        .sort((a, b) => a.worker.localeCompare(b.worker));
      return NextResponse.json({ ok: true, workers, confirmed });
    }

    if (action === "needs_project") {
      // Non-voided timecards in range missing a Project Helper — for bulk fix.
      const s = url.searchParams.get("start") || "";
      const e2 = url.searchParams.get("end") || s;
      if (!s) return NextResponse.json({ ok: false, error: "start date required" }, { status: 400 });
      const all = await queryEntries(s, e2);
      const missing = all.filter((x) => !x.voided && !x.underReview && !x.projectId);
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

    const [entries, confirmed] = await Promise.all([
      queryEntries(start, end, worker),
      confirmedReviews(start, end),
    ]);
    const flags = computeFlags(entries.filter((e) => !e.underReview && !e.voided));
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
      const { id, hours, job, foreman, projectId, date } = body;
      const props: any = {};
      if (typeof hours === "number") props[TIMECARD_PROPS.hours] = { number: hours };
      if (typeof job === "string") props[TIMECARD_PROPS.job] = { rich_text: [{ text: { content: job } }] };
      if (typeof foreman === "string") props[TIMECARD_PROPS.foreman] = { rich_text: [{ text: { content: foreman } }] };
      if (typeof projectId === "string")
        props[TIMECARD_PROPS.projectHelper] = { relation: projectId ? [{ id: projectId }] : [] };
      if (typeof date === "string" && date) props[TIMECARD_PROPS.date] = { date: { start: date } };
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

    if (op === "bulk_edit") {
      // Set date and/or project on many entries at once (card-level fix).
      const { ids, date, projectId, logLabel, logDate, priorDate, projectName } = body;
      if (!Array.isArray(ids) || ids.length === 0)
        return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });
      const props: any = {};
      if (typeof date === "string" && date) props[TIMECARD_PROPS.date] = { date: { start: date } };
      if (typeof projectId === "string")
        props[TIMECARD_PROPS.projectHelper] = { relation: projectId ? [{ id: projectId }] : [] };
      let done = 0;
      const failed: string[] = [];
      for (const id of ids) {
        try {
          await notion.pages.update({ page_id: id, properties: props });
          done++;
        } catch {
          failed.push(id);
        }
      }
      // One summary log record for the whole card.
      try {
        const parts: string[] = [];
        if (typeof date === "string" && date) parts.push(`Date ${priorDate || "?"} → ${date}`);
        if (projectId) parts.push(`Project → ${projectName || "(set)"}`);
        if (parts.length) {
          const desc = `Bulk: ${parts.join(", ")} · ${done} ${done === 1 ? "entry" : "entries"}`;
          await notion.pages.create({
            parent: { database_id: RECON_LOG_DB_ID },
            properties: {
              [RECON_PROPS.worker]: { title: [{ text: { content: logLabel || "Card edit" } }] },
              [RECON_PROPS.status]: { select: { name: "Fixed" } },
              [RECON_PROPS.note]: { rich_text: [{ text: { content: desc } }] },
              ...(logDate || date ? { [RECON_PROPS.date]: { date: { start: logDate || date } } } : {}),
              [RECON_PROPS.refs]: { rich_text: [{ text: { content: ids.join(",") } }] },
            },
          });
        }
      } catch { /* logging shouldn't block the edit */ }
      return NextResponse.json({ ok: true, done, failed: failed.length });
    }

    if (op === "split") {
      // Split one timecard into two jobs. Updates the original (hours + optional
      // project), creates a new entry for the remainder, logs both.
      const {
        id,
        origHours,
        origProjectId,
        origProjectName,
        newHours,
        newProjectId,
        newProjectName,
        worker,
        date,
        foreman,
        job,
      } = body;

      // 1) update original hours (+ project if changed)
      const origProps: any = { [TIMECARD_PROPS.hours]: { number: origHours } };
      if (typeof origProjectId === "string")
        origProps[TIMECARD_PROPS.projectHelper] = { relation: origProjectId ? [{ id: origProjectId }] : [] };
      await notion.pages.update({ page_id: id, properties: origProps });

      // 2) create the new entry for the remainder
      const newProps: any = {
        [TIMECARD_PROPS.worker]: { title: [{ text: { content: worker } }] },
        [TIMECARD_PROPS.date]: { date: { start: date } },
        [TIMECARD_PROPS.hours]: { number: newHours },
      };
      if (foreman) newProps[TIMECARD_PROPS.foreman] = { rich_text: [{ text: { content: foreman } }] };
      if (job) newProps[TIMECARD_PROPS.job] = { rich_text: [{ text: { content: job } }] };
      if (newProjectId) newProps[TIMECARD_PROPS.projectHelper] = { relation: [{ id: newProjectId }] };
      const created = await notion.pages.create({
        parent: { database_id: TIMECARDS_DB_ID },
        properties: newProps,
      });

      // 3) log the split
      try {
        const desc = `Split ${origHours + newHours}h → ${origHours}h ${origProjectName || "job"} + ${newHours}h ${newProjectName || "job"}`;
        await notion.pages.create({
          parent: { database_id: RECON_LOG_DB_ID },
          properties: {
            [RECON_PROPS.worker]: { title: [{ text: { content: worker } }] },
            [RECON_PROPS.status]: { select: { name: "Fixed" } },
            [RECON_PROPS.note]: { rich_text: [{ text: { content: desc } }] },
            [RECON_PROPS.refs]: { rich_text: [{ text: { content: `${id},${(created as any).id}` } }] },
            ...(date ? { [RECON_PROPS.date]: { date: { start: date } } } : {}),
          },
        });
      } catch { /* logging shouldn't block the split */ }

      return NextResponse.json({ ok: true, id: (created as any).id });
    }

    if (op === "undo_split") {
      // Reverse a split: restore the original's hours/project, void the new entry.
      const { origId, origPriorHours, origPriorProjectId, newId, logWorker, logDate } = body;
      const origProps: any = { [TIMECARD_PROPS.hours]: { number: origPriorHours } };
      origProps[TIMECARD_PROPS.projectHelper] = {
        relation: origPriorProjectId ? [{ id: origPriorProjectId }] : [],
      };
      await notion.pages.update({ page_id: origId, properties: origProps });
      if (newId) {
        await notion.pages.update({
          page_id: newId,
          properties: { [TIMECARD_PROPS.voided]: { checkbox: true },
            [TIMECARD_PROPS.voidNote]: { rich_text: [{ text: { content: "split undone" } }] } },
        });
      }
      if (logWorker) {
        try {
          await notion.pages.create({
            parent: { database_id: RECON_LOG_DB_ID },
            properties: {
              [RECON_PROPS.worker]: { title: [{ text: { content: logWorker } }] },
              [RECON_PROPS.status]: { select: { name: "Fixed" } },
              [RECON_PROPS.note]: { rich_text: [{ text: { content: "Split undone — restored original, voided the new entry" } }] },
              [RECON_PROPS.refs]: { rich_text: [{ text: { content: `${origId}${newId ? "," + newId : ""}` } }] },
              ...(logDate ? { [RECON_PROPS.date]: { date: { start: logDate } } } : {}),
            },
          });
        } catch { /* logging shouldn't block the undo */ }
      }
      return NextResponse.json({ ok: true });
    }

    if (op === "close_missing") {
      // Owner closes a missing card (e.g. covered by another foreman). Logs a
      // "Missing card" record keyed by jobId|date so it stays closed.
      const { jobId, date, jobName, foreman, note } = body;
      if (!jobId || !date)
        return NextResponse.json({ ok: false, error: "jobId and date required" }, { status: 400 });
      await notion.pages.create({
        parent: { database_id: RECON_LOG_DB_ID },
        properties: {
          [RECON_PROPS.worker]: {
            title: [{ text: { content: `${jobName || "Job"}${foreman ? ` · ${foreman}` : ""}` } }],
          },
          [RECON_PROPS.kind]: { select: { name: "Missing card" } },
          [RECON_PROPS.status]: { select: { name: "Dismissed" } },
          [RECON_PROPS.date]: { date: { start: date } },
          [RECON_PROPS.refs]: { rich_text: [{ text: { content: `${jobId}|${date}` } }] },
          [RECON_PROPS.note]: {
            rich_text: [{ text: { content: note ? `Closed — ${note}` : "Closed missing card" } }],
          },
        },
      });
      return NextResponse.json({ ok: true });
    }

    if (op === "confirm_worker") {
      // Owner confirms a foreman-added worker: Active checked, Status cleared.
      const { rosterId, worker } = body;
      if (!rosterId) return NextResponse.json({ ok: false, error: "rosterId required" }, { status: 400 });
      await notion.pages.update({
        page_id: rosterId,
        properties: {
          [ROSTER_PROPS.active]: { checkbox: true },
          [ROSTER_PROPS.status]: { rich_text: [] },
        },
      });
      try {
        await notion.pages.create({
          parent: { database_id: RECON_LOG_DB_ID },
          properties: {
            [RECON_PROPS.worker]: { title: [{ text: { content: worker || "Worker" } }] },
            [RECON_PROPS.status]: { select: { name: "Fixed" } },
            [RECON_PROPS.note]: { rich_text: [{ text: { content: "Confirmed new worker (foreman-added)" } }] },
          },
        });
      } catch { /* logging shouldn't block */ }
      return NextResponse.json({ ok: true });
    }

    if (op === "reject_worker") {
      // Owner rejects a foreman-added worker: archive the roster row.
      // Their submitted timecards stay untouched (void separately if needed).
      const { rosterId, worker } = body;
      if (!rosterId) return NextResponse.json({ ok: false, error: "rosterId required" }, { status: 400 });
      await notion.pages.update({ page_id: rosterId, archived: true });
      try {
        await notion.pages.create({
          parent: { database_id: RECON_LOG_DB_ID },
          properties: {
            [RECON_PROPS.worker]: { title: [{ text: { content: worker || "Worker" } }] },
            [RECON_PROPS.status]: { select: { name: "Dismissed" } },
            [RECON_PROPS.note]: { rich_text: [{ text: { content: "Rejected foreman-added worker (roster row archived; timecards untouched)" } }] },
          },
        });
      } catch { /* logging shouldn't block */ }
      return NextResponse.json({ ok: true });
    }

    if (op === "hold") {
      // Set or clear the Under Review hold on one or many entries. Held entries
      // are excluded from all counted totals (reports/payroll/burn).
      const { ids, held, logWorker, logDate, note } = body;
      const list: string[] = Array.isArray(ids) ? ids : ids ? [ids] : [];
      if (list.length === 0)
        return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });
      let done = 0;
      for (const id of list) {
        try {
          await notion.pages.update({
            page_id: id,
            properties: { [TIMECARD_PROPS.underReview]: { checkbox: !!held } },
          });
          done++;
        } catch { /* skip */ }
      }
      // Audit trail. On HOLD: create a "Held for review" row (Status "Under Review").
      // On RELEASE: update the original hold row(s) in place → Status "Fixed",
      // so the log reflects final state instead of leaving stale "Under Review" rows.
      if (logWorker && held) {
        try {
          const desc = `Held for review${note ? ` — ${note}` : ""}${list.length > 1 ? ` · ${done} entries` : ""}`;
          await notion.pages.create({
            parent: { database_id: RECON_LOG_DB_ID },
            properties: {
              [RECON_PROPS.worker]: { title: [{ text: { content: logWorker } }] },
              [RECON_PROPS.status]: { select: { name: "Under Review" } },
              [RECON_PROPS.note]: { rich_text: [{ text: { content: desc } }] },
              [RECON_PROPS.refs]: { rich_text: [{ text: { content: list.join(",") } }] },
              ...(logDate ? { [RECON_PROPS.date]: { date: { start: logDate } } } : {}),
            },
          });
        } catch { /* logging shouldn't block */ }
      } else if (!held) {
        // Release: flip the matching still-open hold row(s) to Fixed in place.
        try {
          const res: any = await notion.databases.query({
            database_id: RECON_LOG_DB_ID,
            filter: {
              property: RECON_PROPS.status,
              select: { equals: "Under Review" },
            },
            page_size: 100,
          });
          const idSet = new Set(list);
          for (const row of res.results) {
            const refsText = (row.properties?.[RECON_PROPS.refs]?.rich_text || [])
              .map((t: any) => t.plain_text).join("");
            const rowIds = refsText.split(",").map((s: string) => s.trim()).filter(Boolean);
            // match if this hold row references any of the released timecard ids
            if (rowIds.some((rid: string) => idSet.has(rid))) {
              const prevNote = (row.properties?.[RECON_PROPS.note]?.rich_text || [])
                .map((t: any) => t.plain_text).join("");
              await notion.pages.update({
                page_id: row.id,
                properties: {
                  [RECON_PROPS.status]: { select: { name: "Fixed" } },
                  [RECON_PROPS.note]: {
                    rich_text: [{ text: { content: `${prevNote} · released`.trim() } }],
                  },
                },
              });
            }
          }
        } catch { /* audit update shouldn't block the release */ }
      }
      return NextResponse.json({ ok: true, done });
    }

    if (op === "void") {
      const { id, voided, note, logWorker, logDate } = body;
      const props: any = { [TIMECARD_PROPS.voided]: { checkbox: !!voided } };
      if (typeof note === "string")
        props[TIMECARD_PROPS.voidNote] = { rich_text: [{ text: { content: note } }] };
      await notion.pages.update({ page_id: id, properties: props });
      // Log the void (only when voiding, not un-voiding) for the audit trail.
      if (voided && logWorker) {
        try {
          const desc = note ? `Voided — ${note}` : "Voided timecard";
          await notion.pages.create({
            parent: { database_id: RECON_LOG_DB_ID },
            properties: {
              [RECON_PROPS.worker]: { title: [{ text: { content: logWorker } }] },
              [RECON_PROPS.status]: { select: { name: "Fixed" } },
              [RECON_PROPS.note]: { rich_text: [{ text: { content: desc } }] },
              [RECON_PROPS.refs]: { rich_text: [{ text: { content: id } }] },
              ...(logDate ? { [RECON_PROPS.date]: { date: { start: logDate } } } : {}),
            },
          });
        } catch { /* logging shouldn't block the void */ }
      }
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
      const created = await notion.pages.create({
        parent: { database_id: RECON_LOG_DB_ID },
        properties: props,
      });
      return NextResponse.json({ ok: true, id: (created as any).id });
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
