import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { NOTION_TOKEN } from "@/lib/notion";

// Read-only diagnostic: hit /api/notion-check?db=<DATABASE_ID>&pin=<PIN> to
// confirm the integration can reach a database and see its property names/types
// plus sample rows. PIN-gated so it isn't an open endpoint. Pure read.
const DIAG_PIN = "5314";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("pin")?.trim() !== DIAG_PIN) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Name inspector: /api/notion-check?names=<search>&db=<timecards_db>&pin=5314
  // Lists every DISTINCT worker-name string on timecards matching the search,
  // with exact length + per-character unicode codes, so we can see precisely
  // how two "identical looking" names differ (accent, hidden char, etc.).
  const nameSearch = req.nextUrl.searchParams.get("names")?.trim();
  if (nameSearch) {
    const db = req.nextUrl.searchParams.get("db")?.trim();
    if (!db) return NextResponse.json({ ok: false, error: "Pass ?db=<timecards_db>" }, { status: 400 });
    if (!NOTION_TOKEN) return NextResponse.json({ ok: false, error: "NOTION_TOKEN not set" }, { status: 500 });
    const notion = new Client({ auth: NOTION_TOKEN });
    try {
      const seen = new Map<string, number>(); // raw name -> count
      let cursor: string | undefined;
      do {
        const res: any = await notion.databases.query({
          database_id: db, start_cursor: cursor, page_size: 100,
        });
        for (const pg of res.results) {
          const p = pg.properties || {};
          // find the title property (Worker)
          let raw = "";
          for (const v of Object.values<any>(p)) {
            if (v?.type === "title") { raw = (v.title || []).map((t: any) => t.plain_text).join(""); break; }
          }
          if (raw.toLowerCase().includes(nameSearch.toLowerCase())) {
            seen.set(raw, (seen.get(raw) || 0) + 1);
          }
        }
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);

      const variants = Array.from(seen.entries()).map(([raw, count]) => ({
        display: raw,
        count,
        length: raw.length,
        codes: Array.from(raw).map((ch) => ch.charCodeAt(0)),
        normalized: raw.replace(/\s+/g, " ").trim(),
      }));
      return NextResponse.json({ ok: true, search: nameSearch, distinctVariants: variants.length, variants });
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 502 });
    }
  }

  const db = req.nextUrl.searchParams.get("db")?.trim();
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "Pass ?db=<database_id>" },
      { status: 400 }
    );
  }
  if (!NOTION_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "NOTION_TOKEN not set in environment" },
      { status: 500 }
    );
  }

  const notion = new Client({ auth: NOTION_TOKEN });
  try {
    // 1) Read the database schema (property names + types).
    const meta: any = await notion.databases.retrieve({ database_id: db });
    const title =
      (meta.title || []).map((t: any) => t.plain_text).join("") || "(untitled)";
    const props: Record<string, string> = {};
    for (const [name, p] of Object.entries<any>(meta.properties || {})) {
      props[name] = p.type;
      // For status/select, also list the available option names.
      if (p.type === "status" && p.status?.options) {
        props[name] = `status: [${p.status.options.map((o: any) => o.name).join(", ")}]`;
      }
      if (p.type === "select" && p.select?.options) {
        props[name] = `select: [${p.select.options.map((o: any) => o.name).join(", ")}]`;
      }
    }

    // 2) Pull a few sample rows so we can see real values.
    const q: any = await notion.databases.query({
      database_id: db,
      page_size: 3,
    });
    const sample = q.results.map((pg: any) => {
      const row: Record<string, any> = {};
      for (const [name, p] of Object.entries<any>(pg.properties || {})) {
        if (p.type === "title")
          row[name] = (p.title || []).map((t: any) => t.plain_text).join("");
        else if (p.type === "rich_text")
          row[name] = (p.rich_text || []).map((t: any) => t.plain_text).join("");
        else if (p.type === "status") row[name] = p.status?.name || null;
        else if (p.type === "select") row[name] = p.select?.name || null;
        else if (p.type === "date") row[name] = p.date?.start || null;
        else if (p.type === "checkbox") row[name] = p.checkbox;
        else if (p.type === "number") row[name] = p.number;
        else if (p.type === "relation") row[name] = `relation(${(p.relation || []).length})`;
        else row[name] = `(${p.type})`;
      }
      return row;
    });

    return NextResponse.json({
      ok: true,
      database: title,
      databaseId: db,
      properties: props,
      sampleRows: sample,
      rowCount: q.results.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || String(err),
        hint:
          "If this says 'Could not find database' or 'unauthorized', the database ID is wrong OR the 'Ammex Timesheet App' integration isn't connected to it (open the DB → ... → Connections).",
      },
      { status: 502 }
    );
  }
}
