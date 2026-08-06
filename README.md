# Lead Portal

A call list for outbound agents working scraped Yelp business data. One screen:
every lead in a dense table, with status, notes and callback date editable
inline. No detail pages, no one-record-at-a-time flow.

**Current phase: frontend only.** Data is mock data plus client-side CSV import;
all edits live in React state and are lost on reload. The seams for a real
backend are already in place (see below).

```bash
npm run dev   # http://localhost:3000
```

## Features

- **Full list view** — name, phone, address, category, website, all rows at once.
- **Status tracking** — colour-coded badge that is itself the dropdown. Seven
  statuses, defined in `lib/types.ts`.
- **Notes** — click a notes cell to expand a textarea in place.
- **Staged edits** — status and notes do *not* commit on change. They fill a
  per-row draft, the row grows a Save/Cancel bar, and only Save writes to the
  central state (green pulse + "Saved" to confirm). Cancel or Escape discards;
  setting a control back to its original value clears the pending state on its
  own. The callback date stays immediate — picking from a calendar is already
  deliberate.
- **Callbacks** — per-lead date. Due today shows red text on a bare surface;
  overdue fills the same red and adds a `late` tag.
- **Views** — All leads / Needs callback / Overdue / Data issues as tabs. The
  tab picks the scope; the filter toolbar narrows within it.
- **Filtering** — instant search (name, address, phone, notes, owner) plus an
  expander with multi-select status, multi-select category/industry, a rating
  range, and callback ranges (today, this week, overdue, has/no date, or a
  custom from–to). Active constraints appear as removable chips with a
  "Clear all", above a "Showing X of Y total leads" counter. Rules live in
  `lib/filters.ts` as pure predicates so a future SQL query can reuse them.
- **Automatic cleaning** — every lead entering the app passes through
  `lib/cleanLeads.ts`: rows with no dialable phone are dropped, and duplicates
  (same normalised phone, or same business name at the same address) collapse
  to their first occurrence. It runs on the CSV path *and* in the state
  handler, so any future data source is cleaned too. Being idempotent, running
  it twice removes nothing.
- **Data quality flags** — a missing website or address is still flagged in the
  cell. Phone and duplicate badges are gone: those rows no longer exist.
- **Stats** — three headline numbers on the worklist; the full status breakdown
  and list-quality counts live behind the Breakdown toggle and on Reports.
- **CSV import** — its own Import view, client-side via PapaParse. Try
  `public/sample-leads.csv`.
- **Export** — entirely contained in the Export view, which shares no state
  with the worklist: its own filter toolbar, its own row ticks, and three
  formats (CSV, XLSX, PDF call sheet). One rule decides the contents —
  **ticked rows win; with nothing ticked, the filtered list is written** — so
  all three scopes are reachable (tick for a selection, filter for a subset,
  clear both for everything) without a selector that can contradict a tick.
  The worklist has no checkboxes and no export action. Everything is generated
  in the browser, and the writers are dynamically imported so they cost nothing
  until used.
- **Themes** — dark (graphite + signal red) and light (cool slate), toggled from
  the nav bar and persisted to localStorage via next-themes. Colour lives in one
  place: every token is a `--c-*` variable defined twice in `app/globals.css`
  and pointed at by `@theme`, so components never name a theme.

## Structure

```
app/
  layout.tsx                  app shell: fonts, NavBar, LeadsProvider (seeds data)
  page.tsx                    Worklist — the call list
  meetings/page.tsx           booked calls, grouped by day
  import/page.tsx             CSV import
  export/page.tsx             CSV / XLSX / PDF export
  reports/page.tsx            summary + full status breakdown
  settings/page.tsx           placeholder for backend config
  api/leads/route.ts          GET — every lead, from Postgres
  api/leads/[id]/route.ts     PATCH — persists one inline edit
  api/leads/upload/route.ts   POST — parses a CSV and replaces the table
components/
  LeadsProvider.tsx           the store: leads, workspace (tab/filters/selection), stats
  NavBar.tsx / ViewTabs.tsx   app shell nav and the worklist's tabbed views
  Worklist.tsx                headline strip -> tabs -> filter rail -> table
  LeadTable / LeadRow / ...   the list itself
lib/
  types.ts                    Lead + CallStatus + status colours — single source of truth
  prisma.ts                   Prisma Client singleton (survives dev hot reload)
  leadMapping.ts              database row <-> Lead; pure, no client
  leadDb.ts                   every query, plus PATCH body validation
  mockLeads.ts                dev fixture for `npm run db:seed -- --demo`
  parseLeadsCsv.ts            CSV -> Lead[], runtime-agnostic
  cleanLeads.ts               ingestion gate: phone validity + de-duplication
  exportLeads.ts              one row-shaping definition -> CSV / XLSX / PDF
  leadUtils.ts                duplicates, callback state, stats
  views.ts                    the tab scopes (all / callback / overdue / issues)
  meetings.ts                 derived agenda: membership, buckets, day grouping
  filters.ts                  filter model, matching predicate, active-chip list
```

## Database

PostgreSQL via Prisma. Nothing is held in memory across a reload any more:
statuses, notes, callback dates and meeting detail are all written through.

### First-time setup

1. Have Postgres running locally and create the database:

   ```bash
   createdb lead_portal      # or, from psql:  CREATE DATABASE lead_portal;
   ```

2. Copy the environment template and point it at that database:

   ```bash
   cp .env.example .env.local
   ```

   `.env.local` is gitignored. `prisma.config.ts` loads it explicitly, because
   the Prisma CLI runs outside Next and would not otherwise see it.

3. Apply the schema and load sample data:

   ```bash
   npm run db:migrate            # applies prisma/migrations
   npm run db:seed               # public/sample-leads.csv
   npm run db:seed -- --demo     # or: statuses, callbacks and meetings
   ```

Use `--demo` when working on the Callbacks, Meetings or Reports screens — a
scraper CSV has no agent-owned fields, so seeding from it leaves every lead on
"Not called" and those views empty.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run db:migrate` | `prisma migrate dev` — create/apply migrations |
| `npm run db:reset` | drop, re-apply every migration (does **not** re-seed) |
| `npm run db:seed` | load sample data into an empty table |
| `npm run db:studio` | browse the table in Prisma Studio |

`prisma generate` runs on `postinstall` and again at the start of `npm run
build`, so a fresh clone or a schema change never needs it typed by hand. The
generated client lands in `lib/generated/prisma` and is gitignored.

### How the layers fit

- **Reads** — `listLeads()` in `lib/leadDb.ts`, called by `app/layout.tsx` for
  the initial render and by `GET /api/leads`.
- **Writes** — `updateLead()` in `components/LeadsProvider.tsx` is still the
  only mutation path in the UI. It updates state immediately, then
  `PATCH /api/leads/[id]` in the background, and puts the old value back if the
  save fails.
- **Upload** — `POST /api/leads/upload` parses with `parseLeadsCsv(csvText)` —
  the same function the browser used to call, unchanged — and replaces the
  table inside a transaction.
- **Stats and filters** — still computed client-side over the full lead array
  (`computeStats`, `matchesFilters`). See the note below.

### Stats: why not a `/api/leads/stats` route

The stat bar reflects optimistic edits. Marking a lead "Interested" has to move
the counter on the same tick the chip changes colour, and a server aggregate
cannot do that without either a round trip (visible lag) or a duplicate
client-side calculation to tide it over — at which point the route is not
saving any work. Filters have the same problem: the tabs and the filter rail
narrow the same in-memory array the stats are derived from, so the two must
agree exactly.

Computing over the array is right while the whole table fits in one fetch. The
point to revisit is pagination, not row count on its own: once
`GET /api/leads` stops returning everything, the client no longer *has* the
data to count, and stats, filtering and sorting all have to move to the server
together. A `/api/leads/stats` route added before then would be a second source
of truth for numbers the client can already compute.

## Expected CSV columns

`name, address, categories, phone_number, website, rating, owner, url` — the
scraper's output. Common aliases (`phone`, `business_name`, `link`, …) are
accepted; unrecognised columns are ignored with a warning. Rows with no name are
skipped. A "phone" with fewer than 7 digits counts as no phone, and that row —
along with any repeat of an earlier row — is filtered out before import. The
banner reports how many of each were removed.
## A note on the `xlsx` dependency

The npm-registry build of `xlsx` is pinned at 0.18.5 and carries two
unfixable advisories (prototype pollution, ReDoS). SheetJS moved distribution
to their own CDN, where both are fixed, so `package.json` points at
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. It is the same package
with the same API; `npm audit` is clean. If you ever re-add it from the
registry, the advisories come back.
