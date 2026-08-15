import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  CREW_ROSTER_DB_ID,
  TIMECARDS_DB_ID,
  TIMECARD_PROPS,
  ROSTER_PROPS,
} from "@/lib/notion";

// Foreman self-service: PIN-gated, READ-ONLY access to a foreman's own
// submissions. SECURITY CORE: every data request validates the foreman's PIN
// server-side against their Crew Roster record, and the query is filtered to
// that foreman's cards only — the client is never trusted to filter. A foreman
// PIN can never unlock owner data; owner PIN handling stays where it is.
//
// The owner sets/resets PINs from Crew roster management (set_pin, gated by
// the owner PIN server-side). Foremen can change their own PIN with the old
// one (change_pin). The "PIN" property on the Crew Roster is auto-created on
// first use — additive only, safe for the owner platform which reads this DB.

export const dynamic = "force-dynamic";

const notion = new Client({ auth: NOTION_TOKEN });
const OWNER_PIN = "5314";
const PIN_PROP = "PIN"; // rich_text on Crew Roster (auto-created)

function rt(prop: any): string {
  if (!prop) return "";
  if (prop.type === "rich_text")
    return (prop.rich_text || []).map((t: any) => t.plain_text).join("");
  if (prop.type === "title")
    return (prop.title || []).map((t: any) => t.plain_text).join("");
  return "";
}

// Normalize a name/label for comparison: NFC, collapse whitespace, trim, lower.
// Same helper the reports use, so a stray accent encoding or double space can
// never split one person (or one job) into two.
function nkey(s: string): string {
  return (s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Ensure the PIN property exists on the roster (additive — never renames or
// removes anything, so the owner platform is unaffected).
async function ensurePinProperty(): Promise<void> {
  const db: any = await notion.databases.retrieve({ database_id: CREW_ROSTER_DB_ID });
  if (db.properties?.[PIN_PROP]) return;
  await notion.databases.update({
    database_id: CREW_ROSTER_DB_ID,
    properties: { [PIN_PROP]: { rich_text: {} } } as any,
  });
}

// Find a roster page by (case-insensitive, trimmed) name. Returns page + pin.
async function findRosterByName(
  name: string
): Promise<{ pageId: string; pin: string } | null> {
  const target = nkey(name);
  if (!target) return null;
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: CREW_ROSTER_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const pg of res.results) {
      const n = rt(pg.properties?.[ROSTER_PROPS.name]);
      if (nkey(n) === target) {
        return { pageId: pg.id, pin: rt(pg.properties?.[PIN_PROP]).trim() };
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return null;
}

// Validate a foreman's PIN server-side. True only when a PIN is set and matches.
async function validForemanPin(name: string, pin: string): Promise<boolean> {
  if (!/^\d{4}$/.test(pin || "")) return false;
  const rec = await findRosterByName(name);
  if (!rec || !rec.pin) return false; // no PIN set → no access
  return rec.pin === pin;
}

export async function GET(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "NOTION_TOKEN not set" }, { status: 500 });
  const sp = req.nextUrl.searchParams;
  const action = sp.get("action");
  const name = (sp.get("name") || "").trim();
  const pin = (sp.get("pin") || "").trim();

  try {
    // Gate EVERY read behind the server-side PIN check.
    const ok = await validForemanPin(name, pin);
    if (!ok) return NextResponse.json({ ok: false, error: "Invalid PIN" }, { status: 401 });

    if (action === "verify") return NextResponse.json({ ok: true });

    if (action === "submissions") {
      const start = sp.get("start") || "";
      const end = sp.get("end") || "";
      if (!start || !end)
        return NextResponse.json({ ok: false, error: "start and end required" }, { status: 400 });

      // Pull the range, then scope to THIS foreman only, server-side.
      const rows: any[] = [];
      let cursor: string | undefined;
      do {
        const res: any = await notion.databases.query({
          database_id: TIMECARDS_DB_ID,
          start_cursor: cursor,
          page_size: 100,
          filter: {
            and: [
              { property: TIMECARD_PROPS.date, date: { on_or_after: start } },
              { property: TIMECARD_PROPS.date, date: { on_or_before: end } },
              { property: TIMECARD_PROPS.voided, checkbox: { equals: false } },
            ],
          },
        });
        rows.push(...res.results);
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);

      const me = nkey(name);
      type Entry = { worker: string; hours: number; date: string; job: string; jobKey: string };
      const mine: Entry[] = [];

      // Resolve the assigned project the same way reports do: Project Helper
      // (the project the owner assigns in Reconcile) is the source of truth,
      // and the foreman's typed Job text is only a fallback for rows that
      // haven't been assigned yet.
      const relIds = (prop: any): string[] => {
        if (!prop) return [];
        if (prop.type === "relation") return (prop.relation || []).map((r: any) => r.id);
        if (prop.type === "rollup" && prop.rollup?.type === "array") {
          const out: string[] = [];
          for (const sub of prop.rollup.array || []) {
            if (sub?.type === "relation")
              for (const r of sub.relation || []) out.push(r.id);
          }
          return out;
        }
        return [];
      };
      const needResolve = new Set<string>();
      for (const pg of rows) {
        const p = pg.properties || {};
        if (nkey(rt(p[TIMECARD_PROPS.foreman])) !== me) continue;
        relIds(p[TIMECARD_PROPS.projectHelper]).forEach((id) => needResolve.add(id));
      }
      const relTitle = new Map<string, string>();
      for (const id of needResolve) {
        try {
          const pg: any = await notion.pages.retrieve({ page_id: id });
          for (const key of Object.keys(pg.properties || {})) {
            const p = pg.properties[key];
            if (p?.type === "title") {
              const t = (p.title || []).map((x: any) => x.plain_text).join("").trim();
              if (t) relTitle.set(id, t);
              break;
            }
          }
        } catch {
          /* unresolved — falls back to typed text */
        }
      }

      for (const pg of rows) {
        const p = pg.properties || {};
        const fm = nkey(rt(p[TIMECARD_PROPS.foreman]));
        // Scoping line — only this foreman's cards. `me` is guaranteed
        // non-empty by the PIN auth above, and the explicit !fm guard means a
        // blank-foreman card can never match anyone (defense in depth).
        if (!fm || fm !== me) continue;
        let job = rt(p[TIMECARD_PROPS.projectHelper]);
        if (!job) {
          job = relIds(p[TIMECARD_PROPS.projectHelper])
            .map((id) => relTitle.get(id) || "")
            .filter(Boolean)
            .join(", ");
        }
        if (!job) job = rt(p[TIMECARD_PROPS.job]); // unassigned — foreman's typed name
        if (!job) job = "(job)";
        mine.push({
          worker: rt(p[TIMECARD_PROPS.worker]),
          hours: p[TIMECARD_PROPS.hours]?.number || 0,
          date: p[TIMECARD_PROPS.date]?.date?.start || "",
          job,
          jobKey: nkey(job),
        });
      }

      // Group: date (newest first) -> job -> crew. Jobs group on a normalized
      // key so two spellings of the same unassigned typed name don't split into
      // two cards; the label shown is the spelling used by the most rows.
      const byDate = new Map<string, Map<string, Entry[]>>();
      for (const e of mine) {
        if (!byDate.has(e.date)) byDate.set(e.date, new Map());
        const jm = byDate.get(e.date)!;
        if (!jm.has(e.jobKey)) jm.set(e.jobKey, []);
        jm.get(e.jobKey)!.push(e);
      }
      const bestLabel = (entries: Entry[], pick: (e: Entry) => string): string => {
        const counts = new Map<string, number>();
        for (const e of entries) {
          const v = pick(e);
          counts.set(v, (counts.get(v) || 0) + 1);
        }
        let best = pick(entries[0]);
        let n = -1;
        for (const [v, c] of counts) if (c > n) { best = v; n = c; }
        return best;
      };
      const days = Array.from(byDate.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, jm]) => ({
          date,
          jobs: Array.from(jm.values()).map((entries) => {
            // Merge duplicate rows for the same worker (e.g. a worker added to
            // the card after it was first submitted) into one line.
            const byWorker = new Map<string, Entry[]>();
            for (const e of entries) {
              const k = nkey(e.worker);
              if (!byWorker.has(k)) byWorker.set(k, []);
              byWorker.get(k)!.push(e);
            }
            return {
              job: bestLabel(entries, (e) => e.job),
              total: Math.round(entries.reduce((s, e) => s + e.hours, 0) * 100) / 100,
              crew: Array.from(byWorker.values())
                .map((rowsForWorker) => ({
                  worker: bestLabel(rowsForWorker, (e) => e.worker),
                  hours:
                    Math.round(rowsForWorker.reduce((s, e) => s + e.hours, 0) * 100) / 100,
                }))
                .sort((a, b) => a.worker.localeCompare(b.worker)),
            };
          }),
        }));
      const grand = Math.round(mine.reduce((s, e) => s + e.hours, 0) * 100) / 100;
      return NextResponse.json({ ok: true, days, grandTotal: grand });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "NOTION_TOKEN not set" }, { status: 500 });
  try {
    const body = await req.json();
    const { op } = body;

    if (op === "set_pin") {
      // Owner sets/resets a foreman's PIN — owner PIN required server-side.
      const { ownerPin, name, pin } = body;
      if (ownerPin !== OWNER_PIN)
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      if (!/^\d{4}$/.test(pin || ""))
        return NextResponse.json({ ok: false, error: "PIN must be 4 digits" }, { status: 400 });
      if (pin === OWNER_PIN)
        return NextResponse.json({ ok: false, error: "That PIN is reserved" }, { status: 400 });
      await ensurePinProperty();
      const rec = await findRosterByName(name || "");
      if (!rec) return NextResponse.json({ ok: false, error: "Worker not found" }, { status: 404 });
      await notion.pages.update({
        page_id: rec.pageId,
        properties: { [PIN_PROP]: { rich_text: [{ text: { content: pin } }] } },
      });
      return NextResponse.json({ ok: true });
    }

    if (op === "clear_pin") {
      // Owner removes a foreman's PIN (revokes self-service access).
      const { ownerPin, name } = body;
      if (ownerPin !== OWNER_PIN)
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      const rec = await findRosterByName(name || "");
      if (!rec) return NextResponse.json({ ok: false, error: "Worker not found" }, { status: 404 });
      await notion.pages.update({
        page_id: rec.pageId,
        properties: { [PIN_PROP]: { rich_text: [] } },
      });
      return NextResponse.json({ ok: true });
    }

    if (op === "change_pin") {
      // Foreman changes their own PIN — old PIN required server-side.
      const { name, oldPin, newPin } = body;
      const ok = await validForemanPin(name || "", oldPin || "");
      if (!ok) return NextResponse.json({ ok: false, error: "Invalid PIN" }, { status: 401 });
      if (!/^\d{4}$/.test(newPin || ""))
        return NextResponse.json({ ok: false, error: "PIN must be 4 digits" }, { status: 400 });
      if (newPin === OWNER_PIN)
        return NextResponse.json({ ok: false, error: "That PIN is reserved" }, { status: 400 });
      const rec = await findRosterByName(name || "");
      if (!rec) return NextResponse.json({ ok: false, error: "Worker not found" }, { status: 404 });
      await notion.pages.update({
        page_id: rec.pageId,
        properties: { [PIN_PROP]: { rich_text: [{ text: { content: newPin } }] } },
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Unknown op" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 502 });
  }
}
