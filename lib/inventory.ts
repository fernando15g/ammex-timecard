import { Client } from "@notionhq/client";
import { NOTION_TOKEN } from "./notion";

// Inventory & tool tracking — two systems that happen to live together, with
// deliberately different shapes:
//
//   MATERIALS are counts. Leftover-only: what's on hand, and in which yard.
//   No origin job, no purchasing, no receiving. The count is eyeballed and
//   edited directly.
//
//   TOOLS are individual objects with custody. "Hickey Bar #2", not "four
//   hickey bars" — the point is being able to ask a specific person for a
//   specific tool back. History is kept as append-only events.
//
// Four databases live under one parent page and are created on first use.
// People are stored as TEXT matching the Crew Roster, never as a relation, so
// nothing appears on the roster and Ammex OS can read these without owning
// anything. The one relation — Tool Events → Tools — is internal to this set.

export const INVENTORY_PARENT_PAGE_ID = "3e29aeba538380f7a745ee3f5f2d7021";

// One list of places for both materials and tools. Material gained House, which
// made the two lists identical, so they're kept as one rather than two that
// happen to say the same thing.
export const YARDS = ["Office", "20th St Yard", "House"] as const;
// Tools can sit in more places than material can — the office itself, or
// someone's house — so they get their own list rather than borrowing YARDS.
export const TOOL_LOCATIONS = YARDS;

// "Office Yard" and "Office" were the same place listed twice. Anything
// written under the old name reads as Office, so nothing drops out of a list.
export function normalizePlace(v: string): string {
  return v.trim().toLowerCase() === "office yard" ? "Office" : v;
}
// "In Yard" is kept as the stored value for compatibility with rows already
// written; it means "not issued", and Location says where it actually is.
export const TOOL_STATUSES = ["In Yard", "Issued", "Broken", "Lost"] as const;

export const MAT_PROPS = {
  item: "Item", // Title — "PC Chair 3\" · Office"
  material: "Material", // Text
  size: "Size", // Text
  yard: "Yard", // Select
  quantity: "Quantity", // Number
};

export const TOOL_PROPS = {
  tool: "Tool", // Title — "Hickey Bar #2"
  type: "Type", // Text
  number: "Number", // Number — assigned per type
  size: "Size", // Text — only for types that take one
  status: "Status", // Select
  holder: "Holder", // Text — roster name, or empty
  issued: "Issued", // Date
  location: "Location", // Select — where it sits when nobody has it
};

export const EVENT_PROPS = {
  event: "Event", // Title
  tool: "Tool", // Relation → Tools
  action: "Action", // Select
  person: "Person", // Text
  date: "Date", // Date
  note: "Note", // Text
};

// The picklists. Built up from the app over time rather than typed free-form,
// so "3in chair" and "3\" chair" can never become two different things.
export const CAT_PROPS = {
  name: "Name", // Title
  kind: "Kind", // Select — Material | Size | Tool Type
  parent: "Parent", // Text — for a Size: which material or tool type it belongs to
  sized: "Sized", // Checkbox — for a Tool Type: does it carry a size
  // Material counted in BOXES (bar chairs, PC chairs, Lok Wheels) rather than
  // pieces (slab bolsters). Decides how its count is entered and shown.
  boxed: "Boxed", // Checkbox — for a Material
  // Pieces in one box, on the SIZE — a 1" bar chair box holds 700, a 1.5" 500.
  // Optional: without it the row shows boxes with no piece estimate.
  perBox: "Per box", // Number — for a Size
};

const notion = new Client({ auth: NOTION_TOKEN });
const dbCache: Record<string, string> = {};

async function findOrCreate(title: string, properties: () => Promise<any>): Promise<string> {
  if (dbCache[title]) return dbCache[title];
  try {
    const kids: any = await notion.blocks.children.list({
      block_id: INVENTORY_PARENT_PAGE_ID,
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
    parent: { type: "page_id", page_id: INVENTORY_PARENT_PAGE_ID },
    title: [{ type: "text", text: { content: title } }],
    properties: await properties(),
  });
  dbCache[title] = created.id;
  return created.id;
}

const select = (opts: readonly string[]) => ({
  select: { options: opts.map((name) => ({ name })) },
});

export async function materialsDb() {
  return findOrCreate("Materials", async () => ({
    [MAT_PROPS.item]: { title: {} },
    [MAT_PROPS.material]: { rich_text: {} },
    [MAT_PROPS.size]: { rich_text: {} },
    [MAT_PROPS.yard]: select(YARDS),
    [MAT_PROPS.quantity]: { number: {} },
  }));
}

export async function toolsDb() {
  return findOrCreate("Tools", async () => ({
    [TOOL_PROPS.tool]: { title: {} },
    [TOOL_PROPS.type]: { rich_text: {} },
    [TOOL_PROPS.number]: { number: {} },
    [TOOL_PROPS.size]: { rich_text: {} },
    [TOOL_PROPS.status]: select(TOOL_STATUSES),
    [TOOL_PROPS.holder]: { rich_text: {} },
    [TOOL_PROPS.issued]: { date: {} },
    [TOOL_PROPS.location]: select(TOOL_LOCATIONS),
  }));
}

// Tools created before Location existed need the property added. Additive
// only, and checked once per server instance.
let toolLocEnsured = false;
export async function ensureToolLocation(): Promise<void> {
  if (toolLocEnsured) return;
  const id = await toolsDb();
  try {
    const db: any = await notion.databases.retrieve({ database_id: id });
    if (!db.properties?.[TOOL_PROPS.location]) {
      await notion.databases.update({
        database_id: id,
        properties: { [TOOL_PROPS.location]: select(TOOL_LOCATIONS) } as any,
      });
    }
    toolLocEnsured = true;
  } catch {
    /* writes below just won't carry a location until it exists */
  }
}

export async function eventsDb() {
  const tools = await toolsDb();
  return findOrCreate("Tool Events", async () => ({
    [EVENT_PROPS.event]: { title: {} },
    // Single-property: no back-relation column added to Tools.
    [EVENT_PROPS.tool]: {
      relation: { database_id: tools, type: "single_property", single_property: {} },
    },
    [EVENT_PROPS.action]: select(["Added", "Issued", "Returned", "Broken", "Lost", "Found", "Moved"]),
    [EVENT_PROPS.person]: { rich_text: {} },
    [EVENT_PROPS.date]: { date: {} },
    [EVENT_PROPS.note]: { rich_text: {} },
  }));
}

export async function catalogDb() {
  return findOrCreate("Catalog", async () => ({
    [CAT_PROPS.name]: { title: {} },
    [CAT_PROPS.kind]: select(["Material", "Size", "Tool Type"]),
    [CAT_PROPS.parent]: { rich_text: {} },
    [CAT_PROPS.sized]: { checkbox: {} },
    [CAT_PROPS.boxed]: { checkbox: {} },
    [CAT_PROPS.perBox]: { number: {} },
  }));
}

// An existing catalog predates the box columns. Additive only.
// Returns true only on the call that actually adds the Boxed column — that's
// the one moment it's safe to mark existing materials as boxed without ever
// overriding a choice made afterward.
let catColsEnsured = false;
export async function ensureCatalogColumns(): Promise<boolean> {
  if (catColsEnsured) return false;
  const id = await catalogDb();
  try {
    const db: any = await notion.databases.retrieve({ database_id: id });
    const add: any = {};
    const boxedNew = !db.properties?.[CAT_PROPS.boxed];
    if (boxedNew) add[CAT_PROPS.boxed] = { checkbox: {} };
    if (!db.properties?.[CAT_PROPS.perBox]) add[CAT_PROPS.perBox] = { number: {} };
    if (Object.keys(add).length) await notion.databases.update({ database_id: id, properties: add });
    catColsEnsured = true;
    return boxedNew;
  } catch {
    /* reads still work; box info just won't stick until the columns exist */
    return false;
  }
}

// First-run picklists. Seeded only into an EMPTY catalog, so they can never
// overwrite or duplicate anything added from the app later.
export const SEED_CATALOG: {
  kind: string;
  name: string;
  parent?: string;
  sized?: boolean;
  boxed?: boolean;
  perBox?: number;
}[] = [
  { kind: "Material", name: "PC Chair", boxed: true },
  // Bar chairs and PC chairs are different items — kept separate on purpose.
  { kind: "Material", name: "Bar Chair", boxed: true },
  { kind: "Material", name: "Lok Wheel", boxed: true },
  { kind: "Material", name: "Slab Bolster", boxed: false },
  // Box counts as printed on the boxes.
  { kind: "Size", name: '1"', parent: "Bar Chair", perBox: 700 },
  { kind: "Size", name: '1.25"', parent: "Bar Chair", perBox: 600 },
  { kind: "Size", name: '1.5"', parent: "Bar Chair", perBox: 500 },
  { kind: "Size", name: '2"', parent: "Lok Wheel", perBox: 120 },
  { kind: "Tool Type", name: "Hickey Bar", sized: true },
  { kind: "Tool Type", name: "Rebar Cutting Edge Saw (Cordless)", sized: false },
  { kind: "Tool Type", name: "Gas Cut-Off Saw", sized: false },
];
