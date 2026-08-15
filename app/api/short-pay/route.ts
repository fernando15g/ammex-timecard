import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  TIMECARDS_DB_ID,
  TIMECARD_PROPS,
} from "@/lib/notion";

// Short Pay — owner-only. Records hours a worker was shorted on a card that has
// already been paid, so they ride the CURRENT paycheck without rewriting the
// closed week.
//
// A short pay entry is an ordinary Timecard row: real worker, real hours, the
// date the work actually happened, and the real project relation — so job
// totals and production rates correct themselves with no special math. The two
// extra fields only affect payroll:
//
//   Short Pay (checkbox) — marks it as a correction so it lists separately
//   Pay Week (date)      — Monday of the week that PAYS it
//
// Nothing double-pays: the payroll grid pays rows by Date, short pay rows are
// paid by Pay Week, and no row is ever picked up by both rules.
//
// Foreman is deliberately left blank. That keeps these rows out of every
// foreman's "My submissions" and out of foreman-filtered reports — the foreman
// didn't submit it, and showing him hours he never turned in would confuse the
// confirmation he's being asked for.

export const dynamic = "force-dynamic";

const notion = new Client({ auth: NOTION_TOKEN });
const OWNER_PIN = "5314";

function ownerOk(pin: string | null | undefined): boolean {
  return (pin || "").trim() === OWNER_PIN;
}

function rt(prop: any): string {
  if (!prop) return "";
  if (prop.type === "rich_text")
    return (prop.rich_text || []).map((t: any) => t.plain_text).join("");
  if (prop.type === "title")
    return (prop.title || []).map((t: any) => t.plain_text).join("");
  return "";
}

function relationIds(prop: any): string[] {
  if (!prop) return [];
  if (prop.type === "relation") return (prop.relation || []).map((r: any) => r.id);
  if (prop.type === "rollup" && prop.rollup?.type === "array") {
    const out: string[] = [];
    for (const sub of prop.rollup.array || []) {
      if (sub?.type === "relation") for (const r of sub.relation || []) out.push(r.id);
    }
    return out;
  }
  return [];
}

function isISO(s: any): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Ensure the two properties exist. Additive only — never renames or removes
// anything, so the owner platform that reads this database is unaffected.
let ensured = false;
async function ensureProps(): Promise<void> {
  if (ensured) return;
  const db: any = await notion.databases.retrieve({ database_id: TIMECARDS_DB_ID });
  const add: any = {};
  if (!db.properties?.[TIMECARD_PROPS.shortPay])
    add[TIMECARD_PROPS.shortPay] = { checkbox: {} };
  if (!db.properties?.[TIMECARD_PROPS.payWeek]) add[TIMECARD_PROPS.payWeek] = { date: {} };
  if (Object.keys(add).length) {
    await notion.databases.update({
      database_id: TIMECARDS_DB_ID,
      properties: add as any,
    });
  }
  ensured = true;
}

// GET ?ownerPin=&start=&end= — short pay entries PAID in that span.
export async function GET(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "Server not configured." }, { status: 500 });
  const sp = req.nextUrl.searchParams;
  if (!ownerOk(sp.get("ownerPin")))
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const start = sp.get("start") || "";
  const end = sp.get("end") || "";
  if (!isISO(start) || !isISO(end))
    return NextResponse.json({ ok: false, error: "start and end required" }, { status: 400 });

  try {
    await ensureProps();
    const raw: any[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: TIMECARDS_DB_ID,
        filter: {
          and: [
            { property: TIMECARD_PROPS.shortPay, checkbox: { equals: true } },
            { property: TIMECARD_PROPS.payWeek, date: { on_or_after: start } },
            { property: TIMECARD_PROPS.payWeek, date: { on_or_before: end } },
            { property: TIMECARD_PROPS.voided, checkbox: { equals: false } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      });
      raw.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    const entries = raw.map((pg: any) => {
      const p = pg.properties || {};
      return {
        id: pg.id,
        worker: rt(p[TIMECARD_PROPS.worker]),
        dateISO: p[TIMECARD_PROPS.date]?.date?.start?.slice(0, 10) || "",
        payWeekISO: p[TIMECARD_PROPS.payWeek]?.date?.start?.slice(0, 10) || "",
        hours: p[TIMECARD_PROPS.hours]?.number || 0,
        job: rt(p[TIMECARD_PROPS.projectHelper]) || rt(p[TIMECARD_PROPS.job]),
        jobId: rt(p[TIMECARD_PROPS.jobIdHelper]),
        reason: rt(p[TIMECARD_PROPS.notes]),
      };
    });
    entries.sort((a, b) => a.worker.localeCompare(b.worker) || a.dateISO.localeCompare(b.dateISO));
    return NextResponse.json({ ok: true, entries });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Could not read short pay entries." },
      { status: 502 }
    );
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
  if (!ownerOk(body.ownerPin))
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    if (body.op === "add") {
      const worker = (body.worker || "").trim();
      const hours = Number(body.hours);
      const payWeek = body.payWeek;
      // Date shorted is optional — a worker often can't recall it. When it's
      // missing the row is dated to the pay week so it still lands somewhere
      // real, and the note says the original date was unknown.
      const dateISO = isISO(body.dateISO) ? body.dateISO : payWeek;

      if (!worker)
        return NextResponse.json({ ok: false, error: "Pick a worker." }, { status: 400 });
      if (!Number.isFinite(hours) || hours <= 0)
        return NextResponse.json({ ok: false, error: "Hours must be greater than zero." }, { status: 400 });
      if (!isISO(payWeek))
        return NextResponse.json({ ok: false, error: "Pay week is required." }, { status: 400 });

      await ensureProps();

      const reason = (body.reason || "").trim();
      const note = isISO(body.dateISO)
        ? reason
        : [reason, "(original date not known)"].filter(Boolean).join(" ");

      const props: any = {
        [TIMECARD_PROPS.worker]: { title: [{ text: { content: worker } }] },
        [TIMECARD_PROPS.date]: { date: { start: dateISO } },
        [TIMECARD_PROPS.hours]: { number: hours },
        [TIMECARD_PROPS.shortPay]: { checkbox: true },
        [TIMECARD_PROPS.payWeek]: { date: { start: payWeek } },
        [TIMECARD_PROPS.notes]: {
          rich_text: note ? [{ text: { content: note } }] : [],
        },
      };
      // Project relation drives the clean name AND the Job ID rollup, exactly
      // like a card the owner has already reconciled.
      if (body.projectId) {
        props[TIMECARD_PROPS.projectHelper] = { relation: [{ id: body.projectId }] };
      }
      if ((body.jobText || "").trim()) {
        props[TIMECARD_PROPS.job] = {
          rich_text: [{ text: { content: (body.jobText || "").trim() } }],
        };
      }

      const created: any = await notion.pages.create({
        parent: { database_id: TIMECARDS_DB_ID },
        properties: props,
      });
      return NextResponse.json({ ok: true, id: created.id });
    }

    if (body.op === "void") {
      // Void-not-delete, same as everywhere else in the app.
      if (!body.id)
        return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      await notion.pages.update({
        page_id: body.id,
        properties: {
          [TIMECARD_PROPS.voided]: { checkbox: true },
          [TIMECARD_PROPS.voidNote]: {
            rich_text: [{ text: { content: "Short pay entry removed by owner" } }],
          },
        },
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Unknown op." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Could not save the short pay entry." },
      { status: 502 }
    );
  }
}
