// Builds the weekly payroll report data structure from raw Notion timecard
// rows. Pure data shaping — no file generation here (that's report-excel.ts
// and report-pdf.ts). Read-only with respect to Notion.

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
}

export interface ReportData {
  weekStartISO: string; // Sunday
  weekEndISO: string; // Saturday
  dayLabels: string[]; // ["Sun 6/22", ...]
  sections: JobSection[]; // assigned jobs first, then unassigned
  noHours: string[]; // active roster names with zero hours this week
  flags: Flag[];
  overHoursThreshold: number;
}

// A single readable line for one flag.
export function flagLabel(f: Flag, overHoursThreshold: number): string {
  switch (f.kind) {
    case "over_hours":
      return `${f.detail} (over ${overHoursThreshold}/day)`;
    case "double_entry":
      return `Possible double entry (${f.detail})`;
    case "multi_job":
      return f.detail;
    case "single_high":
      return f.detail;
    case "off_roster":
      return f.detail;
    default:
      return f.detail;
  }
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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

function fmtDayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAY_NAMES[dow]} ${m}/${d}`;
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
  weekEndOverrideISO?: string // span end; defaults to start + 6 (a week)
): ReportData {
  const weekEndISO = weekEndOverrideISO || addDaysISO(weekStartISO, 6);
  const nDays = Math.max(1, spanDays(weekStartISO, weekEndISO));
  const dayLabels = Array.from({ length: nDays }, (_, i) =>
    fmtDayLabel(addDaysISO(weekStartISO, i))
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
  // and per-worker-per-job-per-day counts for the double-entry flag.
  const dayTotal = new Map<string, number>(); // key: worker|date
  const entryCount = new Map<string, number>(); // key: worker|job|date
  // For the multi-job flag: worker|date -> map of jobTitle -> set of foremen.
  const jobsPerDay = new Map<string, Map<string, Set<string>>>();
  // For the single-entry flag: the individual entries themselves.
  const singleHighs: { worker: string; dateISO: string; hours: number }[] = [];

  for (const r of rows) {
    const idx = dayIndex(weekStartISO, r.dateISO);
    if (idx < 0 || idx >= nDays) continue; // outside the span

    const assigned = !!r.projectName.trim();
    const groupKey = assigned
      ? `P:${r.projectName.trim().toLowerCase()}`
      : `J:${(r.jobText || "").trim().toLowerCase()}`;
    const title = assigned ? r.projectName.trim() : prettifyJob(r.jobText);

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

    const dtKey = `${r.worker}|${r.dateISO}`;
    dayTotal.set(dtKey, (dayTotal.get(dtKey) || 0) + r.hours);

    const ecKey = `${r.worker}|${title.toLowerCase()}|${r.dateISO}`;
    entryCount.set(ecKey, (entryCount.get(ecKey) || 0) + 1);

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
    if (r.foreman && r.foreman.trim()) fset.add(r.foreman.trim());

    // Single-entry-too-high tracking
    if (r.hours > SINGLE_ENTRY_LIMIT) {
      singleHighs.push({ worker: r.worker, dateISO: r.dateISO, hours: r.hours });
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
  const noHours = activeRoster
    .filter((n) => !workedNames.has(n))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  // Flags
  const flags: Flag[] = [];
  for (const [key, tot] of dayTotal) {
    if (tot > overHoursThreshold) {
      const [worker, dateISO] = key.split("|");
      flags.push({
        worker,
        dateISO,
        kind: "over_hours",
        detail: `${round2(tot)} hrs in one day`,
      });
    }
  }
  for (const [key, count] of entryCount) {
    if (count > 1) {
      const [worker, , dateISO] = key.split("|");
      flags.push({
        worker,
        dateISO,
        kind: "double_entry",
        detail: `${count} entries, same job same day`,
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
      flags.push({
        worker,
        dateISO,
        kind: "multi_job",
        detail: `On ${jmap.size} jobs same day: ${parts.join(" + ")}`,
      });
    }
  }

  // Single entry above the realistic daily limit (likely a typo).
  for (const s of singleHighs) {
    flags.push({
      worker: s.worker,
      dateISO: s.dateISO,
      kind: "single_high",
      detail: `Single entry of ${round2(s.hours)} hrs (over ${SINGLE_ENTRY_LIMIT})`,
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
        detail: "Not on active roster — check name/spelling",
      });
    }
  }

  flags.sort(
    (a, b) => a.dateISO.localeCompare(b.dateISO) || a.worker.localeCompare(b.worker)
  );

  return {
    weekStartISO,
    weekEndISO,
    dayLabels,
    sections,
    noHours,
    flags,
    overHoursThreshold,
  };
}

// Most recently completed Sunday (the start of last week's Sun..Sat).
// If today is Sunday, last completed week started 7 days ago.
export function lastCompletedWeekStart(todayISO: string): string {
  const [y, m, d] = todayISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 = Sunday
  // Go back to this week's Sunday, then back one more week.
  const thisSunday = addDaysISO(todayISO, -dow);
  return addDaysISO(thisSunday, -7);
}
