import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  PROJECTS_DB_ID,
  PROJECT_PROPS,
  SCHEDULABLE_STATUSES,
} from "@/lib/notion";

export const dynamic = "force-dynamic";

// Returns the list of schedulable jobs (active-ish statuses) for the Schedule
// "Add job" picker. Read-only against the Projects database.
export async function GET() {
  if (!NOTION_TOKEN) {
    return NextResponse.json({ error: "NOTION_TOKEN not set" }, { status: 500 });
  }
  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    const jobs: { id: string; name: string; jobId: string; status: string }[] = [];
    let cursor: string | undefined = undefined;

    do {
      const resp: any = await notion.databases.query({
        database_id: PROJECTS_DB_ID,
        start_cursor: cursor,
        page_size: 100,
        filter: {
          or: SCHEDULABLE_STATUSES.map((s) => ({
            property: PROJECT_PROPS.status,
            status: { equals: s },
          })),
        },
      });

      for (const pg of resp.results) {
        const props = pg.properties || {};
        const nameProp = props[PROJECT_PROPS.name];
        const name =
          (nameProp?.title || []).map((t: any) => t.plain_text).join("") || "";
        const idProp = props[PROJECT_PROPS.jobId];
        const jobId =
          (idProp?.rich_text || []).map((t: any) => t.plain_text).join("") || "";
        const status = props[PROJECT_PROPS.status]?.status?.name || "";
        if (name) {
          jobs.push({ id: pg.id, name, jobId, status });
        }
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    // Sort by Job ID when present, else by name.
    jobs.sort((a, b) =>
      (a.jobId || a.name).localeCompare(b.jobId || b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );

    return NextResponse.json({ jobs });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to load jobs" },
      { status: 502 }
    );
  }
}
