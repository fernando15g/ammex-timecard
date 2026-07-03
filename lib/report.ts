// Builds the weekly payroll report data structure from raw Notion timecard
// rows. Pure data shaping — no file generation here (that's report-excel.ts
// and report-pdf.ts). Read-only with respect to Notion.

import {
  ReportLang,
  DAY_NAMES as DAY_NAMES_I18N,
  phraseOverHours,
  phraseDoubleEntry,
  phraseMultiJob,
  phraseSingleHigh,
  phraseOffRoster,
} from "./report-i18n";

export interface RawRow {
  worker: string;
  dateISO: string; // YYYY-MM-DD
  hours: number;
  jobText: string; // foreman's typed "Job"
  projectName: string; // clean "Project Helper" (may be empty)
  jobId: string; // clean "Job ID Helper" (may be empty)
  foreman: string; // who logged this card
}

export interface PersonRow {
  name: string;
  perDay: (number | null)[]; // 7 entries, Sun..Sat; null = didn't work
  total: number;
}

export interface JobSection {
  title: string; // project name, or cleaned job text for unassigned
  jobId: string; // "" if unassigned
  unassigned: boolean;
  people: PersonRow[];
  dailyTotals: number[]; // 7 entries
  grandTotal: number;
}

export interface Flag {
  worker: string;
  dateISO: string;
  kind: "over_hours" | "double_entry" | "multi_job" | "single_high" | "off_roster";
  detail: string;
  foremen?: string[]; // foremen whose entries are part of this flag
  jobs?: string[]; // job title(s) this flag actually involves (for row marking)
}

export interface WorkerJobLine {
  title: string;
  jobId: string;
  hours: number;
  firstDayIdx: number; // index into dayLabels (chronological)
  firstDayLabel: string; // e.g., "Mon 6/22"
}

export interface WorkerSummary {
  name: string;
  jobs: WorkerJobLine[]; // sorted by earliest day worked
  total: number;
}

export interface ReportData {
  weekStartISO: string; // Monday
  weekEndISO: string; // Saturday
  dayLabels: string[]; // ["Sun 6/22", ...]
  sections: JobSection[]; // assigned jobs first, then unassigned
  noHours: string[]; // active roster names with zero hours this week
  flags: Flag[];
  overHoursThreshold: number;
  lang: ReportLang;
  foremanReport: boolean; // true when filtered to a single foreman
  foremanName: string; // the foreman's display name (empty for master report)
  workerSummaries: WorkerSummary[]; // per-worker, jobs broken out (worker view)
  grandTotal: number; // total labor hours across all jobs for the week
}

// A single readable line for one flag.
// The detail string is already a complete, localized line.
export function flagLabel(f: Flag, _overHoursThreshold: number): string {
  return f.detail;
}

export interface FlagGroup {
  worker: string;
  dateISO: string;
  lines: string[];
}

// Group all flags by person + day so one person/day shows once with its issues
// listed underneath, rather than repeating the name per flag.
export function groupFlags(
  flags: Flag[],
  overHoursThreshold: number
): FlagGroup[] {
  const map = new Map<string, FlagGroup>();
  const order: string[] = [];
  for (const f of flags) {
    const key = `${f.dateISO}|${f.worker}`;
    let g = map.get(key);
    if (!g) {
      g = { worker: f.worker, dateISO: f.dateISO, lines: [] };
      map.set(key, g);
      order.push(key);
    }
    g.lines.push(flagLabel(f, overHoursThreshold));
  }
  return order.map((k) => map.get(k)!);
}

// A single timecard entry above this many hours is almost certainly a typo.
const SINGLE_ENTRY_LIMIT = 13;

// Tidy a free-text job name for display: collapse whitespace, Title Case.
export function prettifyJob(s: string): string {
  const clean = (s || "").trim().replace(/\s+/g, " ");
  if (!clean) return "Unassigned job";
  return clean
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Local-date helpers that never drift across timezones.
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function dayIndex(weekStartISO: string, dateISO: string): number {
  const [y1, m1, d1] = weekStartISO.split("-").map(Number);
  const [y2, m2, d2] = dateISO.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

function fmtDayLabel(iso: string, lang: ReportLang): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAY_NAMES_I18N[lang][dow]} ${m}/${d}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function spanDays(startISO: string, endISO: string): number {
  const [y1, m1, d1] = startISO.split("-").map(Number);
  const [y2, m2, d2] = endISO.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000) + 1; // inclusive
}

// Build the full report from raw rows + the active roster, over an arbitrary
// inclusive date span (startISO..endISO). For the weekly presets the span is
// a 7-day Sun..Sat; custom ranges may be any length.
export function buildReport(
  rows: RawRow[],
  activeRoster: string[],
  weekStartISO: string, // span start
  overHoursThreshold: number,
  weekEndOverrideISO?: string, // span end; defaults to start + 6 (a week)
  foremanFilter?: string, // if set, grid shows only this foreman's entries
  lang: ReportLang = "en",
  confirmedFlagKeys?: Set<string> // worker|dateISO|kindlabel confirmed in the cockpit
): ReportData {
  const weekEndISO = weekEndOverrideISO || addDaysISO(weekStartISO, 6);
  const nDays = Math.max(1, spanDays(weekStartISO, weekEndISO));
  const dayLabels = Array.from({ length: nDays }, (_, i) =>
    fmtDayLabel(addDaysISO(weekStartISO, i), lang)
  );

  // Group key: prefer clean project; else fall back to job text (unassigned).
  type Group = {
    title: string;
    jobId: string;
    unassigned: boolean;
    // worker -> 7-day hours
    byWorker: Map<string, number[]>;
  };
  const groups = new Map<string, Group>();

  // Track per-worker-per-day totals (across all jobs) for the over-hours flag,
  // and detailed entries per worker-per-job-per-day for the double-entry flag.
  const dayTotal = new Map<string, number>(); // key: worker|date
  type Entry = { hours: number; foreman: string; job: string };
  const entriesByJobDay = new Map<string, Entry[]>(); // key: worker|jobTitle|date
  const entriesByDay = new Map<string, Entry[]>(); // key: worker|date
  // For the multi-job flag: worker|date -> map of jobTitle -> set of foremen.
  const jobsPerDay = new Map<string, Map<string, Set<string>>>();
  // For the single-entry flag: the individual entries themselves.
  const singleHighs: {
    worker: string;
    dateISO: string;
    hours: number;
    foreman: string;
    job: string;
  }[] = [];

  const ff = foremanFilter ? foremanFilter.trim().toLowerCase() : "";

  for (const r of rows) {
    const idx = dayIndex(weekStartISO, r.dateISO);
    if (idx < 0 || idx >= nDays) continue; // outside the span

    const assigned = !!r.projectName.trim();
    const groupKey = assigned
      ? `P:${r.projectName.trim().toLowerCase()}`
      : `J:${(r.jobText || "").trim().toLowerCase()}`;
    const title = assigned ? r.projectName.trim() : prettifyJob(r.jobText);
    const rowForeman = (r.foreman || "").trim();

    // GRID: include the row only if no foreman filter, or it's this foreman's.
    if (!ff || rowForeman.toLowerCase() === ff) {
      let g = groups.get(groupKey);
      if (!g) {
        g = {
          title,
          jobId: assigned ? r.jobId.trim() : "",
          unassigned: !assigned,
          byWorker: new Map(),
        };
        groups.set(groupKey, g);
      }
      if (assigned && !g.jobId && r.jobId.trim()) g.jobId = r.jobId.trim();

      let days = g.byWorker.get(r.worker);
      if (!days) {
        days = new Array(nDays).fill(0);
        g.byWorker.set(r.worker, days);
      }
      days[idx] += r.hours;
    }

    // FLAGS: always track across ALL rows so cross-foreman issues are caught.
    const dtKey = `${r.worker}|${r.dateISO}`;
    dayTotal.set(dtKey, (dayTotal.get(dtKey) || 0) + r.hours);

    const entry: Entry = {
      hours: r.hours,
      foreman: rowForeman,
      job: title,
    };

    const ecKey = `${r.worker}|${title.toLowerCase()}|${r.dateISO}`;
    const elist = entriesByJobDay.get(ecKey);
    if (elist) elist.push(entry);
    else entriesByJobDay.set(ecKey, [entry]);

    const dlist = entriesByDay.get(dtKey);
    if (dlist) dlist.push(entry);
    else entriesByDay.set(dtKey, [entry]);

    // Multi-job tracking (keyed by clean job title)
    let jmap = jobsPerDay.get(dtKey);
    if (!jmap) {
      jmap = new Map();
      jobsPerDay.set(dtKey, jmap);
    }
    let fset = jmap.get(title);
    if (!fset) {
      fset = new Set();
      jmap.set(title, fset);
    }
    if (rowForeman) fset.add(rowForeman);

    // Single-entry-too-high tracking
    if (r.hours > SINGLE_ENTRY_LIMIT) {
      singleHighs.push({
        worker: r.worker,
        dateISO: r.dateISO,
        hours: r.hours,
        foreman: rowForeman,
        job: title,
      });
    }
  }

  // Assemble sections: assigned first (alphabetical), then unassigned last.
  const sections: JobSection[] = [];
  const groupArr = Array.from(groups.values());
  groupArr.sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  for (const g of groupArr) {
    const people: PersonRow[] = [];
    for (const [name, days] of g.byWorker) {
      const perDay = days.map((h) => (h > 0 ? round2(h) : null));
      const total = round2(days.reduce((s, h) => s + h, 0));
      people.push({ name, perDay, total });
    }
    people.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );

    const dailyTotals = new Array(nDays).fill(0);
    for (const p of people) {
      p.perDay.forEach((h, i) => {
        if (h != null) dailyTotals[i] += h;
      });
    }
    const grandTotal = round2(dailyTotals.reduce((s, h) => s + h, 0));

    sections.push({
      title: g.title,
      jobId: g.jobId,
      unassigned: g.unassigned,
      people,
      dailyTotals: dailyTotals.map(round2),
      grandTotal,
    });
  }

  // Who worked at all during the span?
  const workedNames = new Set<string>();
  for (const r of rows) {
    const idx = dayIndex(weekStartISO, r.dateISO);
    if (idx >= 0 && idx < nDays) workedNames.add(r.worker);
  }
  const noHours = ff
    ? []
    : activeRoster
        .filter((n) => !workedNames.has(n))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  // Flags
  const flags: Flag[] = [];

  // Over-hours: show the breakdown of what made up the day.
  for (const [key, tot] of dayTotal) {
    if (tot > overHoursThreshold) {
      const [worker, dateISO] = key.split("|");
      const entries = entriesByDay.get(key) || [];
      flags.push({
        worker,
        dateISO,
        kind: "over_hours",
        detail: phraseOverHours(
          lang,
          round2(tot),
          entries.map((e) => ({
            hours: round2(e.hours),
            job: e.job,
            foreman: e.foreman,
          })),
          overHoursThreshold
        ),
        foremen: Array.from(
          new Set(entries.map((e) => e.foreman).filter(Boolean))
        ),
        jobs: Array.from(new Set(entries.map((e) => e.job))),
      });
    }
  }
  // Double entry: same worker, same job, same day, more than one card.
  for (const [key, entries] of entriesByJobDay) {
    if (entries.length > 1) {
      const [worker, , dateISO] = key.split("|");
      const job = entries[0].job;
      flags.push({
        worker,
        dateISO,
        kind: "double_entry",
        detail: phraseDoubleEntry(
          lang,
          entries.length,
          job,
          entries.map((e) => ({ hours: round2(e.hours), foreman: e.foreman }))
        ),
        foremen: Array.from(
          new Set(entries.map((e) => e.foreman).filter(Boolean))
        ),
        jobs: [job],
      });
    }
  }

  // Same worker on 2+ different jobs the same day (the two-foremen catch).
  for (const [key, jmap] of jobsPerDay) {
    if (jmap.size >= 2) {
      const [worker, dateISO] = key.split("|");
      const parts: string[] = [];
      for (const [job, foremen] of jmap) {
        const fmn = Array.from(foremen).filter(Boolean);
        parts.push(fmn.length ? `${job} (${fmn.join(", ")})` : job);
      }
      const allForemen = new Set<string>();
      for (const fs2 of jmap.values())
        for (const fm of fs2) if (fm) allForemen.add(fm);
      flags.push({
        worker,
        dateISO,
        kind: "multi_job",
        detail: phraseMultiJob(lang, jmap.size, parts),
        foremen: Array.from(allForemen),
        jobs: Array.from(jmap.keys()),
      });
    }
  }

  // Single entry above the realistic daily limit (likely a typo).
  for (const s of singleHighs) {
    flags.push({
      worker: s.worker,
      dateISO: s.dateISO,
      kind: "single_high",
      detail: phraseSingleHigh(
        lang,
        round2(s.hours),
        s.job,
        s.foreman,
        SINGLE_ENTRY_LIMIT
      ),
      foremen: s.foreman ? [s.foreman] : [],
      jobs: [s.job],
    });
  }

  // Worker not on the active roster (misspelled name or unconfirmed add).
  const rosterSet = new Set(
    activeRoster.map((n) => n.trim().toLowerCase())
  );
  const offRosterSeen = new Set<string>();
  for (const r of rows) {
    const idx = dayIndex(weekStartISO, r.dateISO);
    if (idx < 0 || idx >= nDays) continue;
    const norm = r.worker.trim().toLowerCase();
    if (!rosterSet.has(norm) && !offRosterSeen.has(norm)) {
      offRosterSeen.add(norm);
      flags.push({
        worker: r.worker,
        dateISO: r.dateISO,
        kind: "off_roster",
        detail: phraseOffRoster(lang),
        foremen: (r.foreman || "").trim() ? [(r.foreman || "").trim()] : [],
      });
    }
  }

  let outFlags = flags;
  if (ff) {
    outFlags = flags.filter((f) =>
      (f.foremen || []).some((fm) => fm.trim().toLowerCase() === ff)
    );
  }

  // Remove flags the user already confirmed ("Looks OK") in the reconciliation
  // cockpit. Report flag kinds are mapped to the same labels the cockpit writes
  // to the Reconciliation Log, then matched on worker|date|label.
  if (confirmedFlagKeys && confirmedFlagKeys.size > 0) {
    const KIND_TO_LABEL: Record<string, string> = {
      double_entry: "duplicate",
      multi_job: "two jobs same day",
      over_hours: "over 11 hrs that day",
      single_high: "high hours",
    };
    outFlags = outFlags.filter((f) => {
      const label = KIND_TO_LABEL[f.kind];
      if (!label) return true; // off_roster etc. — not confirmable in cockpit
      const key = `${f.worker.trim().toLowerCase()}|${f.dateISO}|${label}`;
      return !confirmedFlagKeys.has(key);
    });
  }

  outFlags.sort(
    (a, b) => a.dateISO.localeCompare(b.dateISO) || a.worker.localeCompare(b.worker)
  );

  // The week runs Monday..Sunday, so Sunday is the LAST day. Hide the trailing
  // Sunday column when nobody logged Sunday hours; keep it if anyone worked it
  // so no hours are lost.
  let finalDayLabels = dayLabels;
  let finalSections = sections;
  const [sy, sm, sd] = weekStartISO.split("-").map(Number);
  const startsMonday = new Date(Date.UTC(sy, sm - 1, sd)).getUTCDay() === 1;
  if (startsMonday && nDays === 7) {
    const lastIdx = nDays - 1; // Sunday
    const sundayWorked = sections.some((sec) =>
      sec.people.some((p) => p.perDay[lastIdx] != null)
    );
    if (!sundayWorked) {
      finalDayLabels = dayLabels.slice(0, lastIdx);
      finalSections = sections.map((sec) => ({
        ...sec,
        people: sec.people.map((p) => ({ ...p, perDay: p.perDay.slice(0, lastIdx) })),
        dailyTotals: sec.dailyTotals.slice(0, lastIdx),
      }));
    }
  }

  // Pivot into a per-worker summary: each worker, one line per DAY they worked
  // (date · job · that day's hours), ordered earliest day first, with a weekly
  // total. A worker on a job across multiple days gets one line per day.
  const wsMap = new Map<string, WorkerJobLine[]>();
  for (const sec of finalSections) {
    const label = sec.title;
    for (const p of sec.people) {
      p.perDay.forEach((v, idx) => {
        if (v == null) return; // didn't work that day on this job
        const line: WorkerJobLine = {
          title: label,
          jobId: sec.jobId,
          hours: v,
          firstDayIdx: idx,
          firstDayLabel: finalDayLabels[idx] || "",
        };
        const arr = wsMap.get(p.name);
        if (arr) arr.push(line);
        else wsMap.set(p.name, [line]);
      });
    }
  }
  const workerSummaries: WorkerSummary[] = Array.from(wsMap.entries())
    .map(([name, jobs]) => {
      jobs.sort(
        (a, b) =>
          a.firstDayIdx - b.firstDayIdx ||
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
      );
      return {
        name,
        jobs,
        total: Math.round(jobs.reduce((s, j) => s + j.hours, 0) * 100) / 100,
      };
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );

  const grandTotal = finalSections.reduce((s, sec) => s + sec.grandTotal, 0);

  return {
    weekStartISO,
    weekEndISO,
    dayLabels: finalDayLabels,
    sections: finalSections,
    noHours,
    flags: outFlags,
    overHoursThreshold,
    lang,
    foremanReport: !!ff,
    foremanName: foremanFilter ? foremanFilter.trim() : "",
    workerSummaries,
    grandTotal,
  };
}

// Most recently completed Sunday (the start of last week's Sun..Sat).
// If today is Sunday, last completed week started 7 days ago.
// Format an ISO date (YYYY-MM-DD) as numeric M/D/YYYY for report headers.
export function fmtNumericDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}

export function lastCompletedWeekStart(todayISO: string): string {
  const [y, m, d] = todayISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 = Sunday, 1 = Monday
  // The week runs Monday..Sunday. Days back to this week's Monday:
  const backToMonday = (dow + 6) % 7; // Mon=0, Tue=1, ... Sun=6
  const thisMonday = addDaysISO(todayISO, -backToMonday);
  return addDaysISO(thisMonday, -7); // the last fully completed Mon..Sun week
}
