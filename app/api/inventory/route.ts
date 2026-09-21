import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { NOTION_TOKEN } from "@/lib/notion";
import {
  materialsDb,
  toolsDb,
  eventsDb,
  catalogDb,
  MAT_PROPS,
  TOOL_PROPS,
  EVENT_PROPS,
  CAT_PROPS,
  SEED_CATALOG,
  YARDS,
  TOOL_LOCATIONS,
  ensureToolLocation,
  normalizePlace,
} from "@/lib/inventory";

// Owner-only. Crew should never adjust counts or reassign tools, so every
// request carries the owner PIN — same gate as the rest of the admin area.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const notion = new Client({ auth: NOTION_TOKEN });
const OWNER_PIN = "5314";

function rt(prop: any): string {
  if (!prop) return "";
  if (prop.type === "rich_text")
    return (prop.rich_text || []).map((t: any) => t.plain_text).join("");
  if (prop.type === "title")
    return (prop.title || []).map((t: any) => t.plain_text).join("");
  if (prop.type === "select") return prop.select?.name || "";
  return "";
}
const text = (v: string) => ({ rich_text: v ? [{ text: { content: v } }] : [] });
const title = (v: string) => ({ title: [{ text: { content: v } }] });

function isISO(s: any): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function todayPhoenix(): string {
  // Vercel runs in UTC; Arizona is a fixed UTC-7 with no DST.
  const d = new Date(Date.now() - 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function queryAll(database_id: string, filter?: any): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id,
      ...(filter ? { filter } : {}),
      start_cursor: cursor,
      page_size: 100,
    });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function loadCatalog() {
  const db = await catalogDb();
  let rows = await queryAll(db);
  if (rows.length === 0) {
    for (const c of SEED_CATALOG) {
      await notion.pages.create({
        parent: { database_id: db },
        properties: {
          [CAT_PROPS.name]: title(c.name),
          [CAT_PROPS.kind]: { select: { name: c.kind } },
          [CAT_PROPS.sized]: { checkbox: !!(c as any).sized },
        },
      });
    }
    rows = await queryAll(db);
  }
  return rows.map((pg) => {
    const p = pg.properties || {};
    return {
      id: pg.id,
      name: rt(p[CAT_PROPS.name]),
      kind: rt(p[CAT_PROPS.kind]),
      parent: rt(p[CAT_PROPS.parent]),
      sized: !!p[CAT_PROPS.sized]?.checkbox,
    };
  });
}

function mapMaterial(pg: any) {
  const p = pg.properties || {};
  return {
    id: pg.id,
    material: rt(p[MAT_PROPS.material]),
    size: rt(p[MAT_PROPS.size]),
    yard: normalizePlace(rt(p[MAT_PROPS.yard])),
    quantity: typeof p[MAT_PROPS.quantity]?.number === "number" ? p[MAT_PROPS.quantity].number : 0,
  };
}

function mapTool(pg: any) {
  const p = pg.properties || {};
  return {
    id: pg.id,
    tool: rt(p[TOOL_PROPS.tool]),
    type: rt(p[TOOL_PROPS.type]),
    number: p[TOOL_PROPS.number]?.number || 0,
    size: rt(p[TOOL_PROPS.size]),
    status: rt(p[TOOL_PROPS.status]) || "In Yard",
    holder: rt(p[TOOL_PROPS.holder]),
    issued: p[TOOL_PROPS.issued]?.date?.start?.slice(0, 10) || "",
    location: normalizePlace(rt(p[TOOL_PROPS.location])),
  };
}

// Every custody change is written as an event FIRST, then the tool's current
// state is updated. The events are the history; the tool row is just the
// latest snapshot, for fast lookups.
async function logEvent(
  toolId: string,
  toolName: string,
  action: string,
  person: string,
  note = "",
  dateISO?: string
) {
  const db = await eventsDb();
  await notion.pages.create({
    parent: { database_id: db },
    properties: {
      [EVENT_PROPS.event]: title(`${action}: ${toolName}${person ? ` → ${person}` : ""}`),
      [EVENT_PROPS.tool]: { relation: [{ id: toolId }] },
      [EVENT_PROPS.action]: { select: { name: action } },
      [EVENT_PROPS.person]: text(person),
      [EVENT_PROPS.date]: { date: { start: isISO(dateISO) ? dateISO! : todayPhoenix() } },
      [EVENT_PROPS.note]: text(note),
    },
  });
}

export async function GET(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "Server not configured." }, { status: 500 });
  const sp = req.nextUrl.searchParams;
  if (sp.get("ownerPin") !== OWNER_PIN)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    const action = sp.get("action");

    if (action === "all") {
      await ensureToolLocation();
      const [catalog, mats, tools] = await Promise.all([
        loadCatalog(),
        materialsDb().then((db) => queryAll(db)),
        toolsDb().then((db) => queryAll(db)),
      ]);
      return NextResponse.json({
        ok: true,
        catalog,
        yards: YARDS,
        toolLocations: TOOL_LOCATIONS,
        materials: mats.map(mapMaterial),
        tools: tools.map(mapTool),
      });
    }

    if (action === "history") {
      const toolId = sp.get("toolId") || "";
      if (!toolId) return NextResponse.json({ ok: false, error: "toolId required" }, { status: 400 });
      const db = await eventsDb();
      const rows = await queryAll(db, {
        property: EVENT_PROPS.tool,
        relation: { contains: toolId },
      });
      const events = rows
        .map((pg) => {
          const p = pg.properties || {};
          return {
            action: rt(p[EVENT_PROPS.action]),
            person: rt(p[EVENT_PROPS.person]),
            date: p[EVENT_PROPS.date]?.date?.start?.slice(0, 10) || "",
            note: rt(p[EVENT_PROPS.note]),
            created: pg.created_time,
          };
        })
        .sort((a, b) => b.created.localeCompare(a.created));
      return NextResponse.json({ ok: true, events });
    }

    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Failed." }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "Server not configured." }, { status: 500 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  if (body.ownerPin !== OWNER_PIN)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    const op = body.op;

    // --- Catalog: sizes and tool types, added from the app over time --------
    if (op === "add_catalog") {
      const name = (body.name || "").trim();
      const kind = body.kind;
      if (!name || !["Material", "Size", "Tool Type"].includes(kind))
        return NextResponse.json({ ok: false, error: "Name and kind required." }, { status: 400 });
      const cat = await loadCatalog();
      const parent = (body.parent || "").trim();
      // Refuse near-duplicates: the whole point of a picklist is one spelling.
      const dup = cat.find(
        (c) =>
          c.kind === kind &&
          c.name.toLowerCase().replace(/\s+/g, "") === name.toLowerCase().replace(/\s+/g, "") &&
          (kind !== "Size" || c.parent.toLowerCase() === parent.toLowerCase())
      );
      if (dup) return NextResponse.json({ ok: false, error: `"${dup.name}" already exists.` }, { status: 409 });
      const db = await catalogDb();
      await notion.pages.create({
        parent: { database_id: db },
        properties: {
          [CAT_PROPS.name]: title(name),
          [CAT_PROPS.kind]: { select: { name: kind } },
          [CAT_PROPS.parent]: text(kind === "Size" ? parent : ""),
          [CAT_PROPS.sized]: { checkbox: !!body.sized },
        },
      });
      return NextResponse.json({ ok: true });
    }

    // --- Materials ------------------------------------------------------------
    // Adding leftover to a material+size+yard that already has a row ADDS to
    // it, rather than creating a second row for the same pile.
    if (op === "add_material") {
      const material = (body.material || "").trim();
      const size = (body.size || "").trim();
      const yard = (body.yard || "").trim();
      const qty = Number(body.quantity);
      if (!material || !size || !yard || !Number.isFinite(qty) || qty <= 0)
        return NextResponse.json({ ok: false, error: "Material, size, yard and quantity required." }, { status: 400 });
      const db = await materialsDb();
      const rows = (await queryAll(db)).map(mapMaterial);
      const hit = rows.find(
        (r) =>
          r.material.toLowerCase() === material.toLowerCase() &&
          r.size.toLowerCase() === size.toLowerCase() &&
          r.yard === yard
      );
      if (hit) {
        await notion.pages.update({
          page_id: hit.id,
          properties: { [MAT_PROPS.quantity]: { number: hit.quantity + qty } },
        });
        return NextResponse.json({ ok: true, merged: true, quantity: hit.quantity + qty });
      }
      await notion.pages.create({
        parent: { database_id: db },
        properties: {
          [MAT_PROPS.item]: title(`${material} ${size} · ${yard}`),
          [MAT_PROPS.material]: text(material),
          [MAT_PROPS.size]: text(size),
          [MAT_PROPS.yard]: { select: { name: yard } },
          [MAT_PROPS.quantity]: { number: qty },
        },
      });
      return NextResponse.json({ ok: true, merged: false, quantity: qty });
    }

    // Eyeballed inventory: set the count directly. Zero archives the row, so an
    // empty pile doesn't sit in the list forever.
    if (op === "set_quantity") {
      const qty = Number(body.quantity);
      if (!body.id || !Number.isFinite(qty) || qty < 0)
        return NextResponse.json({ ok: false, error: "Quantity required." }, { status: 400 });
      if (qty === 0) {
        await notion.pages.update({ page_id: body.id, archived: true });
        return NextResponse.json({ ok: true, removed: true });
      }
      await notion.pages.update({
        page_id: body.id,
        properties: { [MAT_PROPS.quantity]: { number: qty } },
      });
      return NextResponse.json({ ok: true });
    }

    // --- Tools ----------------------------------------------------------------
    // Numbered automatically per type: the next Hickey Bar is one more than the
    // highest Hickey Bar number, so numbers are never reused after a loss.
    if (op === "add_tool") {
      const type = (body.type || "").trim();
      const size = (body.size || "").trim();
      if (!type) return NextResponse.json({ ok: false, error: "Tool type required." }, { status: 400 });
      const db = await toolsDb();
      const all = (await queryAll(db, { property: TOOL_PROPS.type, rich_text: { equals: type } })).map(mapTool);
      const next = all.reduce((m, t) => Math.max(m, t.number), 0) + 1;
      const name = `${type} #${next}`;
      // One step for the common backfill case: "Ramon has had Hickey Bar #2
      // since Sept 1". Either it goes to someone on a date, or it's stored
      // somewhere — never neither.
      const person = (body.person || "").trim();
      const dateISO = isISO(body.dateISO) ? body.dateISO : todayPhoenix();
      const location = (body.location || "").trim();
      await ensureToolLocation();
      const props: any = {
        [TOOL_PROPS.tool]: title(name),
        [TOOL_PROPS.type]: text(type),
        [TOOL_PROPS.number]: { number: next },
        [TOOL_PROPS.size]: text(size),
        [TOOL_PROPS.status]: { select: { name: person ? "Issued" : "In Yard" } },
        [TOOL_PROPS.holder]: text(person),
      };
      if (person) props[TOOL_PROPS.issued] = { date: { start: dateISO } };
      if (!person && location) props[TOOL_PROPS.location] = { select: { name: location } };
      const created: any = await notion.pages.create({ parent: { database_id: db }, properties: props });
      await logEvent(created.id, name, "Added", "", size ? `Size ${size}` : "", dateISO);
      if (person) await logEvent(created.id, name, "Issued", person, "", dateISO);
      return NextResponse.json({ ok: true, id: created.id, name, number: next });
    }

    if (op === "tool_action") {
      const { id, action } = body;
      const person = (body.person || "").trim();
      const valid = ["Issued", "Returned", "Broken", "Lost", "Found"];
      if (!id || !valid.includes(action))
        return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
      if (action === "Issued" && !person)
        return NextResponse.json({ ok: false, error: "Pick who it's going to." }, { status: 400 });

      const pg: any = await notion.pages.retrieve({ page_id: id });
      const t = mapTool(pg);
      const dateISO = isISO(body.dateISO) ? body.dateISO : todayPhoenix();
      const location = (body.location || "").trim();
      await ensureToolLocation();
      // Record who had it when it broke or went missing — that's the whole
      // reason for keeping history.
      await logEvent(
        id,
        t.tool,
        action,
        action === "Issued" ? person : t.holder,
        location ? `To ${location}` : (body.note || "").trim(),
        dateISO
      );

      const props: any = {};
      if (action === "Issued") {
        props[TOOL_PROPS.status] = { select: { name: "Issued" } };
        props[TOOL_PROPS.holder] = text(person);
        props[TOOL_PROPS.issued] = { date: { start: dateISO } };
      } else if (action === "Returned" || action === "Found") {
        props[TOOL_PROPS.status] = { select: { name: "In Yard" } };
        props[TOOL_PROPS.holder] = text("");
        props[TOOL_PROPS.issued] = { date: null };
        if (location) props[TOOL_PROPS.location] = { select: { name: location } };
      } else {
        props[TOOL_PROPS.status] = { select: { name: action } };
      }
      await notion.pages.update({ page_id: id, properties: props });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Unknown op." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Failed." }, { status: 502 });
  }
}
