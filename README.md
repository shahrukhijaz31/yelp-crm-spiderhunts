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
  (portal)/settings/page.tsx  placeholder for backend config  — ADMIN
  (portal)/users/page.tsx     accounts and roles              — ADMIN
  api/auth/login/route.ts     POST — verify a password, mint a session
  api/auth/logout/route.ts    POST — delete the session row, clear the cookie
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

- **Reads** — `listLeads()` in `lib/leadDb.ts`, called by `app/layout.tsx` for
  the initial render and by `GET /api/leads`.
- **Writes** — `updateLead()` in `components/LeadsProvider.tsx` is still the
  only mutation path in the UI. It updates state immediately, then
  `PATCH /api/leads/[id]` in the background, and puts the old value back if the
  save fails.
- **Upload** — `POST /api/leads/upload` parses with `parseLeadsCsv(csvText)` —
  the same function the browser used to call, unchanged — and replaces the
  table inside a transaction.
- **Scraper ingest** — `POST /api/leads/ingest`, same parser, but it *merges*.
  See below.
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
curl -sS https://leadportal.169-58-34-205.sslip.io/api/leads/ingest \
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
export LEAD_PORTAL_URL=https://leadportal.169-58-34-205.sslip.io
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
