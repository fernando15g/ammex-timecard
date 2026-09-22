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
    // name -> nicknames / known misspellings. Returned alongside the plain
    // `workers` list rather than replacing it, so every existing caller is
    // unaffected.
    const aliases: Record<string, string[]> = {};
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

        const rawAliases = page.properties?.[ROSTER_PROPS.aliases];
        const aliasText =
          (rawAliases?.rich_text || []).map((t: any) => t.plain_text).join("") || "";
        const list = aliasText
          .split(/[,;\n]/)
          .map((a: string) => a.trim())
          .filter(Boolean);
        if (list.length) aliases[name] = list;

        const role = readRole(page.properties?.[ROSTER_PROPS.role]).toLowerCase();
        if (role.includes("foreman")) foremen.push(name);
      }

      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    const sorter = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });
    workers.sort(sorter);
    foremen.sort(sorter);

    // Inactive rows, read separately. Phones remember yesterday's crew and start
    // today's card with the same names, so a merged or departed name can keep
    // coming back from the phone itself without ever going through the picker.
    // These two lists let the app correct that on the phone:
    //   merged   — old name → the real person, from "Merged into …" status
    //   inactive — deactivated and NOT merged or pending: someone who left
    // "Unconfirmed" rows are deliberately in neither: those are new workers a
    // foreman added who are waiting on the owner, not people who are gone.
    const merged: Record<string, string> = {};
    const inactive: string[] = [];
    try {
      let icur: string | undefined = undefined;
      do {
        const ires: any = await notion.databases.query({
          database_id: CREW_ROSTER_DB_ID,
          filter: { property: ROSTER_PROPS.active, checkbox: { equals: false } },
          start_cursor: icur,
          page_size: 100,
        });
        for (const page of ires.results) {
          const name = (page.properties?.[ROSTER_PROPS.name]?.title || [])
            .map((t: any) => t.plain_text)
            .join("")
            .trim();
          if (!name) continue;
          const status = (page.properties?.[ROSTER_PROPS.status]?.rich_text || [])
            .map((t: any) => t.plain_text)
            .join("")
            .trim();
          const m = status.match(/^merged into\s+(.+)$/i);
          if (m) merged[name.toLowerCase()] = m[1].trim();
          else if (!/^unconfirmed/i.test(status)) inactive.push(name);
        }
        icur = ires.has_more ? ires.next_cursor : undefined;
      } while (icur);
    } catch {
      /* additive — the active list is what matters; never block on this */
    }

    return NextResponse.json({ workers, foremen, aliases, merged, inactive });
  } catch (err: any) {
    console.error("Roster read failed:", err?.message || err);
    return NextResponse.json(
      { error: "Could not read the crew roster." },
      { status: 502 }
    );
  }
}
