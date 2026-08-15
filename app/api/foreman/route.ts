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
  const target = name.trim().toLowerCase();
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
      if (n.trim().toLowerCase() === target) {
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

      const me = name.toLowerCase();
      type Entry = { worker: string; hours: number; date: string; job: string };
      const mine: Entry[] = [];
      for (const pg of rows) {
        const p = pg.properties || {};
        const fm = rt(p[TIMECARD_PROPS.foreman]).trim().toLowerCase();
        // Scoping line — only this foreman's cards. `me` is guaranteed
        // non-empty by the PIN auth above, and the explicit !fm guard means a
        // blank-foreman card can never match anyone (defense in depth).
        if (!fm || fm !== me) continue;
        mine.push({
          worker: rt(p[TIMECARD_PROPS.worker]),
          hours: p[TIMECARD_PROPS.hours]?.number || 0,
          date: p[TIMECARD_PROPS.date]?.date?.start || "",
          job: rt(p[TIMECARD_PROPS.job]) || "(job)",
        });
      }

      // Group: date (newest first) -> job -> crew
      const byDate = new Map<string, Map<string, Entry[]>>();
      for (const e of mine) {
        if (!byDate.has(e.date)) byDate.set(e.date, new Map());
        const jm = byDate.get(e.date)!;
        if (!jm.has(e.job)) jm.set(e.job, []);
        jm.get(e.job)!.push(e);
      }
      const days = Array.from(byDate.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, jm]) => ({
          date,
          jobs: Array.from(jm.entries()).map(([job, entries]) => ({
            job,
            total: Math.round(entries.reduce((s, e) => s + e.hours, 0) * 100) / 100,
            crew: entries
              .sort((a, b) => a.worker.localeCompare(b.worker))
              .map((e) => ({ worker: e.worker, hours: e.hours })),
          })),
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
