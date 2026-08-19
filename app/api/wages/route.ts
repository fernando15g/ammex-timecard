import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { Resend } from "resend";
import { NOTION_TOKEN, WAGES_DB_ID, WAGE_PROPS } from "@/lib/notion";
import { buildWageNoticePdf } from "@/lib/wage-pdf";

// Wage increase tracker — OWNER ONLY.
//
// Every request is verified against Supabase server-side: the caller sends
// their access token, we ask Supabase who it belongs to, and the email must be
// on the allow-list. Unlike the rest of the admin area there is NO PIN
// fallback here — the PIN lives in the public JavaScript bundle, which is fine
// for scheduling and reconciliation but not for wage records. If Supabase is
// unreachable this section is simply unavailable, which is the correct
// trade-off for this data.
//
// Rows are append-only. Correcting a mistake means voiding the row and adding
// a new one, so the history stays honest — that record is the whole point.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const notion = new Client({ auth: NOTION_TOKEN });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const OWNER_EMAILS = (process.env.OWNER_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const RECIPIENT = "fernando@ammexrebar.com";
const FROM = "Ammex Timecard <timecards@send.ammexrebar.com>";

function rt(prop: any): string {
  if (!prop) return "";
  if (prop.type === "rich_text")
    return (prop.rich_text || []).map((t: any) => t.plain_text).join("");
  if (prop.type === "title")
    return (prop.title || []).map((t: any) => t.plain_text).join("");
  if (prop.type === "select") return prop.select?.name || "";
  return "";
}

function nkey(s: string): string {
  return (s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function isISO(s: any): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Verify the bearer token with Supabase and check the allow-list.
async function ownerFromToken(req: NextRequest): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY },
    });
    if (!res.ok) return null;
    const user: any = await res.json();
    const email = (user?.email || "").toLowerCase();
    if (!email) return null;
    // Empty allow-list means any authenticated user — but signups are disabled
    // in Supabase, so the only accounts that exist are ones the owner created.
    if (OWNER_EMAILS.length && !OWNER_EMAILS.includes(email)) return null;
    return email;
  } catch {
    return null;
  }
}

type Row = {
  id: string;
  worker: string;
  effectiveISO: string;
  previousRate: number | null;
  newRate: number;
  rateUnit: string;
  reason: string;
  issuedISO: string;
};

async function allRows(): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: WAGES_DB_ID,
      filter: { property: WAGE_PROPS.voided, checkbox: { equals: false } },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const pg of res.results) {
      const p = pg.properties || {};
      const worker = rt(p[WAGE_PROPS.worker]).trim();
      if (!worker) continue;
      out.push({
        id: pg.id,
        worker,
        effectiveISO: p[WAGE_PROPS.effective]?.date?.start?.slice(0, 10) || "",
        previousRate:
          typeof p[WAGE_PROPS.previousRate]?.number === "number"
            ? p[WAGE_PROPS.previousRate].number
            : null,
        newRate:
          typeof p[WAGE_PROPS.newRate]?.number === "number"
            ? p[WAGE_PROPS.newRate].number
            : 0,
        rateUnit: rt(p[WAGE_PROPS.rateUnit]) || "Hourly",
        reason: rt(p[WAGE_PROPS.reason]),
        issuedISO: p[WAGE_PROPS.issued]?.date?.start?.slice(0, 10) || "",
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  // Newest effective date first
  out.sort((a, b) => b.effectiveISO.localeCompare(a.effectiveISO));
  return out;
}

// GET — current rate per worker, plus one worker's full history on request.
export async function GET(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "Server not configured." }, { status: 500 });
  const owner = await ownerFromToken(req);
  if (!owner)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    const rows = await allRows();
    const worker = (req.nextUrl.searchParams.get("worker") || "").trim();
    if (worker) {
      const mine = rows.filter((r) => nkey(r.worker) === nkey(worker));
      return NextResponse.json({ ok: true, history: mine });
    }
    // Current rate = most recent row per worker.
    const current = new Map<string, Row>();
    for (const r of rows) {
      if (!current.has(nkey(r.worker))) current.set(nkey(r.worker), r);
    }
    return NextResponse.json({
      ok: true,
      current: Array.from(current.values()).map((r) => ({
        worker: r.worker,
        rate: r.newRate,
        rateUnit: r.rateUnit,
        effectiveISO: r.effectiveISO,
      })),
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Could not read wages." },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!NOTION_TOKEN)
    return NextResponse.json({ ok: false, error: "Server not configured." }, { status: 500 });
  const owner = await ownerFromToken(req);
  if (!owner)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  try {
    if (body.op === "void") {
      if (!body.id)
        return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      await notion.pages.update({
        page_id: body.id,
        properties: {
          [WAGE_PROPS.voided]: { checkbox: true },
          [WAGE_PROPS.voidNote]: {
            rich_text: [{ text: { content: (body.note || "Removed by owner").slice(0, 200) } }],
          },
        },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.op !== "issue")
      return NextResponse.json({ ok: false, error: "Unknown op." }, { status: 400 });

    const worker = (body.worker || "").trim();
    const newRate = Number(body.newRate);
    const previousRate =
      body.previousRate === null || body.previousRate === "" || body.previousRate === undefined
        ? null
        : Number(body.previousRate);
    const effectiveISO = body.effectiveISO;
    const hourly = body.rateUnit !== "Salary";
    const lang = body.lang === "en" ? "en" : "es";
    const mode = body.mode === "view" ? "view" : "both";

    if (!worker)
      return NextResponse.json({ ok: false, error: "Pick a worker." }, { status: 400 });
    if (!Number.isFinite(newRate) || newRate <= 0)
      return NextResponse.json({ ok: false, error: "Enter the new pay." }, { status: 400 });
    if (!isISO(effectiveISO))
      return NextResponse.json({ ok: false, error: "Pick an effective date." }, { status: 400 });
    if (previousRate !== null && (!Number.isFinite(previousRate) || previousRate < 0))
      return NextResponse.json({ ok: false, error: "Previous pay looks wrong." }, { status: 400 });

    const now = new Date();
    const issuedISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // 1) Record it. Append-only — never edits an earlier row.
    const props: any = {
      [WAGE_PROPS.worker]: { title: [{ text: { content: worker } }] },
      [WAGE_PROPS.effective]: { date: { start: effectiveISO } },
      [WAGE_PROPS.newRate]: { number: newRate },
      [WAGE_PROPS.rateUnit]: { select: { name: hourly ? "Hourly" : "Salary" } },
      [WAGE_PROPS.issued]: { date: { start: issuedISO } },
      [WAGE_PROPS.voided]: { checkbox: false },
    };
    if (previousRate !== null) props[WAGE_PROPS.previousRate] = { number: previousRate };
    if ((body.reason || "").trim())
      props[WAGE_PROPS.reason] = {
        rich_text: [{ text: { content: body.reason.trim().slice(0, 400) } }],
      };

    const created: any = await notion.pages.create({
      parent: { database_id: WAGES_DB_ID },
      properties: props,
    });

    // 2) Build the notice.
    const pdfBytes = await buildWageNoticePdf({
      worker,
      effectiveISO,
      previousRate,
      newRate,
      hourly,
      issuedISO,
      lang,
    });
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");
    const fileName = `Wage_Notice_${worker.replace(/[^a-z0-9]+/gi, "-")}_${effectiveISO}.pdf`;

    // 3) Email a copy for the record — the notice existing on a given date is
    //    half the value if a rate is ever disputed.
    if (mode === "both" && process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: FROM,
          to: RECIPIENT,
          subject: `Wage notice — ${worker} — effective ${effectiveISO}`,
          text:
            `Worker: ${worker}\n` +
            `Effective: ${effectiveISO}\n` +
            (previousRate !== null ? `Previous: $${previousRate.toFixed(2)}\n` : "") +
            `New: $${newRate.toFixed(2)} ${hourly ? "per hour" : "per year"}\n` +
            (body.reason ? `Reason (internal): ${body.reason}\n` : "") +
            `Issued: ${issuedISO}\n`,
          attachments: [{ filename: fileName, content: pdfBase64 }],
        });
      } catch (e: any) {
        // The record is saved and the PDF is returned either way — an email
        // hiccup must not cost the owner the notice he's about to send.
        console.error("Wage notice email failed:", e?.message || e);
      }
    }

    return NextResponse.json({
      ok: true,
      id: created.id,
      fileName,
      pdfBase64,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Could not save the wage notice." },
      { status: 502 }
    );
  }
}
