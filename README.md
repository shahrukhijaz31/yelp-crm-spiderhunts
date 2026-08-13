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
- **Call recordings** — one row on each meeting card, in the Meetings view.
  An agent picks an audio file (MP3, WAV, M4A, WebM, OGG, up to 25MB),
  confirms they are authorized to record and share the call, and watches a real
  progress bar; the card then shows a compact player with play/pause, a
  scrubber and the running time, plus the filename, size, who uploaded it and
  when. Admins see and can play every recording — which is the point, since the
  admin is the one taking the meeting — and can delete any of them. An agent
  sees only their own uploads and may replace or delete only those.
  Enforcement is entirely server-side (`lib/recordings.ts`): the audio has no
  public URL, and playback is an authenticated range-streamed route, so no file
  is downloaded just to be listened to. The bytes live on disk under
  `RECORDINGS_DIR`; Postgres holds only the metadata.
- **Performance tracking** — a work-session clock and a per-agent record of what
  was actually worked. Signing in starts a shift in Postgres; the top bar counts
  up from the row rather than from a browser timer, so a refresh does not reset
  it. An agent sees their own figures — a "My day" band above the worklist and a
  fuller `/my-performance` — and nothing else; admins get `/reports/team`, with
  date and agent filters, KPI cards, a per-agent table and the shape of the
  period. Both are counted by Postgres from `lead_activities` and
  `work_sessions`; every number is a count of something an agent saved, there
  are no targets or estimates, and nothing is counted in the browser.
  See **Performance and work sessions** below.
- **App usage** — which applications held the foreground during a shift, and for
  how long, reported by the desktop Monitor. Admin-only: an application table
  with total time and share, employee / date-range / application filters, an
  employee view carrying tracked time and the activity figure beside the
  breakdown, and an optional segment-by-segment daily timeline. No window
  titles, URLs or document names are ever stored, and **no application is
  classified as productive or unproductive** — the feature reports time and
  makes no judgement, and it does not touch the activity percentage or the
  productivity score. See **App usage tracking** below.
- **Themes** — dark (graphite + signal red) and light (cool slate), toggled from
  the nav bar and persisted to localStorage via next-themes. Colour lives in one
  place: every token is a `--c-*` variable defined twice in `app/globals.css`
  and pointed at by `@theme`, so components never name a theme.

## Authentication and roles

Nothing in the portal is reachable without signing in, and the two roles are
enforced on the server.

**Sessions.** Opaque 256-bit tokens in an HttpOnly, SameSite=Lax cookie
(`__Host-lp_session` in production, `lp_session` in development, where
`__Host-` would be unsettable over plain http). Only the SHA-256 of the token
is stored, in the `sessions` table. The cookie carries no user id and no role,
so the browser cannot describe itself — every request resolves the session row
in Postgres and reads the role from `users`. Idle expiry is 12 hours, pushed
forward at most once an hour; an absolute ceiling of 7 days is never extended.

**Logout** deletes the row, so the old cookie is dead server-side rather than
merely dropped by the browser.

**Route protection** is layered, and only the middle layer is load-bearing:

| Layer | Does | Trusts |
| --- | --- | --- |
| `proxy.ts` | redirects requests with no session cookie; sets `Cache-Control: no-store` | nothing — a cookie's *presence* only |
| `lib/authz.ts` | the real check, inside every protected page and route handler | the `sessions` + `users` rows |
| `NavBar` | hides tabs a role cannot use | nothing; it is tidiness |

**Who can do what** — the list lives in `lib/access.ts` and is read by all
three layers:

| | ADMIN | AGENT |
| --- | --- | --- |
| Worklist, search, filters, status/notes/callbacks, Meetings | yes | yes |
| Export Data (`/export`), Upload CSV (`/import`) | yes | no |
| Reports, Settings, Users | yes | no |
| `GET /api/leads`, `PATCH /api/leads/:id` | yes | yes |
| `POST /api/leads/upload`, `/api/users*` | yes | **403** |
| Upload a call recording against a meeting | yes | yes |
| Play / read / replace / delete a call recording | any | only their own uploads — **404** for anyone else's |
| Team Performance (`/reports/team`, `GET /api/reports/team`) | yes | **403** |
| Their own figures (`/my-performance`, `GET /api/performance/me`) | yes | yes — own row only, always |

An agent who types an admin URL gets an Access Denied screen — not the login
form, which they have already satisfied. There is deliberately no endpoint at
any privilege level that lets a user change their own role.

**Creating the first administrator.** No account is seeded and no credentials
exist in the code or the environment:

```bash
npm run user:create -- --name "Jane Doe" --username jane \
                       --email jane@example.com --role ADMIN
```

With no `--password` one is generated and printed once. After that,
administrators add people from the Users screen.

## Structure

```
app/
  layout.tsx                  document shell only: fonts, theme (wraps /login too)
  login/page.tsx              sign-in; redirects away if already authenticated
  (portal)/layout.tsx         the authenticated app: requireUser, NavBar, LeadsProvider
  (portal)/page.tsx           Worklist — the call list
  (portal)/meetings/page.tsx  booked calls, grouped by day
  (portal)/import/page.tsx    CSV import          — ADMIN
  (portal)/export/page.tsx    CSV / XLSX / PDF    — ADMIN
  (portal)/reports/page.tsx   summary + full status breakdown — ADMIN
  (portal)/reports/team/page.tsx
                              team performance: KPIs, per-agent table — ADMIN
  (portal)/reports/time/page.tsx
                              live employee monitoring board            — ADMIN
  (portal)/reports/time/[userId]/page.tsx
                              one employee's tracking, plus corrections — ADMIN
  (portal)/reports/timesheets/page.tsx
                              period totals and a day-by-day sheet      — ADMIN
  (portal)/my-performance/page.tsx
                              the caller's own figures — every role, own row only
  (portal)/time-tracking/page.tsx
                              the caller's own tracked time — every role, own row only
  (portal)/downloads/page.tsx the SpiderHunts Monitor installer — every role
  (portal)/settings/page.tsx  placeholder for backend config  — ADMIN
  (portal)/users/page.tsx     accounts and roles              — ADMIN
  api/auth/login/route.ts     POST — verify a password, mint a session
  api/auth/logout/route.ts    POST — delete the session row, close the shift, clear the cookie
  api/auth/logout/route.ts    (also closes the work session — see below)
  api/performance/me/route.ts GET — the caller's own figures; takes no parameters
  api/reports/team/route.ts   GET — every agent's figures       — ADMIN
  api/time-tracking/me/route.ts
                              GET — the caller's own tracking; takes no parameters
  api/monitor/activity/route.ts
                              POST — the Monitor reports one activity interval
  api/reports/time/route.ts   GET — the live monitoring board   — ADMIN
  api/reports/time/[userId]/route.ts
                              GET — one employee's tracking     — ADMIN
  api/reports/timesheets/route.ts
                              GET — timesheet and period report — ADMIN
  api/time-adjustments/route.ts
                              GET/POST — manual corrections and their audit trail — ADMIN
  api/work-session/heartbeat/route.ts
                              POST — "this browser is still open"
  api/downloads/monitor/route.ts
                              GET — the Monitor installer, streamed — every role
  api/downloads/monitor/info/route.ts
                              GET — its version, filename and size  — every role
  api/leads/route.ts          GET — every lead, from Postgres
  api/leads/[id]/route.ts     PATCH — persists one inline edit
  api/leads/upload/route.ts   POST — parses a CSV and merges it in, never wipes
  api/leads/ingest/route.ts   POST — the scraper's push: merges, token-guarded
  api/meetings/[leadId]/recording/route.ts
                              GET/POST/DELETE — a meeting's call recording
  api/meetings/[leadId]/recording/stream/route.ts
                              GET — the audio, authenticated, Range-aware
  api/users/route.ts          GET/POST — accounts            — ADMIN
  api/users/[id]/route.ts     PATCH — role, disable, rename  — ADMIN
proxy.ts                      first gate: no session cookie -> /login (Next 16 middleware)
components/
  LeadsProvider.tsx           the store: leads, workspace (tab/filters/selection), stats
  NavBar.tsx / ViewTabs.tsx   app shell nav and the worklist's tabbed views
  Worklist.tsx                headline strip -> tabs -> filter rail -> table
  LeadTable / LeadRow / ...   the list itself
lib/
  types.ts                    Lead + CallStatus + status colours — single source of truth
  access.ts                   the access policy: cookie name, public/admin paths, callbackUrl
  session.ts                  create/verify/destroy sessions against Postgres
  authz.ts                    requireUser / requireRole / apiUser / apiAdmin
  password.ts                 scrypt hashing, on node:crypto alone
  userDb.ts                   every users query; passwordHash never leaves login
  loginThrottle.ts            per-account and per-IP brake on password guessing
  prisma.ts                   Prisma Client singleton (survives dev hot reload)
  leadMapping.ts              database row <-> Lead; pure, no client
  leadDb.ts                   every query, plus PATCH body validation
  ingestAuth.ts               bearer-token check for the scraper endpoint
  mockLeads.ts                dev fixture for `npm run db:seed -- --demo`
  parseLeadsCsv.ts            CSV -> Lead[], runtime-agnostic
  cleanLeads.ts               ingestion gate: phone validity + de-duplication
  exportLeads.ts              one row-shaping definition -> CSV / XLSX / PDF
  leadUtils.ts                duplicates, callback state, stats
  views.ts                    the tab scopes (all / callback / overdue / issues)
  meetings.ts                 derived agenda: membership, buckets, day grouping
  recordingRules.ts           call-recording limits, formats, magic-byte sniff (pure)
  recordings.ts               call-recording queries and the permission policy
  recordingStorage.ts         the object store: a directory, addressed by key
  filters.ts                  filter model, matching predicate, active-chip list
  leadActivity.ts             classifies a save into the acts it represents, and writes them
  workSessions.ts             shifts: open/resume, heartbeat, logout, stale reconciliation
  performanceRules.ts         ranges, shapes, rates, clock formats — pure, client-safe
  performance.ts              the reporting aggregates; counted by Postgres, never in JS
  activityPolicy.ts           interval, idle threshold, calibration — server-owned, from env
  activityRules.ts            activity validation, the percentage formula, shapes — pure
  activity.ts                 writes one interval; derives user and shift server-side
  timeTracking.ts             the time/activity aggregates and manual corrections
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

4. Create an account to sign in with — the seed creates leads, never users:

   ```bash
   npm run user:create -- --name "Jane Doe" --username jane \
                          --email jane@example.com --role ADMIN
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
| `npm run user:create` | create a user (`-- --name … --username … --email … --role ADMIN`) |
| `npm run test:recordings` | end-to-end check of the call-recording feature against a running server |

`prisma generate` runs on `postinstall` and again at the start of `npm run
build`, so a fresh clone or a schema change never needs it typed by hand. The
generated client lands in `lib/generated/prisma` and is gitignored.

### How the layers fit

- **Paged reads** — `listLeadsPage()` in `lib/leadDb.ts`, called by
  `app/(portal)/page.tsx` for the worklist's first page and by
  `GET /api/leads` for every page after it. See the note below.
- **Whole-table reads** — `listLeads()`, called by the four routes whose job is
  the whole table: `/export`, `/meetings`, `/reports` and `/import`. Each mounts
  `LeadsProvider` itself; the portal layout no longer does.
- **Aggregates** — `leadStats()`, `leadCategories()` and `leadWorkCounts()`,
  counted by Postgres. The layout seeds the nav bar's counters from the first
  and the sidebar's New/Called counts from the third; the filter panel's
  category list comes from the second.
- **Writes** — `useLeadEditor()` in `components/useLeadEditor.ts` is still the
  only mutation path in the UI, now shared by the worklist and by
  `LeadsProvider`. It updates state immediately, then `PATCH /api/leads/[id]`
  in the background, and puts the old value back if the save fails.
- **Upload** — `POST /api/leads/upload` parses with `parseLeadsCsv(csvText)` —
  the same function the browser used to call, unchanged — and merges into the
  table.
- **Scraper ingest** — `POST /api/leads/ingest`, same parser, also merges.
  See below.
- **Attribution** — the same `PATCH /api/leads/[id]` write also appends to
  `lead_activities`, using the user the session row resolved to. That log and
  `work_sessions` are the only source of the per-agent figures; both are
  aggregated by Postgres in `lib/performance.ts`. See **Performance and work
  sessions** below.

### Pagination: why the filtering moved to Postgres

The worklist held every lead in React state and narrowed it with
`matchesFilters` on each render. That was the right shape while the table fit
in one fetch, and the wrong one by ~1,700 rows: opening the call list meant
downloading the entire database in order to display twenty of it, and the cost
grew with every scraper run — on every route, because the *layout* did the
loading, including `/settings`, which has no leads on it.

The queue, the tab, the filter rail, the page and the page size now travel to
`GET /api/leads` as query parameters (`lib/leadQuery.ts` defines the vocabulary
and validates it) and Postgres does the narrowing. Responses are bounded by the
page size, at most 100 rows.

### New and Called

**New** and **Called** are the two lead queues, and they are the top group in the
sidebar rather than tabs inside the worklist — picking between them is the same
kind of decision as picking the worklist over the agenda, and in the rail their
counts are visible from every screen. The portal opens on New.

The queue is held for the shell by `LeadQueueProvider` (mounted in the portal
layout, beside `PortalStatsProvider`), because the control is in the layout and
the screen that answers to it is in the route. It is app state rather than a URL
parameter, like the view tabs and the filter rail and for the same reason:
switching queues is one bounded fetch with the rows dimmed, not a whole screen
re-rendered from the server. The worklist shows which queue it is displaying as
a label beside the view tabs, since the rail collapses to icons on a laptop and
off-canvas on a phone.

The split itself is one column, `leads.first_called_at` (`lib/workState.ts`):

- **Null is New, non-null is Called.** Nothing about it lives in React, so a
  reload, another agent or another browser all see the same answer.
- **It is stamped once**, in `updateLeadFields`, when a `PATCH /api/leads/:id`
  carries a status other than `not_called` and the column is still null. Opening
  a lead, expanding it, dialling the number or typing into a field reach no
  write, so none of them move it — saving the outcome is what counts as having
  called. Nothing ever clears it, so a later status change (including a
  correction back to "Not called") leaves the lead in Called.
- **It is not a status.** A lead is Called *and* Interested, or Called *and* No
  answer; the eight `CallStatus` values are untouched by any of this. The older
  `isCalled(status)` approximation still drives the headline "called" figure and
  is deliberately not what the queues read — a corrected mis-click would
  otherwise push an already-dialled lead back in front of an agent to redial.
- **The queue is the outermost `WHERE`**, so search, filters, sorting and the
  pager all operate inside it and behave exactly as they did. New keeps the
  worklist's insertion order; Called leads with the most recently worked, which
  is `updated_at` — a heading click overrides both.
- **The two counts in the rail are workspace-wide**, like every other badge in
  the shell: "how much is left to call" must not drop as an agent types in the
  search box. The filtered number is the pager's — "Showing 1–20 of 42". They
  are seeded by the layout from `leadWorkCounts()` and replaced by whatever came
  back with the worklist's last request, so they move when an outcome is saved.

Three consequences worth knowing about:

- **`WHERE` is raw SQL** (`leadFilterSql` in `lib/leadDb.ts`), which is the one
  place in the app that is. `matchesFilters` compares phone numbers by *digits*,
  so that `4155550182` finds `(415) 555-0182`, and that needs
  `regexp_replace` on the column side of the predicate — which Prisma's `where`
  has no room for. Only `count(*)` and `id` are selected raw; the page's rows
  are read back through `prisma.lead.findMany` and mapped by the same `toLead`
  as every other read. Every value is a bound parameter.
- **The counts are a server aggregate now.** They used to reflect an optimistic
  edit on the same tick the chip changed colour, because the browser held every
  lead and could recount them. It no longer does, so after a save the worklist
  re-reads the counts alone (`?rows=0`, debounced) — a few hundred milliseconds
  behind the chip rather than instant. On `/export`, `/meetings`, `/reports`
  and `/import`, `LeadsProvider` still counts locally and pushes its figures up,
  so those screens are exactly as live as they were.
- **A saved row does not vanish under you.** The old client-side filter dropped
  a lead from the list the instant it stopped matching. Re-running the query
  after every save would do the same and cost a round trip for the privilege, so
  the rows stay put until the agent changes tab, filter or page.

`page` and `pageSize` are mirrored into the URL (`?page=2&pageSize=20`) with
`history.replaceState`, so a reload keeps its place without a navigation that
would re-render the screen server-side. The tab and the filters are deliberately
not in the URL: they change on nearly every interaction, and the back button
would walk an agent backwards through their own typing.

## Scraper ingest — `POST /api/leads/ingest`

The Yelp scraper is a **separate project in a separate directory**, so it has no
access to `lib/` or to Postgres. When a run finishes it POSTs the CSVs from its
output folder to this endpoint.

**It merges, it does not replace.** A business already in the portal is skipped
and left completely untouched — statuses, notes and booked callbacks survive
every re-scrape, and so do scraped fields an agent has corrected by hand. That
is the whole reason this is a second route rather than a flag on
`/api/leads/upload`: the destructive "replace the worklist" behaviour stays on
the screen where a human chose it, instead of sitting one typo away in a cron
line. "Already have it" is decided by `identityKeys` in `lib/cleanLeads.ts` —
the same phone, or the same business name at the same address — which is the
identical rule applied within a single file, so the two cannot disagree.

**Auth.** `Authorization: Bearer $INGEST_TOKEN`. This is the only route exempt
from the nginx Basic Auth in front of everything else (it is called by a
machine, not a browser), so it carries its own credential. With `INGEST_TOKEN`
unset the route refuses every request with a 503 rather than falling open.

**Sending.** Repeat the `file` field to push a whole folder in one request;
32MB per push.

```bash
curl -sS https://leads.spiderhunts-coworkingspace.com/api/leads/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "X-Batch: yelp-dentists-chicago" \
  -F file=@output/page1.csv -F file=@output/page2.csv
```

A raw body works too, for a one-liner:
`--data-binary @out.csv -H 'Content-Type: text/csv' -H 'X-Filename: out.csv'`.

`scripts/push_leads.py` is the client for the scraper side — **copy it into the
scraper project**; it lives here only so the endpoint and its caller cannot
drift. Standard library only, no dependencies:

```bash
export LEAD_PORTAL_URL=https://leads.spiderhunts-coworkingspace.com
export LEAD_PORTAL_TOKEN=...          # /etc/leadportal/ingest-token on the server
python push_leads.py ./output --batch yelp-dentists-chicago
```

**Response.** `200` with `{ inserted, skippedExisting, sourceBatch, files: [...] }`,
where `sourceBatch` stamps every row of the push so a run can be traced or
filtered later. Per-file parse warnings come back in `files[]`, and
`rejectedFiles` names any CSV that yielded nothing. A push where *no* file
yielded a usable row is a `400`, not a quiet `200` — on a scheduled job, "0
rows" that looks like success is how a broken scraper goes unnoticed for a week.

Re-pushing the same folder is safe: the second run inserts nothing.

## Call recordings

Audio of a phone call, attached to a meeting so an admin can listen before
taking it. It lives in the Meetings view as one row on the meeting card — there
is no separate screen.

**A meeting is a lead.** Membership of the Meetings view is derived
(`lib/meetings.ts`: interested, or a date in the diary), so there is no
`meetings` table to point a foreign key at, and inventing one would create a
second answer to "what is on the agenda". `meeting_recordings.lead_id` is the
meeting, unique — one current recording per meeting, and replacing means
replacing.

**Postgres holds metadata only.** `meeting_recordings` has the filename, the
sniffed content type, the size, the duration, who uploaded it, when, and a
`storage_key`. The audio is a file under `RECORDINGS_DIR`
(`lib/recordingStorage.ts`), sharded `YYYY/MM/<32 random hex>.<ext>`, with the
key generated server-side so no part of a path is attacker-influenced. A 25MB
`bytea` per meeting would ride along in every backup and every careless
`SELECT *` to buy nothing a file does not already give.

Why a directory and not S3: this deploys to one VPS behind nginx, and an object
store would mean another provider, another set of credentials in
`/etc/leadportal/env`, and another way to be misconfigured. Everything outside
`lib/recordingStorage.ts` addresses audio by an opaque key, so if that changes,
swapping the body of four functions is the whole migration.

**Permissions**, enforced in `lib/recordings.ts` and nowhere else:

| | ADMIN | AGENT |
| --- | --- | --- |
| Upload against a meeting | yes | yes — the worklist is shared, so every meeting is theirs to manage |
| Listen / read metadata | every recording | only recordings they uploaded |
| Replace | any | only their own |
| Delete | any | only their own |

An agent asking about someone else's recording gets the same `404` as one
asking about a meeting that does not exist, so probing ids reveals nothing.
The UI hides buttons a role cannot use; that is tidiness — the checks above are
what stop `curl`.

**Security.** There is no public URL. The storage root is not under `public/`,
nginx has no location for it, and the only way audio leaves the server is
`GET /api/meetings/:leadId/recording/stream`, which resolves the caller from
their session row before it opens the file. That route answers `Range` requests
with `206`, which is what lets the player show a duration and scrub without
downloading the call first. Uploads are validated by magic bytes, not by the
`Content-Type` the browser claims, and the stored type is the sniffed one — so
a file cannot be stored as audio and served back as something a browser would
render.

**Testing.** `npm run test:recordings` signs in over HTTP as a throwaway admin
and two throwaway agents, and checks the lot: valid upload, invalid type,
disguised type, oversized, streaming, range and suffix-range, replace, delete,
cross-agent refusal, signed-out refusal, and that the Meetings page still
renders. It creates and removes its own users and recordings, and needs the app
running (`npm run dev`, or `TEST_BASE_URL=… ` against any instance).

## Performance and work sessions

Two questions the lead tables could not answer on their own: **who** worked a
lead, and **how long** was somebody here. Both needed a place to be recorded —
`leads` holds the outcome but not the actor and is overwritten in place, and
`sessions` is one row per browser cookie and is deleted at logout. So there are
two new tables and no changes to any existing one.

### What is counted, and what deliberately is not

`lead_activities` is an append-only log written from the one endpoint that
persists an agent's work, `PATCH /api/leads/:id`, using the user the *session
row* resolved to — never anything the request body claims. A save becomes one or
more of four acts (`lib/leadActivity.ts`):

| Act | Written when |
| --- | --- |
| `call_logged` | the save carries a status and it is a called status — the same condition that stamps `first_called_at` |
| `meeting_booked` | a meeting time was set, and a date ends up on the lead |
| `callback_scheduled` | a date was set or changed with no time — the `else` of the rule above, so one save is never both |
| `meeting_completed` | the meeting was marked done, on the transition only |

Opening a lead, expanding a row, dialling the number, searching or paging reach
no write and therefore produce no statistic. Setting a lead *back* to "Not
called" is somebody undoing a mis-click and does not count as work. A
notes-only save is bookkeeping, not a call.

The outcome is copied onto the activity row rather than joined from the lead:
`leads.status` is where a lead stands *now*, so reading it would let last week's
numbers rewrite themselves whenever somebody corrects a status today.

### Work sessions

`work_sessions` is a **shift** — at most one open row per user at any moment,
whatever they are browsing from, kept after it ends.

- **Multiple tabs and browsers.** Signing in *resumes* the open shift instead of
  opening a second one, so a second tab, window or device adds no time at all.
  The invariant is enforced in `openOrResumeWorkSession` inside a transaction,
  and the reconciliation sweep collapses any duplicate a simultaneous double
  sign-in could slip past it.
- **Crashes.** An open tab heartbeats once a minute (`POST
  /api/work-session/heartbeat` — no body; whose session it is comes from the
  session row). A shift whose heartbeat has stopped for five minutes is closed
  **at its own last heartbeat**, not at the moment anybody noticed, so a closed
  laptop costs minutes rather than a clock that runs forever. Reports do not
  wait for the sweep: an un-swept shift is clamped to the same instant on read.
- **Logout** closes the shift — but only when no other live authentication
  session remains, so signing out of a phone does not stop the clock on the desk
  someone is still sitting at. Sweeping happens opportunistically at login,
  beside `pruneExpiredSessions`, because this app has no cron.
- **Active time vs login time.** The heartbeat currently means "a portal tab is
  open and visible", so a duration is authenticated session time. Real idle
  detection changes only what the client beats *on*; neither the table nor any
  query here would change.

### The screens

| | Who | Shows |
| --- | --- | --- |
| "My day" band, above the worklist | every role | leads worked, calls, callbacks, meetings, active time — the caller's own |
| `/my-performance` | every role | the above plus the last 7 days, answer and interest rates, the running session clock |
| `/reports/team` | **ADMIN** | KPI cards, a per-agent table, calls/meetings per day, conversion — with date and agent filters |

The date filter offers today, yesterday, last 7 days, last 30 days and a custom
range; the agent filter offers all agents or one. Both are read by
`resolveRange`, which clamps rather than rejects — a reversed custom range is
swapped, and an unknown preset falls back to today — so no report 400s over a
date picker.

### How an agent is kept out of the team report

Not by hiding the nav item. Three things, of which only the first two matter:

1. `apiAdmin()` on `GET /api/reports/team` and `requireRole("ADMIN")` on the
   page, both resolving the caller from the session row in Postgres. An agent
   with a valid session and curl gets a 403 and an Access Denied screen.
2. `/reports` and `/api/reports` are admin prefixes in `lib/access.ts`, so the
   policy for the screen and the policy for its endpoint are written together.
3. The rail does not draw the link. Tidiness; removing it changes nothing.

The personal endpoint is a different shape on purpose: `GET /api/performance/me`
accepts **no parameters at all** — no `?userId=`, no body — and queries
`auth.id`. There is nothing to tamper with, so an agent cannot ask it about a
colleague however they edit the request. Two endpoints rather than one with a
role branch inside it, because the branch is the bug.

### Performance of the reports

Everything is `count`/`sum` with `GROUP BY` over an indexed date range, and the
per-agent rows and the team totals come back from one pass using `GROUPING
SETS`. Nothing is read into the server to be counted there and nothing is sent
to the browser to be counted there, so a response is one row per agent whether
the tables hold a thousand activity rows or ten million. Team `leadsWorked` is a
`COUNT(DISTINCT lead_id)` across everybody rather than the sum of the rows — two
agents who called the same lead worked one lead between them.

**There is no target anywhere on these screens.** Every figure is a count of a
row somebody's save created. An earlier version carried a fixed
`DAILY_LEAD_TARGET` and drew leads-worked as a progress bar against it; it was
removed because it was the only number on the page that had not been measured,
and a round number nobody in the system chose reads as one somebody did. If a
target is wanted it needs an owner and a place to be set — a column on `users`
or a settings row, edited by an administrator — so that "who decided 60?" has an
answer.

## Time and activity tracking

Hubstaff-shaped employee monitoring, built on the two systems that already
existed rather than beside them: the **work session** is still the only thing
that decides when somebody was working, and the **screenshot** pipeline is
untouched. One new table records aggregate keyboard/mouse activity; a second
records manual corrections. No existing table changed.

### Tracked, active, idle — the definition everything rests on

```
tracked = overlap of the window with the agent's work sessions   (work_sessions)
active  = duration of the intervals in it that saw any input     (activity_intervals)
idle    = tracked − active
```

**Tracked time is never summed from activity intervals**, and that is not a
stylistic preference. Intervals arrive from a desktop client that may be closed,
uninstalled or offline, so hours computed from them would silently under-report
an agent who worked all day with the Monitor shut. The portal knows when
somebody was signed in and working; that is what a timesheet is made of.
Intervals describe what happened *inside* that time and can only be a subset of
it — which is also why `idle` includes any stretch no interval covered at all.
The portal will not claim input it never observed.

A consequence worth stating plainly: an employee with no Monitor installed has
their **hours counted in full** and their activity shown as "no data", never as
0%.

> `activeSeconds` on the *performance* report (`lib/performanceRules.ts`) is an
> older name meaning "seconds signed in". Time tracking calls that `trackedSeconds`
> and reserves "active" for input. The two live in separate modules and never
> appear in one payload.

### The activity percentage

```
observed   = keyboardActivityCount + mouseActivityCount
expected   = ACTIVITY_EXPECTED_EVENTS_PER_MINUTE × (durationSeconds ÷ 60)
percentage = round(min(100, observed ÷ expected × 100))
```

Computed **by the server**, from the raw counts and the server's own configured
rate. A percentage in the request body is discarded, so a workstation cannot
report itself as busy — only as having had events, and those are bounded.

**It measures keyboard and mouse input and nothing else.** A fifteen-minute call
that ends in a booked meeting scores near zero, and that is the metric working
rather than failing. Every screen that shows it says so in words beside it, and
none of them ranks anybody by it.

**Nothing about the input itself is stored** — no keystrokes, no typed text, no
key names, no mouse coordinates, no clipboard, no window titles, no URLs. Two
integers per interval. There is nowhere in the schema for anything else to go.

### What the Monitor sends

`POST /api/monitor/activity`, bearer-authenticated by the **existing** device
credential (`monitorDevice()`), AGENT-only, with role and `isActive` re-read from
Postgres on every call.

```json
{ "startedAt": "…", "endedAt": "…",
  "keyboardActivityCount": 40, "mouseActivityCount": 20,
  "clientKey": "an idempotency token" }
```

There is **no `userId` and no `workSessionId` in that shape.** The user comes
from the device the token resolved to; the shift comes from the portal's own
`getActiveWorkSession`. A body carrying those fields is sending fields nothing
reads — which is stronger than ignoring them, because there is no check to
forget.

- **No open shift → 409, and no shift is created.** Nothing on this path writes
  to `work_sessions` at all. The Monitor cannot start, extend or end anybody's
  working day.
- **Retries are safe.** The unique index on `(work_session_id, client_key)` *is*
  the duplicate protection: a resend answers `200 {duplicate: true}` with the row
  already stored, a first delivery answers `201`. First write wins, visibly. No
  queue, and it holds under concurrency because Postgres enforces it.
- **Timestamps are validated, not clamped.** Refused if the window ends in the
  future, is more than 15 minutes old, is shorter than 10s or longer than twice
  the configured interval, or starts before the shift it would attach to. Unlike
  a screenshot's `capturedAt` — where the image is genuine and only its label is
  wrong — an interval *is* its timestamps, so clamping would invent time and add
  it to somebody's record.

### The screens

| | Who | Shows |
| --- | --- | --- |
| `/time-tracking` | every role | the caller's own: live session clock, today/week tracked, active, idle, activity %, recent sessions and intervals, today's screenshot count |
| `/reports/time` | **ADMIN** | live board — employees, working/inactive/offline, today and this week, activity %, last input, current shift |
| `/reports/time/:id` | **ADMIN** | one employee: sessions, intervals, meetings from the existing lead log, screenshot count, corrections — and the Correct button |
| `/reports/timesheets` | **ADMIN** | daily/weekly/monthly/custom: per-employee totals and a day-by-day sheet, with employee, activity and status filters |

`/time-tracking` is not an admin path for the same reason `/my-performance` is
not: it is a rule about *whose* row, not about a path. `GET /api/time-tracking/me`
accepts no parameters and queries `auth.id`, so there is nothing to tamper with.

**Agents see no screenshots, including their own** — the rule `lib/access.ts`
already states, unchanged. Their page shows a count and capture times, which is
the part that makes the monitoring honest to the person being monitored.

Every admin endpoint aggregates in Postgres: one row per employee, or one per
employee per worked day. No screen streams activity rows to a browser to add
them up there.

### Manual corrections

`POST /api/time-adjustments`, ADMIN only, on **finished** sessions only — an open
shift is still being written by the agent's own heartbeat, and two writers on one
row is not a race worth having.

The correction is applied to the `work_sessions` row and an immutable
`time_adjustments` record is written **in the same transaction**: admin, agent,
session, the whole previous state, the whole new state, a required reason, and
the time. There is no ordering or crash that leaves a shift altered with no
record of who altered it, and nothing in the application updates or deletes an
audit row.

The alternative — leaving the session untouched and layering a delta that every
report adds back — was rejected: it would mean a correction term in every
aggregate query, and the first one written without it would report an
uncorrected figure that looks exactly like a corrected one.

Agents cannot reach any of this. There is no agent-facing endpoint anywhere in
this feature that writes to `work_sessions` or `activity_intervals`.

### Configuration

Three environment variables — `ACTIVITY_INTERVAL_SECONDS`,
`ACTIVITY_IDLE_THRESHOLD_SECONDS`, `ACTIVITY_EXPECTED_EVENTS_PER_MINUTE` — read
at call time with a documented fallback and a warn-once, exactly as the
screenshot policy is (`lib/activityPolicy.ts`). They ride to the workstation on
the poll it already makes, `GET /api/monitor/session`.

There is no UI for them, deliberately. An agent must not be able to change how
their own activity is measured, and a root-owned `/etc/leadportal/env` cannot be
reached from any request whatever the caller's role. The idle threshold in
particular **stops nobody's clock** — it decides a label and the active/idle
split, and an idle agent is still on the clock because they are still at work.

### Testing it

```
npm run dev             # in one terminal
npm run test:activity   # in another
```

72 checks against the real routes and the real database: submission, automatic
attribution, the ignored-identity fields, every authentication refusal, the
409-not-a-new-shift rule, retries, eleven kinds of implausible value, both
permission directions, and the correction audit trail. It creates throwaway
accounts (`acttest-*`) and removes everything it made, including after a failure.

## App usage tracking

The third thing a work session can contain, beside screenshots and activity
intervals:

```
Work Session
  ├── Activity Intervals   (how much input)
  ├── Screenshots          (what the screen looked like)
  └── App Usage            (which application had the foreground)
```

One new table (`app_usage`) and no change to any existing one. The work session
is still the only thing that decides when somebody was working, the screenshot
pipeline is untouched, the activity percentage is unchanged, and the
productivity score does not read this data.

### What is recorded, and what deliberately is not

Two labels and a window: the executable (`chrome.exe`), the application it
belongs to (`Google Chrome`), when it took the foreground and when it lost it.

**Never recorded**: window titles, URLs, page addresses, document names,
keystrokes, typed text, mouse coordinates. There is nowhere in the schema for
any of it to go. A process *path* is reduced to its executable on the way in —
`C:\Users\umar\…\slack.exe` is stored as `slack.exe` — because a path carries an
account name and the shape of somebody's disk, and an `applicationName` that
looks like a URL is refused rather than truncated.

**No application is classified.** There is no productive / unproductive /
distracting split, no category, no weight and no score anywhere in the feature.
Chrome is not productive, WhatsApp is not a distraction, and VS Code is not
either. The system reports usage time; the judgement stays with the person
reading it.

### What the Monitor sends

`POST /api/monitor/app-usage`, bearer-authenticated by the **existing** device
credential (`monitorDevice()`), AGENT-only, with role and `isActive` re-read
from Postgres on every call.

```json
{ "processName": "chrome.exe", "applicationName": "Google Chrome",
  "startedAt": "…", "endedAt": "…", "clientKey": "an idempotency token" }
```

There is **no `userId` and no `workSessionId` in that shape.** The user comes
from the device the token resolved to, the shift from the portal's own
`getActiveWorkSession`, the device from the credential, and the duration from
the two timestamps.

- **No open shift → 409, and no shift is created.** Nothing on this path writes
  to `work_sessions` at all.
- **Retries are safe.** `client_key` is unique: a resend answers
  `200 {duplicate: true}` with the row already stored, a first delivery `201`.
  A key already used by another account is a 409 `client_key_conflict` instead —
  the two must not be answered the same way.
- **Timestamps are validated, not clamped.** Refused if the segment is shorter
  than 5s, longer than 4h, ends more than 15 minutes from the server's clock, or
  starts before the shift it would attach to.

### The report

```
tracked   = overlap of the window with the agent's work sessions   (work_sessions)
recorded  = app usage reported inside it                           (app_usage)
coverage  = recorded ÷ tracked
```

Tracked time is **never** summed from app usage, for the reason time tracking
gives at length: an agent working with the Monitor closed still has their hours
counted in full and simply reports no applications. Coverage is the honesty
figure — it says how much of the working day the breakdown actually describes.

Each application row carries two shares, because there are two honest
denominators: **share of recorded app time** (the rows add to 100%) and **share
of tracked time** (they do not, and the gap is real). The table lists the top
eight applications and folds the tail into one `Other` row, which carries the
whole remainder, so the column still adds up.

| | Who | Shows |
| --- | --- | --- |
| `/reports/app-usage` | **ADMIN** | applications, total time, share, coverage; employee and application filters; today / this week / this month / custom |
| `/reports/app-usage` + an employee | **ADMIN** | that person's tracked time, activity %, application breakdown, and an optional segment-by-segment daily timeline |
| `/reports/time/:id` | **ADMIN** | the same breakdown beneath their existing tracking record |

**Admin-only, server-side.** `/reports` and `/api/reports` are already admin
prefixes in `lib/access.ts`; every page runs `requireRole("ADMIN")` and every
endpoint `apiAdmin()`, and the two are reached separately because a page guard
cannot protect an API somebody calls with curl. There is **no agent-facing app
usage endpoint at all**, not even one returning only the caller's own — the same
rule screenshots follow.

Every figure is a grouped aggregate in Postgres. The report returns at most nine
application rows however many segments the window holds; the only read that
returns a row per segment is the optional timeline, which takes one agent and is
capped at 500 with a `truncated` flag. Indexes: `(user_id, started_at)`,
`(work_session_id, started_at)`, `(started_at)`, `(application_name, started_at)`
and `(monitor_device_id)`.

### Testing it

```
npm run dev              # in one terminal
npm run test:app-usage   # in another
```

Checks against the real routes and the real database: submission and automatic
attribution, the ignored-identity fields, that no window title or URL survives,
every authentication refusal, the 409-not-a-new-shift rule, retries and the
cross-account key conflict, twelve kinds of implausible value, aggregation
arithmetic against the rows in Postgres, employee/date/application filtering,
timeline ordering and cap, both permission directions, a 5,000-row window, and
that leads, screenshots, activity, timesheets, productivity and the monitor
session endpoint all still answer. It creates throwaway accounts (`apptest-*`)
and removes everything it made, including after a failure.

## Monitor installer download

Agents get the SpiderHunts Monitor Windows installer from the portal itself,
rather than from someone emailing them a 77MB attachment. The account menu (top
right) has **Download Monitor**, which is `/downloads`: one card giving the
product name, the platform, the version, the filename and the approximate size,
and a button.

**The installer is not in this repository and not in the release tree.** It is a
file placed on the server by hand during deployment, at
`MONITOR_INSTALLER_PATH` — `/var/lib/leadportal/downloads/…` in production,
`.data/downloads/<filename>` in development. `deploy/deploy.sh` replaces the
whole slot directory on every release, so an installer kept inside it would be
destroyed by the next deploy; this is the same reasoning, and the same location,
as recordings and screenshots. Unlike those two the application only ever
*reads* here, so the systemd unit deliberately does not grant write access to
the directory.

```
GET /api/downloads/monitor        the bytes         — any signed-in user
GET /api/downloads/monitor/info   name/version/size — any signed-in user
```

**Both roles, and nothing else.** `apiUser()` resolves the session from Postgres
on both routes, so an unauthenticated request gets a 401 whatever the UI is
doing; agents are allowed because the Monitor is the software they are required
to run. No role can upload, replace or re-version anything — there is no write
verb in the feature at all, so an agent with curl has exactly the power an agent
with the button has.

**There is no parameter anywhere in it.** Neither route takes a filename, a path
or an id, so "path traversal" and "requesting some other file" are not defended
against so much as absent: `lib/monitorRelease.ts` opens the one path the server
is configured with, and that path never appears in a response, in success or
failure. A missing installer is a clean 404 and the sentence "SpiderHunts
Monitor is temporarily unavailable. Please try again later."

The version lives in one place (`lib/monitorRelease.ts`, overridable with
`MONITOR_VERSION`) and the saved filename is derived from it as
`SpiderHunts-Monitor-Windows-<version>-Setup.exe`, so the page, the download
header and the file on disk cannot drift apart by more than an operator forgetting
to move both env keys at once. Shipping a new build is a copy and two settings —
see `deploy/README.md` → *Monitor installer*.

Nothing about the Monitor application itself changed for this: it is
distribution, not functionality.

### Testing it

```
npm run dev                     # in one terminal
npm run test:monitor-download   # in another
```

Checks against the real routes and the real database: the missing-installer 404
and its message, the unauthenticated and forged-cookie refusals, the page
redirect, agent and admin downloads, content type, attachment disposition,
filename, length against the file on disk and the bytes themselves, the metadata
endpoint's agreement with the download, that neither response leaks a path,
that query parameters change nothing and no sibling route exists, that POST/PUT/
DELETE are 405 even for an administrator, and that leads, screenshots, app
usage, users, time tracking and the monitor session endpoint all still answer as
before. It creates throwaway accounts (`dltest-*`) and removes everything it
made, including after a failure — and it never deletes an installer it did not
itself write.

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
