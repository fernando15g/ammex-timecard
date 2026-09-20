import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { NOTION_TOKEN } from "@/lib/notion";
import {
  topicsDbId,
  formsDbId,
  TOPIC_PROPS,
  FORM_PROPS,
  DEFAULT_TOPICS_2026,
  mondayOf,
  weekNumberFor,
} from "@/lib/safety";

// Safety toolbox-talk forms.
//
// Foremen photograph the signed sheet and upload it; the owner can also upload
// on a foreman's behalf when one gets texted to him. Files go to a PRIVATE
// Supabase bucket — nothing is reachable by URL, and viewing goes through
// short-lived signed links minted here.
//
// Foreman writes are gated by the same PIN check the rest of their app uses.
// Owner-only reads (the folder view) are gated by the owner PIN.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const notion = new Client({ auth: NOTION_TOKEN });
const OWNER_PIN = "5314";
const BUCKET = "safety";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SB_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function rt(prop: any): string {
  if (!prop) return "";
  if (prop.type === "rich_text")
    return (prop.rich_text || []).map((t: any) => t.plain_text).join("");
  if (prop.type === "title")
    return (prop.title || []).map((t: any) => t.plain_text).join("");
  return "";
}

function isISO(s: any): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Safe for a storage path: no spaces, slashes or accents.
function slug(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// --- Topics -----------------------------------------------------------------

type Topic = { id?: string; week: number; en: string; es: string };

async function loadTopics(year: number): Promise<Topic[]> {
  const db = await topicsDbId();
  const out: Topic[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: db,
      filter: { property: TOPIC_PROPS.year, number: { equals: year } },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const pg of res.results) {
      const p = pg.properties || {};
      out.push({
        id: pg.id,
        week: p[TOPIC_PROPS.week]?.number || 0,
        en: rt(p[TOPIC_PROPS.name]),
        es: rt(p[TOPIC_PROPS.spanish]),
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  out.sort((a, b) => a.week - b.week);
  return out;
}

// Seed a year from the shipped 2026 list. Only ever runs when a year has no
// rows at all, so it can't overwrite a schedule the owner has edited.
async function seedTopics(year: number): Promise<Topic[]> {
  const db = await topicsDbId();
  for (const t of DEFAULT_TOPICS_2026) {
    await notion.pages.create({
      parent: { database_id: db },
      properties: {
        [TOPIC_PROPS.name]: { title: [{ text: { content: t.en } }] },
        [TOPIC_PROPS.spanish]: { rich_text: [{ text: { content: t.es } }] },
        [TOPIC_PROPS.year]: { number: year },
        [TOPIC_PROPS.week]: { number: t.week },
      },
    });
  }
  return loadTopics(year);
}

async function topicFor(dateISO: string): Promise<{ week: number; en: string; es: string } | null> {
  const { year, week } = weekNumberFor(dateISO);
  let topics = await loadTopics(year);
  if (topics.length === 0) topics = await seedTopics(year);
  const hit = topics.find((t) => t.week === week);
  return hit ? { week, en: hit.en, es: hit.es } : null;
}

// --- Storage ----------------------------------------------------------------

async function uploadToBucket(path: string, bytes: Buffer, contentType: string) {
  const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SB_SECRET}`,
      apikey: SB_SECRET,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
}

// Short-lived link. The bucket is private, so this is the only way a file is
// ever viewable, and the link dies on its own.
async function signUrl(path: string, download = false): Promise<string> {
  const res = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SB_SECRET}`,
      apikey: SB_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return "";
  const d: any = await res.json();
  const suffix = download ? `&download=${encodeURIComponent(path.split("/").pop() || "form.jpg")}` : "";
  return `${SB_URL}/storage/v1${d.signedURL}${suffix}`;
}

// --- Handlers ---------------------------------------------------------------

export async function GET(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "Server not configured." }, { status: 500 });
  const sp = req.nextUrl.searchParams;
  const action = sp.get("action");

  try {
    // This week's topic — shown to the foreman BEFORE the camera opens so he
    // writes it on the paper. Nobody picks it, so nobody picks it wrong.
    if (action === "topic") {
      const dateISO = isISO(sp.get("date")) ? sp.get("date")! : new Date().toISOString().slice(0, 10);
      const t = await topicFor(dateISO);
      return NextResponse.json({ ok: true, monday: mondayOf(dateISO), topic: t });
    }

    // Full list for the foreman's "different topic" picker. No PIN: it's the
    // same schedule printed on the sheet in his hand, not private data.
    if (action === "topic_list") {
      const year = Number(sp.get("year")) || new Date().getFullYear();
      let topics = await loadTopics(year);
      if (topics.length === 0) topics = await seedTopics(year);
      return NextResponse.json({ ok: true, topics });
    }

    if (action === "topics") {
      if (sp.get("ownerPin") !== OWNER_PIN)
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      const year = Number(sp.get("year")) || new Date().getFullYear();
      let topics = await loadTopics(year);
      if (topics.length === 0) topics = await seedTopics(year);
      return NextResponse.json({ ok: true, year, topics });
    }

    // Everything below is the owner's folder view.
    if (sp.get("ownerPin") !== OWNER_PIN)
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    if (action === "forms") {
      const db = await formsDbId();
      const foreman = (sp.get("foreman") || "").trim();
      const start = sp.get("start");
      const end = sp.get("end");
      const and: any[] = [{ property: FORM_PROPS.voided, checkbox: { equals: false } }];
      if (isISO(start)) and.push({ property: FORM_PROPS.date, date: { on_or_after: start } });
      if (isISO(end)) and.push({ property: FORM_PROPS.date, date: { on_or_before: end } });

      const forms: any[] = [];
      let cursor: string | undefined;
      do {
        const res: any = await notion.databases.query({
          database_id: db,
          filter: { and },
          start_cursor: cursor,
          page_size: 100,
        });
        for (const pg of res.results) {
          const p = pg.properties || {};
          const fm = rt(p[FORM_PROPS.foreman]);
          if (foreman && fm.toLowerCase() !== foreman.toLowerCase()) continue;
          forms.push({
            id: pg.id,
            date: p[FORM_PROPS.date]?.date?.start?.slice(0, 10) || "",
            foreman: fm,
            topic: rt(p[FORM_PROPS.topic]),
            week: p[FORM_PROPS.topicWeek]?.number || 0,
            path: rt(p[FORM_PROPS.path]),
            uploadedBy: rt(p[FORM_PROPS.uploadedBy]),
          });
        }
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);
      forms.sort((a, b) => b.date.localeCompare(a.date));
      return NextResponse.json({ ok: true, forms });
    }

    if (action === "view") {
      const path = sp.get("path") || "";
      if (!path) return NextResponse.json({ ok: false, error: "path required" }, { status: 400 });
      const url = await signUrl(path, sp.get("download") === "1");
      if (!url) return NextResponse.json({ ok: false, error: "Could not open that file." }, { status: 502 });
      return NextResponse.json({ ok: true, url });
    }

    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Failed." }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "Server not configured." }, { status: 500 });
  if (!SB_URL || !SB_SECRET)
    return NextResponse.json(
      { ok: false, error: "Storage not configured — SUPABASE_SERVICE_ROLE_KEY is missing." },
      { status: 500 }
    );

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  try {
    if (body.op === "set_topic") {
      if (body.ownerPin !== OWNER_PIN)
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      if (!body.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      const props: any = {};
      if (typeof body.en === "string")
        props[TOPIC_PROPS.name] = { title: [{ text: { content: body.en.trim() } }] };
      if (typeof body.es === "string")
        props[TOPIC_PROPS.spanish] = {
          rich_text: body.es.trim() ? [{ text: { content: body.es.trim() } }] : [],
        };
      await notion.pages.update({ page_id: body.id, properties: props });
      return NextResponse.json({ ok: true });
    }

    // Owner-only, and a real delete rather than a void: an accidental photo —
    // somebody's boot, or worse — is worth removing outright, and there's
    // nothing about it worth keeping for the record.
    if (body.op === "delete") {
      if (body.ownerPin !== OWNER_PIN)
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      if (!body.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      if (body.path) {
        try {
          await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${body.path}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${SB_SECRET}`, apikey: SB_SECRET },
          });
        } catch { /* remove the row regardless — a stranded file is the lesser problem */ }
      }
      await notion.pages.update({ page_id: body.id, archived: true });
      return NextResponse.json({ ok: true });
    }

    if (body.op !== "upload")
      return NextResponse.json({ ok: false, error: "Unknown op." }, { status: 400 });

    // Either the owner (uploading on someone's behalf) or the foreman himself.
    const byOwner = body.ownerPin === OWNER_PIN;
    const foreman = (body.foreman || "").trim();
    if (!foreman)
      return NextResponse.json({ ok: false, error: "Foreman required." }, { status: 400 });
    if (!byOwner && !body.foremanPin)
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const dateISO = isISO(body.dateISO) ? body.dateISO : new Date().toISOString().slice(0, 10);
    const monday = mondayOf(dateISO);
    const { year, week } = weekNumberFor(monday);
    const auto = await topicFor(monday);
    // The scheduled topic is the default, but a crew sometimes covers something
    // else — an override is recorded as given rather than quietly replaced.
    const overrideEn = (body.topicEn || "").trim();
    const overrideWeek = Number(body.topicWeek);
    const topic = overrideEn
      ? { week: Number.isFinite(overrideWeek) && overrideWeek > 0 ? overrideWeek : 0, en: overrideEn, es: (body.topicEs || "").trim() }
      : auto;

    const b64 = (body.imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
    if (!b64) return NextResponse.json({ ok: false, error: "No photo." }, { status: 400 });
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > 12 * 1024 * 1024)
      return NextResponse.json({ ok: false, error: "That photo is too large." }, { status: 413 });

    // An off-schedule talk overrides the week's topic on the record and in the
    // filename; the week number still reflects when it was signed.
    const custom = (body.customTopic || "").trim();
    const topicLabel = custom || topic?.en || `Week ${week}`;
    const fileName = `${monday}_${slug(foreman)}_${slug(topicLabel)}.jpg`;
    const path = `${year}/${slug(foreman)}/${fileName}`;
    await uploadToBucket(path, bytes, "image/jpeg");

    const db = await formsDbId();

    // A second upload for the same foreman and week is a REPLACEMENT — the
    // storage path is identical so the image overwrites, and without this the
    // old row would linger pointing at the new photo. Almost always means the
    // first one was blurry or wrong.
    try {
      let dupCursor: string | undefined;
      do {
        const dupes: any = await notion.databases.query({
          database_id: db,
          filter: {
            and: [
              { property: FORM_PROPS.date, date: { equals: monday } },
              { property: FORM_PROPS.voided, checkbox: { equals: false } },
            ],
          },
          start_cursor: dupCursor,
          page_size: 100,
        });
        for (const pg of dupes.results) {
          const fm = rt(pg.properties?.[FORM_PROPS.foreman]).trim().toLowerCase();
          if (fm !== foreman.toLowerCase()) continue;
          await notion.pages.update({
            page_id: pg.id,
            properties: { [FORM_PROPS.voided]: { checkbox: true } },
          });
        }
        dupCursor = dupes.has_more ? dupes.next_cursor : undefined;
      } while (dupCursor);
    } catch { /* a duplicate row is better than a failed upload */ }

    const created: any = await notion.pages.create({
      parent: { database_id: db },
      properties: {
        [FORM_PROPS.title]: { title: [{ text: { content: `${monday} — ${foreman}` } }] },
        [FORM_PROPS.date]: { date: { start: monday } },
        [FORM_PROPS.foreman]: { rich_text: [{ text: { content: foreman } }] },
        [FORM_PROPS.topic]: {
          rich_text: [{ text: { content: topicLabel } }],
        },
        [FORM_PROPS.topicWeek]: { number: topic?.week || week },
        [FORM_PROPS.path]: { rich_text: [{ text: { content: path } }] },
        [FORM_PROPS.uploadedBy]: {
          rich_text: [{ text: { content: byOwner ? "Owner" : foreman } }],
        },
        [FORM_PROPS.voided]: { checkbox: false },
      },
    });

    return NextResponse.json({ ok: true, id: created.id, path, monday, topic, custom });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Upload failed." }, { status: 502 });
  }
}
