import { buildDailyPdf } from "./lib/report-pdf";
import { writeFileSync } from "fs";
const name = process.argv[2] || "out";
const rd: any = {
  weekStartISO: "2026-07-06", weekEndISO: "2026-07-12", lang: "en",
  foremanReport: false, foremanName: "", grandTotal: 42,
  days: [{
    dateISO: "2026-07-08", dateLabel: "Wednesday, July 8",
    jobs: [
      { title: "Kino", jobId: "24-1", total: 24, foremen: [
        { foreman: "David Avitia", total: 24, crew: [
          { name: "Luis Perez", hours: 8 }, { name: "Jose Cruz", hours: 8 }, { name: "Ramon Aguirre", hours: 8 },
        ]},
      ]},
      { title: "TEP Westwing", jobId: "24-2", total: 18, foremen: [
        { foreman: "Ramon Aguirre", total: 18, crew: [
          { name: "Pedro Gil", hours: 10 }, { name: "Miguel Santos", hours: 8 },
        ]},
      ]},
    ],
    total: 42,
  }],
};
buildDailyPdf(rd).then((b: Uint8Array) => writeFileSync(`/home/claude/v_${name}.pdf`, b));
