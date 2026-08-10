# Deploying the Lead Portal

**Live: <https://leads.spiderhunts-coworkingspace.com>**
(also <https://leadportal.169-58-34-205.sslip.io>, kept as a fallback).

## The server this targets

`169.58.34.205` (Contabo, Ubuntu 24.04.4, 12 cores, 47GB, 345GB free) is **not
a dedicated box**. It already runs about ten sites behind one nginx and one
PostgreSQL 17 cluster: leadquasar.com, spideychat, xiangqiplay.online,
zayrclothing.com, maison-fayard, saleshandy, bvr-preview, and others.

Every decision below follows from that. The first version of these scripts
assumed an empty server and would have taken live sites down — `default_server`
on :80/:443 capturing every unmatched hostname, `apt-get install postgresql`
adding a second cluster beside the live one, and ports 3001/3002 that were
already occupied.

Existing conventions this deployment follows rather than reinvents:

| Convention | Where it came from |
|---|---|
| `/var/www/vhosts/<site>` | leadquasar.com, zayrclothing.com, saleshandy-copy |
| One system user per site, `nologin` | `leadquasar`, `zayr`, `spideychat` |
| One database per site on the shared cluster | `leadquasar`, `zayr_commerce`, `saleshandy` |
| `*.sslip.io` hostname + Let's Encrypt webroot | the existing `saleshandy-sslip` vhost |

## What this application is

Determined by inspection:

| | |
|---|---|
| Framework | Next.js 16.3.0 (App Router, Turbopack), React 19.2.8 |
| Runtime | Node ≥ 20.9 (`next/package.json` engines). Server has v22.23.1 |
| Database | PostgreSQL 17 via Prisma 7.9.1 + `@prisma/adapter-pg` driver adapter |
| Build | `prisma generate && next build` → `.next/standalone` |
| Env vars | `DATABASE_URL` only. Plus `NODE_ENV`/`PORT`/`HOSTNAME` from the platform |
| Client env | **None.** No `NEXT_PUBLIC_*`, so no secret can reach the browser bundle |
| Routes | All 12 dynamic (`ƒ`). No ISR, no static pages, no cache to coordinate |

Prisma 7 uses a driver adapter, so there is **no platform-specific query-engine
binary** — the same build runs on Windows and Ubuntu.

## Layout

```
/var/www/vhosts/leadportal/
  repo/      git checkout; builds happen here
  blue/      release slot, port 3031
  green/     release slot, port 3032
/etc/leadportal/
  env             root:root 0600 — DATABASE_URL, NODE_ENV, HOSTNAME, RECORDINGS_DIR
  slot-blue.env   PORT=3031
  slot-green.env  PORT=3032
  db-password     root:root 0600
/var/lib/leadportal/
  recordings/     uploaded call audio, leadportal:leadportal 0750
/etc/nginx/sites-available/leadportal
/etc/nginx/conf.d/leadportal-upstream.conf   ← rewritten by deploy.sh
/etc/nginx/leadportal.htpasswd
/etc/systemd/system/leadportal@.service
```

Secrets live outside the release tree, so a deploy cannot overwrite them and a
rollback cannot revert them.

## Key decisions

**Hostname `leadportal.169-58-34-205.sslip.io`.** You chose IP-only, and I said
that ruled out Let's Encrypt. That was true for a *bare* IP — but sslip.io
resolves `<label>.169-58-34-205.sslip.io` to this box, and you already use that
trick for saleshandy. So this has a **real, trusted, auto-renewing certificate**
(expires 2026-11-04) rather than the self-signed one originally planned. HSTS is
therefore safe and is enabled.

**Ports 3031/3032.** 3000, 3001, 3010, 3020 and 3030 are all taken by other apps.

**No `default_server`, no `server_name _`, no `http2 on`.** Nothing currently
claims default on :80/:443; taking it would capture every unmatched hostname for
every site. And `http2 on` requires nginx ≥ 1.25.1 — this box runs 1.24.0, where
it is a hard config error that would break *every* site's next reload.

**Blue/green on two loopback ports.** Build into the idle slot, health-check it
on its own port while the live one serves, then reload nginx. Verified: 600
back-to-back requests across a full deploy, zero failures.

**systemd, not PM2.** Already PID 1, already starts at boot, already has
journald, and provides the sandboxing the unit uses. `ecosystem.config.cjs` is
there if you prefer PM2.

**`HOSTNAME=127.0.0.1`.** The app binds loopback only, so nginx is the only way
in and the Basic Auth cannot be bypassed by hitting the port directly.

## Everyday use

```bash
ssh leadportal 'bash /var/www/vhosts/leadportal/repo/deploy/deploy.sh'          # deploy main
ssh leadportal 'bash /var/www/vhosts/leadportal/repo/deploy/deploy.sh <ref>'    # a tag/sha
ssh leadportal 'bash /var/www/vhosts/leadportal/repo/deploy/rollback.sh'        # previous slot
```

The deploy aborts *before* touching traffic if the build fails, migrations fail,
or the new release misses its health check in 30s. In all three cases the old
release keeps serving.

> A deploy always runs the *previous* commit's `deploy.sh`: the script pins
> itself to /tmp before checking out, because otherwise `git checkout` rewrites
> the file bash is reading and execution resumes at the same byte offset in
> different content. A change to deploy.sh takes effect on the deploy *after*
> the one that ships it.

```bash
ssh leadportal 'systemctl status leadportal@blue'
ssh leadportal 'journalctl -u leadportal@blue -f'
ssh leadportal 'grep "server 127" /etc/nginx/conf.d/leadportal-upstream.conf'   # which slot is live
ssh leadportal 'cat /var/www/vhosts/leadportal/blue/RELEASE_SHA'
ssh leadportal 'htpasswd -B /etc/nginx/leadportal.htpasswd someone'             # add a login
```

Load a CSV without using the UI:

```bash
ssh leadportal 'cd /var/www/vhosts/leadportal/repo && set -a && . /etc/leadportal/env && set +a && npx prisma db seed'
```

### Authentication

The first deploy that carries application authentication needs one manual step,
once, on the server — nothing is seeded and no credentials live in the code or
in `/etc/leadportal/env`:

```bash
ssh leadportal 'cd /var/www/vhosts/leadportal/repo \
  && set -a && . /etc/leadportal/env && set +a \
  && npx tsx scripts/create-user.ts --name "Jane Doe" --username jane \
       --email jane@example.com --role ADMIN'
```

The generated password is printed once. That administrator adds everyone else
from the Users screen, so this command should never need running twice; it
refuses to touch an existing username or email if it is.

No new environment variables. Sessions are rows keyed by a random token, so
there is no signing secret to distribute or rotate, and the cookie is `Secure`
+ `__Host-`-prefixed automatically because systemd sets `NODE_ENV=production`.
That prefix requires HTTPS, which the vhost already enforces — a deploy that
served this app over plain http would fail to log anyone in, loudly, rather
than quietly downgrading the cookie.

> **The nginx Basic Auth is now a second, redundant password.** It was a
> stopgap for exactly this gap (see the comment in `nginx/leadportal.conf`) and
> agents will meet two prompts until it is removed. Removing it is a
> deliberate, separate change: delete the `auth_basic` pair from the `server`
> block and the `auth_basic off;` lines from the exempted locations, then
> `nginx -t && systemctl reload nginx`. Leaving it in place is also fine — the
> application no longer depends on it either way.

### Call recordings

Uploaded audio is written to `/var/lib/leadportal/recordings`, set as
`RECORDINGS_DIR` in `/etc/leadportal/env` and granted to the unit with
`ReadWritePaths=` (the service runs under `ProtectSystem=strict`, so everything
else is read-only). It is outside the release tree on purpose: a deploy
replaces the slot directory wholesale, so recordings kept inside it would be
destroyed by the next release and a rollback could not bring them back. Both
slots point at the same directory, which is what makes a blue/green switch
invisible to playback.

The first deploy carrying this feature needs `provision.sh` re-run — it is
idempotent, and it creates the directory and appends `RECORDINGS_DIR` to the
existing env file without touching any other key:

```bash
ssh leadportal 'bash /var/www/vhosts/leadportal/repo/deploy/provision.sh'
ssh leadportal 'systemctl daemon-reload && systemctl restart leadportal@blue leadportal@green'
```

Without that, uploads fail with a permission error on a read-only filesystem
and nothing else in the app is affected.

Back it up with the database, not instead of it: a row in `meeting_recordings`
whose file is missing streams a `410`, and a file with no row is unreachable.

```bash
ssh leadportal 'du -sh /var/lib/leadportal/recordings'   # how much audio is stored
```

### Backups

`/usr/local/bin/leadportal-backup`, from `deploy/leadportal-backup`, installed by
`provision.sh` and run from root's crontab at **03:45 nightly** — staggered off
the 03:30 spideychat and leadquasar dumps so three `pg_dump`s never hit the one
shared cluster at once.

```
/var/backups/leadportal/
  daily/    leadportal_<stamp>.sql.gz              14 kept
            leadportal-recordings_<stamp>.tar.gz   only when there is audio
  weekly/   Sunday's dump, promoted                8 kept
  last-status   `ok <epoch> <file>` or `fail <epoch> <reason>`
```

It **verifies rather than assumes**: `gzip -t`, a minimum size, and a check that
`leads`, `users`, `sessions`, `meeting_recordings` and `password_resets` are
each actually in the dump. A truncated file, a mid-stream permissions error or a
connection to an empty database all produce a plausible-looking `.gz`, and the
day you find out is the day you needed it. A failed run leaves no file and
writes the reason to `last-status`.

Recordings go in a **separate** archive alongside the dump, not instead of it: a
row in `meeting_recordings` with no file streams a 410, and a file with no row
is unreachable, so the pair has to be restored together.

```bash
ssh leadportal 'cat /var/backups/leadportal/last-status'      # did last night work
ssh leadportal 'tail -5 /var/log/leadportal-backup.log'
ssh leadportal '/usr/local/bin/leadportal-backup'             # run one now
```

**Restore — rehearse into a scratch database first.** A backup that has never
been restored is a guess. This was run against the first real dump: 1,964 leads,
2 users, 2 sessions, matching live exactly.

```bash
sudo -u postgres createdb lead_portal_restore_test
gunzip -c /var/backups/leadportal/daily/<file>.sql.gz \
  | sudo -u postgres psql -d lead_portal_restore_test
sudo -u postgres psql -d lead_portal_restore_test -c 'SELECT count(*) FROM leads;'
sudo -u postgres dropdb lead_portal_restore_test
```

For the real thing, stop both slots first so nothing writes mid-restore:

```bash
systemctl stop leadportal@blue leadportal@green
gunzip -c <file>.sql.gz | sudo -u postgres psql -d lead_portal
tar -xzf <recordings>.tar.gz -C /var/lib/leadportal/recordings
systemctl start leadportal@blue
```

> **This is on the same disk as the database.** It answers a bad migration or a
> mistaken `DELETE` — the likely cases — but not the loss of the machine. The
> hook for that is already there: put `OFFSITE_CMD` in
> `/etc/leadportal-backup.env` and it receives each archive path as `$1`, e.g.
> `OFFSITE_CMD='rclone copy "$1" b2:leadportal-backups/'`. A failure there is
> logged and never fails the run. Contabo's own Auto Backup is a separate paid
> add-on in their panel, and being a whole-box image it is a blunt tool for
> recovering one table across ten sites.

### Migration safety

Migrations run *before* the traffic flip, so old code briefly runs against the
new schema. Fine for additive changes (new nullable column, table, index) — the
normal case. **Not** fine for dropping or renaming a column the old code still
selects. For those use two deploys: add the new shape and write to both, then
remove the old. `deploy.sh` only ever runs `migrate deploy`, never `migrate dev`,
which can offer to reset the database on drift.

## DNS

One record, in the **Hostinger** DNS zone for `spiderhunts-coworkingspace.com`
(nameservers `ns1/ns2.dns-parking.com`):

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `leads` | `169.58.34.205` | 300 |

Nothing else in that zone changed. MX, the apex and `www` are untouched, and the
marketing site still serves from Hostinger's own addresses — this box only
claims the one name.

Two traps worth recording:

* **Use the DNS records editor, not hPanel's "Subdomains" tool.** That tool
  creates a folder on the shared hosting *and writes its own A record pointing
  back at Hostinger*, which silently overrides the one you just added.
* **No AAAA.** See the note in `nginx/leadportal.conf`: every site actually
  served from this box is IPv4-only, so inbound IPv6 has never been exercised
  here, and a client that resolves an AAAA prefers it — an unverified one is a
  hang, not a fallback. nginx already listens on `[::]`, so adding one later is
  a DNS change plus a test from a host with working IPv6.

The sslip.io hostname is deliberately kept as a second name on the same
certificate. This box does not control the spiderhunts DNS zone, so the public
hostname can be taken away by someone editing records for the marketing site;
the sslip name needs no records at all and is the way back in.

To add or change a hostname later, edit `server_name` in both blocks of the
vhost and extend the existing certificate — `--cert-name` pinned to the current
lineage and `--expand`, so you get one certificate with two names rather than
two lineages, only one of which nginx is serving:

```bash
certbot certonly --webroot -w /var/www/certbot \
  --cert-name leadportal.169-58-34-205.sslip.io --expand \
  -d leadportal.169-58-34-205.sslip.io -d <new-name>
nginx -t && systemctl reload nginx
```

Use `--webroot`, not `--nginx`: the nginx plugin rewrites config files, which on
a box with ten vhosts is a blast radius worth avoiding.

> `systemctl reload nginx` returns before the new config is actually serving —
> old workers finish their connections first. A check fired immediately after a
> reload can still be answered by the previous config, which during this change
> meant a request for the new hostname falling through to the default server
> (another Next.js site on this box) and returning its 404. Retry before
> concluding anything is broken.

## Firewall

**Unchanged — it was already correct.** 22/80/443 open; 3031, 3032 and 5432
closed. The app slots and Postgres bind `127.0.0.1`, so they are reachable only
through nginx.

One pre-existing oddity: ufw has an `ALLOW 5432/tcp` rule from before. It is
harmless because Postgres listens on loopback only, but it is misleading and
worth removing: `ufw delete allow 5432/tcp`.

## Bugs found and fixed while deploying

Recorded because each would have recurred:

1. **`prisma generate` demanded `DATABASE_URL`.** `prisma/config`'s `env()`
   throws at config load, and every Prisma command loads it — including pure
   codegen. Broke `npm ci` via the postinstall hook, and would break a fresh
   `npm install` on any new machine.
2. **`DATABASE_URL` written unquoted.** Valid for systemd's `EnvironmentFile`,
   but `deploy.sh` also sources it with `.`, where the `&` before
   `connection_limit` is a shell control operator — the assignment ran in a
   background subshell and never reached the parent. Silent, no error.
3. **`deploy.sh` rewrote itself mid-run.** `git checkout` replaced the file bash
   was executing; bash resumed at the same byte offset in the new content and
   ran the previous commit's install line.
4. **Stale Turbopack cache.** A build that failed for an environmental reason
   cached that failure under `.next/build/chunks`, so three subsequent fixes all
   appeared to do nothing. `rm -rf .next` before every build.
5. **`WorkingDirectory` one level too deep** → `status=200/CHDIR`, which reads
   like an app crash but is systemd refusing to start the process.
6. **`StartLimitBurst`/`StartLimitIntervalSec` in `[Service]`**, where systemd
   ignores them — `Restart=always` would have retried a dead release forever.
7. **One dropped request per deploy.** nginx's old workers hold keepalive
   connections to the old port; stopping that backend right after the reload
   killed in-flight requests. Fixed with a 10s drain — 1/233 failures became
   0/600.
8. **Rollback did not move boot enablement.** The rollback survived only until
   the next reboot, which would have started the stopped slot and left nginx
   with no backend.

## Known gaps

1. ~~**No application authentication.**~~ **Fixed.** The portal now has
   per-person accounts with ADMIN/AGENT roles in Postgres, sessions in the
   `sessions` table, and server-side authorization on every page and API route.
   See "Authentication" below and the README section of the same name.

   Two follow-ups it does *not* do: nothing yet attributes a status change to
   the person who made it (the `users` table now makes that possible), and
   there is no password self-service — an administrator resets one from the
   Users screen.
2. ~~**No database backups.**~~ **Fixed.** Nightly dump + verification +
   rotation; see "Backups" above.
3. **A failed save reverts silently** in the UI apart from a console error.
4. **Nothing can empty the worklist, and that is deliberate.** Both write paths
   merge, and no UI action wipes the table. `POST /api/leads/upload` used to
   replace the entire table, which made an ordinary second import a silent
   data-loss event; it merges now.

   This section used to end with a ready-to-paste one-line SQL statement for
   wiping the whole `leads` table to "start fresh". **It has been removed on
   purpose and should not be reinstated.** There is no routine reason to destroy
   1,900+ rows of call history — the worklist is filtered, not emptied — and an
   irreversible command sitting in a deploy guide is the likeliest way this
   database ever gets wiped by accident. Anyone with a real reason to do it can
   write the statement themselves, and should take a manual `leadportal-backup`
   run and confirm it landed first.
5. **The root password was shared in plaintext** during setup and should be
   rotated. Key auth is installed, so nothing depends on it.
