import { Client } from "@notionhq/client";
import { NOTION_TOKEN } from "./notion";

// Safety toolbox-talk forms.
//
// Two databases live under one parent page and are created on first use, so
// nothing has to be set up by hand in Notion — the same self-provisioning
// pattern the PIN and Short Pay properties use.
//
//   Safety Topics — the 52-week talk schedule, one row per week per year.
//   Safety Forms  — one row per uploaded photo.
//
// The topic for a given Monday is looked up rather than typed: the sheet the
// crew signs is numbered 1-52 and the number is determined by the week, so the
// foreman never picks anything and can't pick wrong.

export const SAFETY_PARENT_PAGE_ID = "3e19aeba538380fa9017cbf33e321c5f";

export const TOPIC_PROPS = {
  name: "Topic", // Title — English name
  spanish: "Spanish", // Text — what the foreman sees
  year: "Year", // Number
  week: "Week", // Number — 1..52
};

export const FORM_PROPS = {
  title: "Form", // Title — "2026-09-14 — Ramon Aguirre"
  date: "Date", // Date — the Monday the talk covers
  foreman: "Foreman", // Text
  topic: "Topic", // Text — English name, for reports
  topicWeek: "Week", // Number
  path: "Path", // Text — Supabase storage object path
  uploadedBy: "Uploaded by", // Text — foreman name, or "Owner"
  voided: "Voided", // Checkbox
};

const notion = new Client({ auth: NOTION_TOKEN });

// Cache the database ids for the life of the server instance. They're found by
// title under the parent page, so a redeploy doesn't lose them and nothing
// needs to be stored in an env var.
const dbCache: Record<string, string> = {};

async function findOrCreateDb(
  title: string,
  properties: any
): Promise<string> {
  if (dbCache[title]) return dbCache[title];

  // Look for it first — creating a second copy would silently split the data.
  try {
    const kids: any = await notion.blocks.children.list({
      block_id: SAFETY_PARENT_PAGE_ID,
      page_size: 100,
    });
    for (const b of kids.results || []) {
      if (b.type !== "child_database") continue;
      if ((b.child_database?.title || "").trim().toLowerCase() === title.toLowerCase()) {
        dbCache[title] = b.id;
        return b.id;
      }
    }
  } catch {
    /* fall through to create */
  }

  const created: any = await notion.databases.create({
    parent: { type: "page_id", page_id: SAFETY_PARENT_PAGE_ID },
    title: [{ type: "text", text: { content: title } }],
    properties,
  });
  dbCache[title] = created.id;
  return created.id;
}

export async function topicsDbId(): Promise<string> {
  return findOrCreateDb("Safety Topics", {
    [TOPIC_PROPS.name]: { title: {} },
    [TOPIC_PROPS.spanish]: { rich_text: {} },
    [TOPIC_PROPS.year]: { number: {} },
    [TOPIC_PROPS.week]: { number: {} },
  });
}

export async function formsDbId(): Promise<string> {
  return findOrCreateDb("Safety Forms", {
    [FORM_PROPS.title]: { title: {} },
    [FORM_PROPS.date]: { date: {} },
    [FORM_PROPS.foreman]: { rich_text: {} },
    [FORM_PROPS.topic]: { rich_text: {} },
    [FORM_PROPS.topicWeek]: { number: {} },
    [FORM_PROPS.path]: { rich_text: {} },
    [FORM_PROPS.uploadedBy]: { rich_text: {} },
    [FORM_PROPS.voided]: { checkbox: {} },
  });
}

// The 2026 schedule, from the CST Risk Management sheet. Seeded into Notion on
// first use; after that the owner edits it in-app, and a new year's list is
// entered the same way rather than shipped in code.
export const DEFAULT_TOPICS_2026: { week: number; en: string; es: string }[] = [
  { week: 1, en: "Noise Exposure", es: "Exposición al Ruido" },
  { week: 2, en: "Personal Protective Equipment", es: "Equipo Protectivo Personal" },
  { week: 3, en: "Aerial Lift", es: "Ascensor Aéreo" },
  { week: 4, en: "Fire Prevention", es: "Prevención de Incendio" },
  { week: 5, en: "Flammable Liquids", es: "Liquidos Flamables" },
  { week: 6, en: "Compressed Gases", es: "Gases Comprimidos" },
  { week: 7, en: "Basic First Aid", es: "Primer Auxilio Basico" },
  { week: 8, en: "Hypothermia", es: "Hipotérmia" },
  { week: 9, en: "Right to Know", es: "Derecho ha Saber" },
  { week: 10, en: "Heavy Equipment / Backing Up", es: "Equipo Pesado/Retroceder" },
  { week: 11, en: "Housekeeping", es: "Limpieza General" },
  { week: 12, en: "Material Handling", es: "Manejo de Materiales" },
  { week: 13, en: "Workplace Violence", es: "Violencia en el Lugar de Trabajo" },
  { week: 14, en: "Powered Industrial Trucks", es: "Camión Industrial de Fuerza Motríz" },
  { week: 15, en: "Grinding / Abrasive Wheels", es: "Piedra de Afilar/Rueda Abrasiva" },
  { week: 16, en: "Welding and Cutting", es: "Soldadura Autogena y Cortando" },
  { week: 17, en: "Electrical Safety", es: "Seguridad Eléctrica" },
  { week: 18, en: "Lockout / Tagout", es: "Cerrar con Llave/Poner Etiqueta" },
  { week: 19, en: "Scaffolding", es: "Andamios" },
  { week: 20, en: "Incident Reporting (Mandatory)", es: "Reportar Incidentes (Obligatorio)" },
  { week: 21, en: "Fall Protection: Personal Fall Arrest Systems", es: "Protección contra Caídas: Sistema de Protección Personal contra Caídas" },
  { week: 22, en: "Fall Protection: Safety Monitors and Controlled Access Zones", es: "Protección contra Caídas: Personas Vigilantes y Zonas de Acceso Controlado" },
  { week: 23, en: "Heat Stress Prevention", es: "Prevención de la Fuerza del Calor" },
  { week: 24, en: "Ladders", es: "Escaleras (Ladders)" },
  { week: 25, en: "Staircases", es: "Escalones (Staircases)" },
  { week: 26, en: "Working with Cranes", es: "Trabajar con Grúas" },
  { week: 27, en: "Driving", es: "Manejando" },
  { week: 28, en: "Substance Abuse", es: "Abuso de Sustancia" },
  { week: 29, en: "Excavations: Soil Classification", es: "Excavaciónes: Clases de Tierra" },
  { week: 30, en: "Excavations: Access and Egress", es: "Excavaciónes: Entrada y Salida" },
  { week: 31, en: "Excavations: Hazardous Atmospheres", es: "Excavaciónes: Atmósferas Peligrosas" },
  { week: 32, en: "The Morning After the Night Before", es: "La Mañana Despues de la Noche Antes" },
  { week: 33, en: "Confined Spaces", es: "Espacios Confinados" },
  { week: 34, en: "When OSHA Calls", es: "Cuando Llama OSHA" },
  { week: 35, en: "Blue Stake", es: "Blue Stake" },
  { week: 36, en: "Venomous Bites and Stings", es: "Mordidas y Picadas Venenosas" },
  { week: 37, en: "Safe Lifting Methods", es: "Métodos de Levantar con Cuidado" },
  { week: 38, en: "Powder-Actuated Tools", es: "Herramientas Actuadas por Pólvora" },
  { week: 39, en: "Handling Pipe", es: "Manejar Tubería" },
  { week: 40, en: "Respiratory Protection", es: "Protección Respiratoria" },
  { week: 41, en: "Workplace Attire", es: "Vestido en el Lugar del Trabajo" },
  { week: 42, en: "Fall Protection: Toe Boards and Guardrails", es: "Protección contra Caídas: Toe Kicks Y Contrarrieles" },
  { week: 43, en: "The Little Things", es: "Cosas Pequeñas" },
  { week: 44, en: "Before and After", es: "Antes y Después" },
  { week: 45, en: "15 Years to Die", es: "15 años Para Morirse" },
  { week: 46, en: "LP Gas Heaters", es: "Calentadores de Gas LP" },
  { week: 47, en: "Carbon Monoxide", es: "Monóxido de Carbón" },
  { week: 48, en: "Compressed Air", es: "Aire de Compresión" },
  { week: 49, en: "What They Don't Know", es: "Lo Que No Saben" },
  { week: 50, en: "Caught In Between", es: "Atrapado Entre Dos Cosas" },
  { week: 51, en: "Horseplay", es: "Chanza Pesada (Horseplay)" },
  { week: 52, en: "Hand and Power Tools", es: "Herramientas de Mano y de Poder" },
];

// The Monday a date belongs to. Sheets are signed Monday morning, but a
// straggler submitting Wednesday still belongs to that Monday's talk.
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 = Sunday
  dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return dt.toISOString().slice(0, 10);
}

// Week 1 is the FIRST MONDAY of January, and the cycle restarts each year.
// Confirmed against a real sheet: 2026-09-14 is week 37.
export function weekNumberFor(iso: string): { year: number; week: number } {
  const monday = mondayOf(iso);
  const year = Number(monday.slice(0, 4));
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const shift = (8 - (jan1.getUTCDay() || 7)) % 7; // days until the first Monday
  const firstMonday = new Date(Date.UTC(year, 0, 1 + shift));
  const [my, mm, md] = monday.split("-").map(Number);
  const diffDays = Math.round(
    (Date.UTC(my, mm - 1, md) - firstMonday.getTime()) / 86400000
  );
  // A Monday before the first Monday of its own year belongs to the prior
  // year's final week.
  if (diffDays < 0) {
    const pj = new Date(Date.UTC(year - 1, 0, 1));
    const ps = (8 - (pj.getUTCDay() || 7)) % 7;
    const pfm = new Date(Date.UTC(year - 1, 0, 1 + ps));
    const pd = Math.round((Date.UTC(my, mm - 1, md) - pfm.getTime()) / 86400000);
    return { year: year - 1, week: Math.floor(pd / 7) + 1 };
  }
  return { year, week: Math.floor(diffDays / 7) + 1 };
}
