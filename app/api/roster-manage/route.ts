import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { NOTION_TOKEN, CREW_ROSTER_DB_ID, ROSTER_PROPS } from "@/lib/notion";

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
      if (Object.keys(props).length === 0)
        return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
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
