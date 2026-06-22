# Ammex Timecard

A phone web app for foremen to log daily crew hours. Foreman fills it out,
reviews it, hits send — a PDF emails to Fernando and one row per worker
writes to the Timecards database in Notion. Spanish-first, with an EN toggle.

Same stack as the estimator: Next.js + Tailwind, deployed on Vercel.

---

## What it does

- Opens in Spanish, EN toggle in the corner.
- Foreman picks himself once; remembered on his phone after that.
- Reads the crew roster from Notion (Crew Roster database, Active = checked).
- One unified picker: type to filter, tap to add, "+ Add" for missing names.
- Remembers the last crew and pre-fills it next time.
- Per-worker hours: quick-pick buttons (4/6/8/10) + exact entry (e.g. 5.5).
- Review screen that looks like the PDF, with the big total.
- On send: writes timecard rows, emails the PDF, shows "Sent ✓".
  Never shows a false success — the checkmark only appears after the server
  confirms. If it fails (no signal), the form stays intact to retry.
- Foreman-added names are written back to Crew Roster as Active-unchecked
  with Status = "Unconfirmed" for later review.

---

## Three environment variables (set these in Vercel)

The app needs these. The two database IDs are already in the code.

| Name              | Value                                              |
|-------------------|----------------------------------------------------|
| `NOTION_TOKEN`    | Your Notion integration token (starts `ntn_`)      |
| `RESEND_API_KEY`  | Your Resend API key (starts `re_`)                 |

That's it. Email goes to `fernando@ammexrebar.com`, sent from
`timecards@send.ammexrebar.com`. Recipient and database IDs are baked in
(see `lib/notion.ts` and `app/api/submit/route.ts` if they ever change).

---

## Deploy (same flow as the estimator)

1. Put this folder in a new GitHub repo.
2. In Vercel: New Project → import that repo.
3. Before deploying, add the two environment variables above
   (Settings → Environment Variables).
4. Deploy. Open the URL on a phone, add it to the home screen.

## Run locally (optional)

```bash
npm install
# create a file named .env.local with:
#   NOTION_TOKEN=ntn_...
#   RESEND_API_KEY=re_...
npm run dev
```

Then open http://localhost:3000

---

## Notion setup it expects (already done)

**Crew Roster** (`35a9aeba5383806caf00f3635e89b12a`)
- `Name` (title), `Active` (checkbox), `Status` (text)
- Integration "Ammex Timesheet App" connected.

**Timecards** (`3879aeba5383807ca40af61a89f21a40`)
- `Date` (date), `Worker` (title), `Hours` (number), `Job` (text),
  `Work Done` (text), `Foreman` (text), `Notes` (text),
  `Submitted` (created time).
- Same integration connected.

If a property name ever changes in Notion, update it in `lib/notion.ts`
so the code keeps matching.
