import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { SIGNATURE_PNG, LOGO_PNG, HERITAGE_PNG } from "./wage-assets";

// Wage increase notice — worker-facing, half a page, deliberately short.
// Spanish is the default because most of the crew reads it more comfortably;
// the English version is a mirror, not a variant.
//
// Wording notes:
//  - "Aumento de salario" is the ordinary phrase for a raise in Mexican
//    Spanish and does NOT imply salaried pay; the "por hora" line carries the
//    arrangement.
//  - "Pago anterior / Pago nuevo" over "Tarifa" — tarifa reads administrative,
//    like an invoice rate. These notices are read by the crew.
//  - The reason is captured in the app for the owner's records but is
//    deliberately NOT printed. A worker doesn't need to read why.

export interface WageNoticeData {
  worker: string;
  effectiveISO: string;
  previousRate: number | null; // null on a worker's first recorded notice
  newRate: number;
  hourly: boolean;
  issuedISO: string;
  lang: "es" | "en";
}

const NAVY = rgb(0.016, 0.094, 0.176); // #04182D — Ammex ink, title + rule only
const INK = rgb(0, 0, 0); // body copy
const FAINT = rgb(0.45, 0.47, 0.5); // footer

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function prettyDate(iso: string, lang: "es" | "en"): string {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso || "";
  const ES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return lang === "es"
    ? `${d} de ${ES[m - 1]} de ${y}`
    : `${EN[m - 1]} ${d}, ${y}`;
}

export async function buildWageNoticePdf(d: WageNoticeData): Promise<Uint8Array> {
  const es = d.lang === "es";
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const MARGIN = 64;
  const RIGHT = 612 - MARGIN;
  let y = 792 - MARGIN;

  // Wordmark top right, heritage mark top left — deliberately smaller, so it
  // reads as a stamp rather than competing with the logo. Both are baseline-
  // aligned on their centres so the header looks level despite different
  // proportions.
  const logo = await pdf.embedPng(Buffer.from(LOGO_PNG, "base64"));
  const logoW = 168;
  const logoH = (logo.height / logo.width) * logoW;

  const heritage = await pdf.embedPng(Buffer.from(HERITAGE_PNG, "base64"));
  const heritageW = 62;
  const heritageH = (heritage.height / heritage.width) * heritageW;

  const headerTop = y;
  const bandH = Math.max(logoH, heritageH);
  page.drawImage(logo, {
    x: RIGHT - logoW,
    y: headerTop - bandH + (bandH - logoH) / 2,
    width: logoW,
    height: logoH,
  });
  page.drawImage(heritage, {
    x: MARGIN,
    y: headerTop - bandH + (bandH - heritageH) / 2,
    width: heritageW,
    height: heritageH,
  });
  y -= bandH + 46;

  // Title
  page.drawText(es ? "AVISO DE AUMENTO DE SALARIO" : "WAGE INCREASE NOTICE", {
    x: MARGIN, y, size: 15, font: bold, color: NAVY,
  });
  y -= 10;
  page.drawRectangle({ x: MARGIN, y: y - 6, width: 612 - MARGIN * 2, height: 1.5, color: NAVY });
  y -= 42;

  // Name / effective date
  const line = (label: string, value: string, gap = 26) => {
    page.drawText(label, { x: MARGIN, y, size: 11, font, color: INK });
    page.drawText(value, { x: MARGIN + 150, y, size: 11.5, font: bold, color: INK });
    y -= gap;
  };

  line(es ? "Nombre:" : "Name:", d.worker);
  line(
    es ? "Fecha de vigencia:" : "Effective date:",
    prettyDate(d.effectiveISO, es ? "es" : "en"),
    34
  );

  const unit = d.hourly
    ? es ? " por hora" : " per hour"
    : es ? " por año" : " per year";

  if (d.previousRate !== null) {
    line(es ? "Pago anterior:" : "Previous pay:", money(d.previousRate) + unit);
  }
  line(es ? "Pago nuevo:" : "New pay:", money(d.newRate) + unit, 40);

  // Thanks
  page.drawText(
    es
      ? "Gracias por tu trabajo y tu compromiso con Ammex Rebar Placers."
      : "Thank you for your work and your commitment to Ammex Rebar Placers.",
    { x: MARGIN, y, size: 11, font, color: INK }
  );
  y -= 22;

  // Questions reads as a sentence leading into the names, rather than a
  // heading — it's a note to a person, not a form section.
  page.drawText(
    es
      ? "Si tienes alguna pregunta sobre tu nuevo pago, comunícate con:"
      : "If you have any questions about your new pay rate, feel free to reach out to:",
    { x: MARGIN, y, size: 11, font, color: INK }
  );
  y -= 20;
  page.drawText("Oscar Garcia — (602) 501-2734", { x: MARGIN + 12, y, size: 11, font: bold, color: INK });
  y -= 17;
  page.drawText("Fernando Garcia — (602) 501-3809", { x: MARGIN + 12, y, size: 11, font: bold, color: INK });
  y -= 52;

  // Signature block
  const sig = await pdf.embedPng(Buffer.from(SIGNATURE_PNG, "base64"));
  const sigW = 150;
  const sigH = (sig.height / sig.width) * sigW;
  page.drawImage(sig, { x: MARGIN, y: y - sigH + 16, width: sigW, height: sigH });
  y -= sigH - 4;
  page.drawRectangle({ x: MARGIN, y, width: 210, height: 0.75, color: rgb(0.75, 0.77, 0.8) });
  y -= 16;
  page.drawText("Oscar Garcia — Ammex Rebar Placers, Inc.", {
    x: MARGIN, y, size: 10.5, font: bold, color: INK,
  });
  y -= 15;
  page.drawText(
    (es ? "Emitido el " : "Issued ") + prettyDate(d.issuedISO, es ? "es" : "en"),
    { x: MARGIN, y, size: 9.5, font, color: FAINT }
  );

  // Not-a-contract line as a page footer — pinned to the bottom margin rather
  // than floating in the body, so it stays out of the way while remaining
  // legible. Position is fixed, independent of how long the notice runs.
  page.drawText(
    es
      ? "Este aviso confirma un cambio de pago. No es un contrato de empleo."
      : "This notice confirms a change in pay. It is not an employment contract.",
    { x: MARGIN, y: 46, size: 8.5, font: italic, color: FAINT }
  );

  return pdf.save();
}
