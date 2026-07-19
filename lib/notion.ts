// Notion configuration. The token comes from the environment (Vercel),
// never hardcoded. Database IDs are not secret, so they live here.

export const NOTION_TOKEN = process.env.NOTION_TOKEN || "";

// Crew Roster database (the renamed Contact Sheet). The app reads the
// "Name" column where "Active" is checked, and writes "Unconfirmed" into
// the "Status" column for foreman-added workers.
export const CREW_ROSTER_DB_ID = "35a9aeba5383806caf00f3635e89b12a";

// Timecards database. One row per worker per job per day.
export const TIMECARDS_DB_ID = "3879aeba5383807ca40af61a89f21a40";

// Projects database — the source of jobs for the Schedule job picker.
export const PROJECTS_DB_ID = "35a9aeba5383801990dac4cb0de148e8";

// Schedule database — where built schedules are saved (one row per
// worker-per-job-per-day). Separate from Timecards; never touches payroll.
export const SCHEDULE_DB_ID = "38e9aeba5383807c8ff0e767ab894d17";

// Property names in the Projects database.
export const PROJECT_PROPS = {
  name: "Actual Project Name", // Title — the job name
  jobId: "Project ID", // rich_text — e.g. "25-20"
  status: "Project Status", // status
};

// Project statuses that count as "schedulable" (show in the job picker).
export const SCHEDULABLE_STATUSES = ["Awarded", "Mobilizing", "Active", "Punchlist"];

// Property names in the Schedule database.
export const SCHEDULE_PROPS = {
  worker: "Worker", // Title
  date: "Date", // Date
  job: "Job", // Relation → Projects
  isLead: "Is Lead", // Checkbox
};

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
  job: "Job", // Text (rich_text) — foreman's typed job name
  hours: "Hours", // Number
  workDone: "Work Done", // Text (rich_text)
  foreman: "Foreman", // Text (rich_text)
  notes: "Notes", // Text (rich_text)
  projectHelper: "Project Helper", // Relation/rollup — clean project name
  jobIdHelper: "Job ID Helper", // Rollup — clean job ID (text, e.g. "26-4")
  voided: "Voided", // Checkbox — void-not-delete for duplicates/corrections
  voidNote: "Void note", // Text (rich_text) — why it was voided
  underReview: "Under Review", // Checkbox — held pending owner review; excluded from counts
  uncategorized: "Uncategorized", // Checkbox — intentionally no project (change order / paid training); stops the needs-project nag, bucketed as Uncategorized on reports
};

// Reconciliation Log — durable record of outcomes (no-show / confirmed / fixed).
export const RECON_LOG_DB_ID = "3919aeba538380cbab67c636dcdb5b32";

// Site Visit Log — owner's personal record of jobsite visits (arrival time,
// optional departure). Owner-only; not employee-facing.
export const SITE_VISIT_DB_ID = "3949aeba5383806dad38e0e3b1b1c193";
export const VISIT_PROPS = {
  title: "Visit", // title — auto-labeled "Job — Mon D"
  job: "Job", // relation → Projects
  arrival: "Arrival", // date (with time)
  departure: "Departure", // date (with time) — optional
  notes: "Notes", // rich_text
  loggedBy: "Logged by", // text (or select) — resolved from schema at runtime
};
export const RECON_PROPS = {
  worker: "Worker", // Title
  date: "Date", // Date
  kind: "Kind", // Select
  status: "Status", // Select
  note: "Note", // Text (rich_text)
  refs: "Refs", // Text (rich_text) — entry IDs this outcome applies to (strict match)
  loggedAt: "Logged at", // Created time
};

export const PAYROLL_RECIPIENT = "fernando@ammexrebar.com";
