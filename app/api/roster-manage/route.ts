import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { NOTION_TOKEN, CREW_ROSTER_DB_ID, ROSTER_PROPS, TIMECARDS_DB_ID, TIMECARD_PROPS } from "@/lib/notion";

// Crew Roster management (owner-only). SERVER-SIDE gated: every request must
// carry the owner PIN and is rejected without it. This endpoint is reachable on
// the public deployment URL, so client-side gating alone was not protection —
// especially now that it returns each foreman's access PIN.
//
// IMPORTANT: this writes to the SAME Crew Roster database the owner platform
// reads read-only for capacity math. We MUST NOT rename or restructure any
// property. We only write the existing fields — Name (title), Active (checkbox),
// Status (rich_text), Role (whatever type it already is). The Role type is
// detected live so we never change it from select↔text.

export const dynamic = "force-dynamic";

const notion = new Client({ auth: NOTION_TOKEN });

const OWNER_PIN = "5314";
const PIN_PROP = "PIN"; // rich_text on Crew Roster — foreman self-service PIN

// Additive only — never renames or removes anything, so the owner platform
// that reads this database is unaffected.
let aliasEnsured = false;
async function ensureAliasProperty(): Promise<void> {
  if (aliasEnsured) return;
  try {
    const db: any = await notion.databases.retrieve({ database_id: CREW_ROSTER_DB_ID });
    if (!db.properties?.[ROSTER_PROPS.aliases]) {
      await notion.databases.update({
        database_id: CREW_ROSTER_DB_ID,
        properties: { [ROSTER_PROPS.aliases]: { rich_text: {} } } as any,
      });
    }
    aliasEnsured = true;
  } catch { /* leave it — writes below simply won't stick until it exists */ }
}

function ownerOk(pin: string | null | undefined): boolean {
  return (pin || "").trim() === OWNER_PIN;
}

function readRole(prop: any): string {
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "rich_text")
    return prop.rich_text?.map((t: any) => t.plain_text).join("") || "";
  if (prop.type === "multi_select")
    return (prop.multi_select || []).map((s: any) => s.name).join(", ");
  return "";
}
function readText(prop: any): string {
  if (!prop) return "";
  if (prop.type === "rich_text")
    return prop.rich_text?.map((t: any) => t.plain_text).join("") || "";
  if (prop.type === "title")
    return prop.title?.map((t: any) => t.plain_text).join("") || "";
  if (prop.type === "select") return prop.select?.name || "";
  return "";
}

// Cache the Role property's live type so writes match the schema exactly.
let roleTypeCache: { type: string; ts: number } | null = null;
async function getRoleType(): Promise<string> {
  if (roleTypeCache && Date.now() - roleTypeCache.ts < 10 * 60 * 1000)
    return roleTypeCache.type;
  try {
    const db: any = await notion.databases.retrieve({ database_id: CREW_ROSTER_DB_ID });
    const t = db.properties?.[ROSTER_PROPS.role]?.type || "rich_text";
    roleTypeCache = { type: t, ts: Date.now() };
    return t;
  } catch {
    return "rich_text";
  }
}

// Build a Role write payload matching whatever type the property already is.
function rolePayload(roleType: string, value: string): any {
  const v = (value || "").trim();
  if (roleType === "select") return { select: v ? { name: v } : null };
  if (roleType === "multi_select")
    return { multi_select: v ? [{ name: v }] : [] };
  return { rich_text: v ? [{ text: { content: v } }] : [] };
}

// GET — full roster with detail (for the management screen). Owner PIN required.
export async function GET(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  if (!ownerOk(req.nextUrl.searchParams.get("ownerPin")))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const people: {
      id: string;
      name: string;
      role: string;
      active: boolean;
      status: string;
      pin: string;
      aliases: string;
    }[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: CREW_ROSTER_DB_ID,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const pg of res.results) {
        const p = pg.properties || {};
        const name = readText(p[ROSTER_PROPS.name]).trim();
        if (!name) continue;
        people.push({
          id: pg.id,
          name,
          role: readRole(p[ROSTER_PROPS.role]),
          active: !!p[ROSTER_PROPS.active]?.checkbox,
          status: readText(p[ROSTER_PROPS.status]),
          // Access PIN, if one has been issued. Only ever leaves the server on
          // an owner-authenticated request.
          pin: readText(p[PIN_PROP]).trim(),
          aliases: readText(p[ROSTER_PROPS.aliases]).trim(),
        });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    people.sort((a, b) => {
      // active first, then alphabetical
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return NextResponse.json({ people });
  } catch (err: any) {
    console.error("Roster manage read failed:", err?.message || err);
    return NextResponse.json({ error: "Could not read the roster." }, { status: 502 });
  }
}

// POST — add / edit / set-active. Owner PIN required server-side.
export async function POST(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  if (!ownerOk(body.ownerPin))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const op = body.op as string;

  try {
    if (op === "add") {
      const name = (body.name || "").trim();
      if (!name) return NextResponse.json({ error: "Name required." }, { status: 400 });
      const roleType = await getRoleType();
      const props: any = {
        [ROSTER_PROPS.name]: { title: [{ text: { content: name } }] },
        [ROSTER_PROPS.active]: { checkbox: body.active !== false },
        [ROSTER_PROPS.role]: rolePayload(roleType, body.role || ""),
        // Confirmed adds from the owner clear Status (no "Unconfirmed").
        [ROSTER_PROPS.status]: { rich_text: [] },
      };
      const pg: any = await notion.pages.create({
        parent: { database_id: CREW_ROSTER_DB_ID },
        properties: props,
      });
      return NextResponse.json({ ok: true, id: pg.id });
    }

    if (op === "edit") {
      const id = body.id as string;
      if (!id) return NextResponse.json({ error: "id required." }, { status: 400 });
      const props: any = {};
      if (typeof body.name === "string" && body.name.trim())
        props[ROSTER_PROPS.name] = { title: [{ text: { content: body.name.trim() } }] };
      if (typeof body.role === "string") {
        const roleType = await getRoleType();
        props[ROSTER_PROPS.role] = rolePayload(roleType, body.role);
      }
      if (typeof body.active === "boolean")
        props[ROSTER_PROPS.active] = { checkbox: body.active };
      if (typeof body.aliases === "string") {
        await ensureAliasProperty();
        props[ROSTER_PROPS.aliases] = {
          rich_text: body.aliases.trim() ? [{ text: { content: body.aliases.trim() } }] : [],
        };
      }
      if (Object.keys(props).length === 0)
        return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
    }

    // Merge a mis-typed roster name into the real person: rewrite the worker
    // name on that person's timecards inside a date window, then deactivate the
    // stray roster row. Deactivate rather than delete so the record survives.
    //
    // Scope is deliberately a window (this week / last week) rather than all
    // time — rewriting months of entries would silently change reports that
    // have already been sent and paid from. Entries outside the window are
    // counted and reported, never touched.
    if (op === "merge_preview" || op === "merge") {
      const fromName = (body.fromName || "").trim();
      const toName = (body.toName || "").trim();
      const startISO = body.startISO;
      const endISO = body.endISO;
      if (!fromName || !toName)
        return NextResponse.json({ error: "fromName and toName required." }, { status: 400 });
      if (fromName.toLowerCase() === toName.toLowerCase())
        return NextResponse.json({ error: "Those are the same name." }, { status: 400 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endISO || ""))
        return NextResponse.json({ error: "Date range required." }, { status: 400 });

      const key = (v: string) =>
        (v || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
      const fromKey = key(fromName);
      const toKey = key(toName);

      // --- Direction check, against the roster as it is RIGHT NOW. The screen
      // hides names that shouldn't be picked, but a screen open since this
      // morning doesn't know about merges made since; this can't be fooled.
      // A merge must fold a stray INTO a real person, never the reverse:
      //   · never into a name already merged away (a dead end)
      //   · never into an unconfirmed name (usually the misspelling itself)
      //   · an active name only merges into another active name
      //   · a stray may merge into someone deactivated, with a confirmation
      const rosterRow = async (name: string): Promise<any | null> => {
        let cur: string | undefined;
        do {
          const res: any = await notion.databases.query({
            database_id: CREW_ROSTER_DB_ID,
            start_cursor: cur,
            page_size: 100,
          });
          for (const pg of res.results) {
            if (key(readText(pg.properties?.[ROSTER_PROPS.name])) === key(name)) return pg;
          }
          cur = res.has_more ? res.next_cursor : undefined;
        } while (cur);
        return null;
      };
      const describe = (pg: any) => {
        const status = readText(pg?.properties?.[ROSTER_PROPS.status]).trim();
        return {
          active: !!pg?.properties?.[ROSTER_PROPS.active]?.checkbox,
          merged: /^merged into/i.test(status),
          unconfirmed: /^unconfirmed/i.test(status),
          status,
        };
      };
      const fromPg = body.fromId
        ? await notion.pages.retrieve({ page_id: body.fromId }).catch(() => null)
        : await rosterRow(fromName);
      const toPg = await rosterRow(toName);
      if (!toPg)
        return NextResponse.json({ error: `${toName} isn't on the roster.` }, { status: 400 });
      const from = describe(fromPg);
      const to = describe(toPg);

      if (to.merged)
        return NextResponse.json(
          { error: `${toName} was already merged away (${to.status}) — merge into that person instead.` },
          { status: 400 }
        );
      if (to.unconfirmed)
        return NextResponse.json(
          { error: `${toName} is unconfirmed — merge into the real person instead.` },
          { status: 400 }
        );
      if (from.active && !to.active)
        return NextResponse.json(
          { error: `${fromName} is active, so it can only merge into another active name.` },
          { status: 400 }
        );
      // Stray into someone who's left: allowed, but only once confirmed.
      const needsConfirm = !to.active;
      if (op === "merge" && needsConfirm && !body.confirmInactive)
        return NextResponse.json(
          { error: `${toName} is deactivated — confirm you want to merge into them.` },
          { status: 400 }
        );

      // Every non-voided entry under the bad name, plus the target's entries,
      // so same-card collisions can be spotted.
      const inWindow: any[] = [];
      const outsideCount = { n: 0 };
      const targetByCardDate = new Map<string, { id: string; hours: number }>();
      let cursor: string | undefined;
      do {
        const res: any = await notion.databases.query({
          database_id: TIMECARDS_DB_ID,
          filter: { property: TIMECARD_PROPS.voided, checkbox: { equals: false } },
          start_cursor: cursor,
          page_size: 100,
        });
        for (const pg of res.results) {
          const p = pg.properties || {};
          const w = key(readText(p[TIMECARD_PROPS.worker]));
          if (w !== fromKey && w !== toKey) continue;
          const d = p[TIMECARD_PROPS.date]?.date?.start?.slice(0, 10) || "";
          const job = readText(p[TIMECARD_PROPS.job]).trim().toLowerCase();
          const hours = typeof p[TIMECARD_PROPS.hours]?.number === "number" ? p[TIMECARD_PROPS.hours].number : 0;
          if (w === toKey) {
            if (d >= startISO && d <= endISO) targetByCardDate.set(`${job}|${d}`, { id: pg.id, hours });
            continue;
          }
          if (d >= startISO && d <= endISO) inWindow.push({ id: pg.id, date: d, job, hours });
          else outsideCount.n++;
        }
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);

      const collisions = inWindow.filter((e) => targetByCardDate.has(`${e.job}|${e.date}`));

      if (op === "merge_preview") {
        return NextResponse.json({
          ok: true,
          willRename: inWindow.length,
          outside: outsideCount.n,
          collisions: collisions.length,
          needsConfirm,
        });
      }

      // Apply. Collisions fold their hours into the existing entry and void the
      // duplicate, so one man never ends up on a card twice.
      let renamed = 0;
      let merged = 0;
      for (const e of inWindow) {
        const hit = targetByCardDate.get(`${e.job}|${e.date}`);
        if (hit && body.combineCollisions) {
          const total = Math.round((hit.hours + e.hours) * 100) / 100;
          await notion.pages.update({
            page_id: hit.id,
            properties: { [TIMECARD_PROPS.hours]: { number: total } },
          });
          await notion.pages.update({
            page_id: e.id,
            properties: {
              [TIMECARD_PROPS.voided]: { checkbox: true },
              [TIMECARD_PROPS.voidNote]: {
                rich_text: [{ text: { content: `Merged into ${toName}` } }],
              },
            },
          });
          hit.hours = total;
          merged++;
          continue;
        }
        await notion.pages.update({
          page_id: e.id,
          properties: { [TIMECARD_PROPS.worker]: { title: [{ text: { content: toName } }] } },
        });
        renamed++;
      }

      // Deactivate the stray roster row — never delete it.
      if (body.fromId) {
        try {
          await notion.pages.update({
            page_id: body.fromId,
            properties: {
              [ROSTER_PROPS.active]: { checkbox: false },
              [ROSTER_PROPS.status]: {
                rich_text: [{ text: { content: `Merged into ${toName}` } }],
              },
            },
          });
        } catch { /* the rename is what matters */ }
      }

      return NextResponse.json({ ok: true, renamed, merged, outside: outsideCount.n });
    }

    if (op === "set_active") {
      const id = body.id as string;
      if (!id) return NextResponse.json({ error: "id required." }, { status: 400 });
      await notion.pages.update({
        page_id: id,
        properties: { [ROSTER_PROPS.active]: { checkbox: !!body.active } },
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown op." }, { status: 400 });
  } catch (err: any) {
    console.error("Roster manage write failed:", err?.message || err);
    return NextResponse.json(
      { error: "Could not update the roster." },
      { status: 502 }
    );
  }
}
