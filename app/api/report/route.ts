import { NextResponse } from "next/server";
import { NOTION_TOKEN } from "@/lib/notion";
import { addDaysISO, lastCompletedWeekStart } from "@/lib/report";
import { runReport } from "@/lib/report-run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REPORT_PIN = "5314";
const MAX_SPAN_DAYS = 62; // guard against absurd custom ranges

function todayISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function isISO(s: any): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function spanDays(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}

export async function POST(req: Request) {
  if (!NOTION_TOKEN || !process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  if (body.pin !== REPORT_PIN) {
    return NextResponse.json({ error: "Wrong PIN." }, { status: 401 });
  }

  const flagsOn = body.flags !== false; // default on
  const foreman = typeof body.foreman === "string" ? body.foreman : "";
  const lang = body.lang === "es" ? "es" : "en";
  const mode = body.mode === "view" ? "view" : "email";
  const reportView =
    body.reportView === "worker"
      ? "worker"
      : body.reportView === "daily"
      ? "daily"
      : body.reportView === "foremanAll"
      ? "foremanAll"
      : body.reportView === "payrollGrid"
      ? "payrollGrid"
      : "job";

  // Determine the span. Custom range takes priority if both dates are valid.
  let startISO: string;
  let endISO: string;
  if (isISO(body.startISO) && isISO(body.endISO)) {
    startISO = body.startISO;
    endISO = body.endISO;
    if (endISO < startISO) {
      const tmp = startISO;
      startISO = endISO;
      endISO = tmp;
    }
    const n = spanDays(startISO, endISO);
    if (n > MAX_SPAN_DAYS) {
      return NextResponse.json(
        { error: `Date range too long (max ${MAX_SPAN_DAYS} days).` },
        { status: 400 }
      );
    }
  } else {
    startISO = isISO(body.weekStart)
      ? body.weekStart
      : lastCompletedWeekStart(todayISO());
    endISO = addDaysISO(startISO, 6);
  }

  try {
    const result = await runReport(startISO, endISO, flagsOn, {
      foreman,
      lang,
      mode,
      reportView,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Report failed:", err?.message || err);
    return NextResponse.json(
      { error: "Report generation failed. " + (err?.message || "") },
      { status: 502 }
    );
  }
}
