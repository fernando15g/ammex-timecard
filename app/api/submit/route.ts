import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { Resend } from "resend";
import {
  NOTION_TOKEN,
  CREW_ROSTER_DB_ID,
  TIMECARDS_DB_ID,
  ROSTER_PROPS,
  TIMECARD_PROPS,
} from "@/lib/notion";
import { buildTimecardPdf, TimecardData } from "@/lib/pdf";

export const dynamic = "force-dynamic";

const RECIPIENT = "fernando@ammexrebar.com";
const FROM = "Ammex Timecard <timecards@send.ammexrebar.com>";

// Format YYYY-MM-DD as "June 22, 2026" for the email body (no timezone drift).
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

interface SubmitBody {
  foreman: string;
  date: string;
  job: string;
  workDone: string;
  notes: string;
  workers: { name: string; hours: number; isNew?: boolean }[];
}

function rich(text: string) {
  return text ? [{ type: "text", text: { content: text } }] : [];
}

export async function POST(req: Request) {
  if (!NOTION_TOKEN || !process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Server not configured." },
      { status: 500 }
    );
  }

  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  // Basic validation
  if (!body.job?.trim()) {
    return NextResponse.json({ error: "Missing job." }, { status: 400 });
  }
  if (!body.workers?.length) {
    return NextResponse.json({ error: "No workers." }, { status: 400 });
  }
  for (const w of body.workers) {
    if (!w.name?.trim() || typeof w.hours !== "number" || w.hours <= 0) {
      return NextResponse.json(
        { error: "Each worker needs a name and hours." },
        { status: 400 }
      );
    }
  }

  const notion = new Client({ auth: NOTION_TOKEN });
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // 1) Write one Timecard row per worker
    for (const w of body.workers) {
      await notion.pages.create({
        parent: { database_id: TIMECARDS_DB_ID },
        properties: {
          [TIMECARD_PROPS.worker]: {
            title: rich(w.name.trim()) as any,
          },
          [TIMECARD_PROPS.date]: {
            date: { start: body.date },
          },
          [TIMECARD_PROPS.job]: {
            rich_text: rich(body.job.trim()) as any,
          },
          [TIMECARD_PROPS.hours]: {
            number: w.hours,
          },
          [TIMECARD_PROPS.workDone]: {
            rich_text: rich(body.workDone?.trim() || "") as any,
          },
          [TIMECARD_PROPS.foreman]: {
            rich_text: rich(body.foreman?.trim() || "") as any,
          },
          [TIMECARD_PROPS.notes]: {
            rich_text: rich(body.notes?.trim() || "") as any,
          },
        },
      });
    }

    // 2) For any foreman-added (new) workers, create an Unconfirmed roster
    //    row: Active unchecked, Status = "Unconfirmed".
    const newWorkers = body.workers.filter((w) => w.isNew);
    for (const w of newWorkers) {
      try {
        await notion.pages.create({
          parent: { database_id: CREW_ROSTER_DB_ID },
          properties: {
            [ROSTER_PROPS.name]: {
              title: rich(w.name.trim()) as any,
            },
            [ROSTER_PROPS.active]: {
              checkbox: false,
            },
            [ROSTER_PROPS.status]: {
              rich_text: rich("Unconfirmed") as any,
            },
          },
        });
      } catch (e: any) {
        // Don't fail the whole submit if a roster write hiccups;
        // the timecard rows are what matter most.
        console.error("Roster write failed for", w.name, e?.message || e);
      }
    }

    // 3) Build the PDF
    const pdfData: TimecardData = {
      foreman: body.foreman,
      date: body.date,
      job: body.job,
      workDone: body.workDone,
      notes: body.notes,
      workers: body.workers.map((w) => ({ name: w.name, hours: w.hours })),
    };
    const pdfBytes = await buildTimecardPdf(pdfData);
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");

    const total = body.workers.reduce((s, w) => s + w.hours, 0);
    const fileName = `Timecard_${body.job.trim().replace(/[^a-z0-9]+/gi, "-")}_${body.date}.pdf`;

    // 4) Email it
    await resend.emails.send({
      from: FROM,
      to: RECIPIENT,
      subject: `Timecard — ${body.job.trim()} — ${body.date} (${body.workers.length} workers, ${Math.round(total * 100) / 100} hrs)`,
      text:
        `Foreman: ${body.foreman}\n` +
        `Job: ${body.job}\n` +
        `Date: ${prettyDate(body.date)}\n` +
        `Workers: ${body.workers.length}\n` +
        `Total hours: ${Math.round(total * 100) / 100}\n\n` +
        `Crew:\n` +
        body.workers.map((w) => `  ${w.name}: ${w.hours}`).join("\n") +
        (body.workDone?.trim() ? `\n\nWork done: ${body.workDone}` : "") +
        (body.notes?.trim() ? `\nNotes: ${body.notes}` : ""),
      attachments: [{ filename: fileName, content: pdfBase64 }],
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Submit failed:", err?.message || err);
    return NextResponse.json(
      { error: "Submit failed. Nothing was saved twice — please retry." },
      { status: 502 }
    );
  }
}
