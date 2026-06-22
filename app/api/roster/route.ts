import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  CREW_ROSTER_DB_ID,
  ROSTER_PROPS,
} from "@/lib/notion";

// Reads the crew roster: every worker whose "Active" checkbox is checked.
// Returns a simple list of names for the picker.

export const dynamic = "force-dynamic"; // always fetch fresh roster

export async function GET() {
  if (!NOTION_TOKEN) {
    return NextResponse.json(
      { error: "Server not configured (missing Notion token)." },
      { status: 500 }
    );
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    const names: string[] = [];
    let cursor: string | undefined = undefined;

    do {
      const res: any = await notion.databases.query({
        database_id: CREW_ROSTER_DB_ID,
        filter: {
          property: ROSTER_PROPS.active,
          checkbox: { equals: true },
        },
        start_cursor: cursor,
        page_size: 100,
      });

      for (const page of res.results) {
        const titleProp = page.properties?.[ROSTER_PROPS.name];
        const title = titleProp?.title?.map((t: any) => t.plain_text).join("") || "";
        const name = title.trim();
        if (name) names.push(name);
      }

      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    // Sort alphabetically, case-insensitive
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    return NextResponse.json({ workers: names });
  } catch (err: any) {
    console.error("Roster read failed:", err?.message || err);
    return NextResponse.json(
      { error: "Could not read the crew roster." },
      { status: 502 }
    );
  }
}
