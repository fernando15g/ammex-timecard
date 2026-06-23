import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  CREW_ROSTER_DB_ID,
  ROSTER_PROPS,
} from "@/lib/notion";

// Reads the crew roster: every worker whose "Active" checkbox is checked.
// Returns two lists:
//   workers  - all active names (for the crew picker)
//   foremen  - active names whose Role is "Foreman" (for the "who are you?" screen)

export const dynamic = "force-dynamic"; // always fetch fresh roster

// Pull a plain-text value from either a Select or a Text (rich_text) property,
// so it works whichever type "Role" happens to be in Notion.
function readRole(prop: any): string {
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "rich_text")
    return prop.rich_text?.map((t: any) => t.plain_text).join("") || "";
  if (prop.type === "multi_select")
    return (prop.multi_select || []).map((s: any) => s.name).join(", ");
  return "";
}

export async function GET() {
  if (!NOTION_TOKEN) {
    return NextResponse.json(
      { error: "Server not configured (missing Notion token)." },
      { status: 500 }
    );
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    const workers: string[] = [];
    const foremen: string[] = [];
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
        const title =
          titleProp?.title?.map((t: any) => t.plain_text).join("") || "";
        const name = title.trim();
        if (!name) continue;

        workers.push(name);

        const role = readRole(page.properties?.[ROSTER_PROPS.role]).toLowerCase();
        if (role.includes("foreman")) foremen.push(name);
      }

      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    const sorter = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });
    workers.sort(sorter);
    foremen.sort(sorter);

    return NextResponse.json({ workers, foremen });
  } catch (err: any) {
    console.error("Roster read failed:", err?.message || err);
    return NextResponse.json(
      { error: "Could not read the crew roster." },
      { status: 502 }
    );
  }
}
