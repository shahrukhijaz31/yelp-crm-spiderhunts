# `/api/monitor` — the SpiderHunts Monitor desktop client

These endpoints exist for one caller: **SpiderHunts Monitor**, an Electron
application that runs on an agent's Windows workstation (a separate project, in
a separate directory). It will eventually capture screenshots during a work
session; today it authenticates an agent and reports whether the portal says
they are on the clock.

Nothing here is reachable from a browser session, and nothing in the web app
calls it.

## Why a separate route group at all

The desktop client cannot use the existing `/api/auth/*` routes, for two
reasons that are about plumbing rather than policy:

1. **It has no cookie jar.** The web sign-in carries its pending state in the
   `lp_otp` cookie and its session in `lp_session`. A desktop client holds
   tokens instead, so the challenge token comes back in the response body and
   the session is `Authorization: Bearer`.
2. **It must not create a row in `sessions`.** That is the load-bearing one —
   see the next section.

What it very deliberately does *not* do is re-implement authentication.
`findUserForLogin`, `verifyPassword`, `lib/loginThrottle`, `lib/loginOtp` and
`getWorkClock` are all the same functions the web app uses. The OTP in
particular is checked by `verifyLoginOtpForChallenge`, which is the identical
code path the browser reaches — same table, same scrypt hashes, same five
attempts, same five minutes, same single use.

## The `sessions` constraint

`endWorkSessionForLogout` decides whether to stop an agent's shift clock by
**counting the live rows in `sessions`**. If the Monitor put a row there, a
workstation left connected all day would be one of them, so signing out of the
browser would never close the shift and every agent's day would run until the
staleness sweep or midnight. The clock would be quietly, permanently wrong in
the direction of over-reporting hours.

So Monitor credentials live in their own table, `monitor_devices`, and
`sessions` still contains exactly what that function believes it contains:
browsers.

The same separation gives the other required property for free — connecting the
Monitor must not start a shift, and cannot, because nothing on this path calls
`completeSignIn`. `GET /api/monitor/session` reads the work clock and never
writes it. The portal remains the only thing that decides whether an agent is
working.

## Endpoints

| | |
| --- | --- |
| `POST /auth/login` | email/username + password → challenge token. Never a session. |
| `POST /auth/verify` | challenge token + code → access + refresh tokens |
| `POST /auth/resend` | challenge token → a fresh code |
| `POST /auth/refresh` | refresh token → a rotated pair |
| `POST /auth/logout` | revoke this workstation. **Not** a portal logout. |
| `GET  /session` | identity, work-session state, and the screenshot, activity and app-usage policies. Read-only. |
| `POST /screenshots` | upload one desktop capture (multipart). Rate limited. |
| `POST /activity` | report one interval of aggregate keyboard/mouse counts (JSON). |
| `POST /app-usage` | report one foreground application segment (JSON). |

`POST /api/maintenance/screenshot-retention` is *not* in this group and is not
reachable by a workstation — it is the box's cron deleting aged screenshots. See
the Retention section below.

## Screenshots

`POST /api/monitor/screenshots` takes `multipart/form-data` with a `file` part
(JPEG) and two advisory text fields, `capturedAt` and `displayId`.

The image goes to the filesystem (`lib/screenshotStorage.ts`, root from
`SCREENSHOTS_DIR`); Postgres holds metadata only, in `screenshots`. Nothing
serves the storage directory — it is not under `public/`, nginx has no location
for it, and no route reads it yet.

**Nothing identifying is taken from the request.** `userId` comes from the
authenticated device, `workSessionId` from the portal's own `getActiveWorkSession`,
the dimensions from the JPEG's own start-of-frame header, and the storage path
from the server. There is no field an agent could set to file a screenshot
against another account, another shift or another resolution — not because a
check would refuse it, but because the value is never read.

An upload is refused when the agent has no active work session (409). The
work-session read is the only work-session code this path touches, and it
writes nothing: uploading cannot open, extend or close a shift.

## App usage

`POST /api/monitor/app-usage` takes JSON — five fields, no binary:

```json
{ "processName": "chrome.exe", "applicationName": "Google Chrome",
  "startedAt": "…", "endedAt": "…", "clientKey": "an idempotency token" }
```

**Nothing identifying is taken from the request**, exactly as for a screenshot:
`userId` comes from the authenticated device, `workSessionId` from the portal's
own `getActiveWorkSession`, `monitorDeviceId` from the credential itself, and
`durationSeconds` from the two timestamps. There is no field an agent could set
to file usage against another account or another shift.

**What is never stored**: window titles, URLs, document names, keystrokes, mouse
coordinates. Two labels and a window, and there is nowhere in `app_usage` for
anything else to go. A `processName` arrives as a path and is reduced to its
executable (`chrome.exe`, never `C:\Users\…`); an `applicationName` that looks
like a URL is refused rather than truncated.

**No application is classified.** There is no productive/unproductive split
anywhere in the feature, and nothing here feeds the productivity score.

A submission is refused when the agent has no active work session (409) — and no
shift is created to receive it. A segment shorter than 5s, longer than 4h,
ending more than 15 minutes from the server's clock, or starting before the
shift is refused rather than clamped (422). Retries are safe: `client_key` is
unique, so a resend answers `200 {duplicate: true}` with the stored row and a
first delivery answers `201`. A key already used by **another account** is a 409
`client_key_conflict` rather than a duplicate — telling workstation B that
workstation A's segment is "already stored" would let B believe its own data
landed when it never did.

The read side is admin-only (`/reports/app-usage`) and is not reachable from a
workstation. No agent may read app usage, including their own.

## The cadence, and who decides it

Screenshots are taken by the workstation on a **randomised** schedule — a fresh
delay drawn from `[min, max]` before every capture, never a fixed interval and
never one at login. The randomisation happens on the workstation; the *bounds*
come from here.

`GET /api/monitor/session` carries them:

```json
"screenshotPolicy": { "minIntervalSeconds": 600, "maxIntervalSeconds": 1800 }
```

`SCREENSHOT_MIN_INTERVAL_MINUTES` / `SCREENSHOT_MAX_INTERVAL_MINUTES` set them
(`lib/screenshotPolicy.ts`), defaulting to 10 and 30. The desktop client's own
10–30 is a fallback for a portal it has not reached yet and is replaced on every
poll — so an agent cannot change how often their screen is photographed by
editing anything on their machine, and changing it here reaches every connected
workstation within a minute with no client release.

The schedule itself is never sent back and never displayed. The Monitor's UI
says "Monitoring Active" or "Monitoring Offline" and nothing about timing.

## Rate limiting

At most **one accepted screenshot per monitor device per window** (five minutes
by default, `SCREENSHOT_UPLOAD_MIN_INTERVAL_MINUTES`). Over the limit is a 429
with `Retry-After`, no file written and no row created.

The state is one column, `monitor_devices.last_screenshot_at`, claimed by a
single conditional `UPDATE` (`lib/screenshotRateLimit.ts`):

- **Server-authoritative.** Written from the server's clock and compared against
  the server's clock. `capturedAt` is not read by the limiter at all, so a
  workstation cannot buy itself uploads by lying about time.
- **Correct with more than one process.** The atomicity is the single statement,
  not a lock — two PM2 workers racing the same device, or two blue/green slots
  during a deploy, produce exactly one winner. An in-process `Map` (what
  `lib/loginThrottle.ts` uses) would give a device one window per worker.
- **No new infrastructure.** Postgres is already here; Redis is not, and one
  rate limit is not a reason to introduce it.
- **One *successful* screenshot.** A claim whose store then fails — a 409 for a
  shift that just ended, a 415 for a corrupt body — is handed back.

The client's response to a 429 is to drop the capture and wait for its next
scheduled cycle. There is no retry loop anywhere in this path.

## Retention

Screenshots older than `SCREENSHOT_RETENTION_DAYS` (default 30) are deleted —
**the file and the row, as a pair** (`lib/screenshotRetention.ts`). A row whose
file is already missing is still removed; a file that will not delete keeps its
row so the next sweep can try again. Nothing is ever deleted by filename: the
sweep walks rows and compares the server-stamped `created_at`, never the
client-supplied `captured_at`.

The server owns this. It does not run on upload, it does not run in the agent's
application, and there is no way for an agent or an administrator to trigger a
deletion of anything in particular — the endpoint takes no parameters.

It is scheduled by the box's own crontab, which
`deploy/provision.sh` already installs and manages for the nightly backup:

```
30 4 * * * /usr/local/bin/leadportal-screenshot-retention
```

That script calls `POST /api/maintenance/screenshot-retention` over loopback
with `SCREENSHOT_RETENTION_TOKEN` (503 when unset — it never falls open). Cron
rather than a `setInterval` inside the app, because the app runs as two PM2
workers and two blue/green slots, and a module-level timer would run in every
one of them. `npm run screenshots:retention` runs the same code by hand.

## Rules this group holds to

- **AGENT only.** `checkMonitorEligibility` refuses administrators, at sign-in
  and again on every authenticated request, because a role can change in
  between. Every Monitor sign-in requires the emailed code — as, since the
  administrator bypass was removed, does every web sign-in.
- **No path to a token except through the code.** `issueDeviceTokens` is reached
  only from `/auth/verify`, and only after `verifyLoginOtpForChallenge` has
  returned a user id.
- **Role and `isActive` are read from Postgres on every request**, exactly as
  `getSessionUser` does for the browser — so a demoted or disabled agent's
  workstation stops working on its next call, not at token expiry.
- **Tokens are opaque random bytes, stored only as their SHA-256**, the same
  construction `sessions` uses. No JWT, so no signing secret to distribute —
  which keeps the promise `.env.example` makes that authentication adds no
  environment variables.
- **Refresh rotates.** A token copied off a workstation stops working the moment
  that workstation next refreshes.
