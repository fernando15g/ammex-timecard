// Notion configuration. The token comes from the environment (Vercel),
// never hardcoded. Database IDs are not secret, so they live here.

export const NOTION_TOKEN = process.env.NOTION_TOKEN || "";

// Crew Roster database (the renamed Contact Sheet). The app reads the
// "Name" column where "Active" is checked, and writes "Unconfirmed" into
// the "Status" column for foreman-added workers.
export const CREW_ROSTER_DB_ID = "35a9aeba5383806caf00f3635e89b12a";

// Timecards database. One row per worker per job per day.
export const TIMECARDS_DB_ID = "3879aeba5383807ca40af61a89f21a40";

// Property names in the Crew Roster database.
export const ROSTER_PROPS = {
  name: "Name", // Title property
  active: "Active", // Checkbox
  status: "Status", // Text
  role: "Role", // Text/Select — used to identify foremen
};

// Property names in the Timecards database.
export const TIMECARD_PROPS = {
  worker: "Worker", // Title
  date: "Date", // Date
  job: "Job", // Text (rich_text)
  hours: "Hours", // Number
  workDone: "Work Done", // Text (rich_text)
  foreman: "Foreman", // Text (rich_text)
  notes: "Notes", // Text (rich_text)
};
