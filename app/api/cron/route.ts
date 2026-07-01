import { NextResponse } from "next/server";
import { NOTION_TOKEN } from "@/lib/notion";
import { addDaysISO, lastCompletedWeekStart } from "@/lib/report";
import { runWeeklyBundle } from "@/lib/report-run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function todayISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// Vercel Cron hits this Monday morning (Arizona). It builds and emails the
// weekly bundle — Master report, Payroll Grid, and Owner Review — Daily, all
// as PDF — for the Mon–Sun week that just completed.
export async function GET(req: Request) {
  // If CRON_SECRET is configured, require Vercel's bearer header. If it's not
  // set, the endpoint still works (worst case: an extra report emailed to the
  // owner), but setting CRON_SECRET in Vercel is recommended.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!NOTION_TOKEN || !process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  const weekStart = lastCompletedWeekStart(todayISO());
  const weekEnd = addDaysISO(weekStart, 6);

  try {
    const result = await runWeeklyBundle(weekStart, weekEnd);
    return NextResponse.json({ ran: true, ...result });
  } catch (err: any) {
    console.error("Cron report failed:", err?.message || err);
    return NextResponse.json(
      { error: "Cron report failed. " + (err?.message || "") },
      { status: 502 }
    );
  }
}
