# Deploying the Lead Portal

**Live: <https://leadportal.169-58-34-205.sslip.io>** — login `agent`.

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
  env             root:root 0600 — DATABASE_URL, NODE_ENV, HOSTNAME
  slot-blue.env   PORT=3031
  slot-green.env  PORT=3032
  db-password     root:root 0600
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

### Migration safety

Migrations run *before* the traffic flip, so old code briefly runs against the
new schema. Fine for additive changes (new nullable column, table, index) — the
normal case. **Not** fine for dropping or renaming a column the old code still
selects. For those use two deploys: add the new shape and write to both, then
remove the old. `deploy.sh` only ever runs `migrate deploy`, never `migrate dev`,
which can offer to reset the database on drift.

## DNS

**No records needed.** sslip.io resolves the hostname to this IP already.

For a real domain later, add `A leads → 169.58.34.205`, then on the server:

```bash
sed -i 's/leadportal\.169-58-34-205\.sslip\.io/leads.example.com/g' /etc/nginx/sites-available/leadportal
certbot certonly --webroot -w /var/www/certbot -d leads.example.com
nginx -t && systemctl reload nginx
```

Use `--webroot`, not `--nginx`: the nginx plugin rewrites config files, which on
a box with ten vhosts is a blast radius worth avoiding.

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

1. **No application authentication.** Basic Auth is one shared password at the
   proxy. No per-agent identity, so nothing attributes a status change to a
   person, and revoking one agent means rotating everyone's.
2. **No database backups.** Nothing here sets any up, and the cluster holds four
   other products' data. Worth a cron job:
   `sudo -u postgres pg_dump lead_portal | gzip > /root/backups/lead_portal-$(date +%F).sql.gz`
3. **A failed save reverts silently** in the UI apart from a console error.
4. **Emptying the table is a database operation, on purpose.** Both write paths
   merge, and nothing in the UI can wipe the worklist. To start genuinely fresh:
   `sudo -u postgres psql -d lead_portal -c 'TRUNCATE leads;'` — take a
   `pg_dump` first. `POST /api/leads/upload` used to replace the entire table,
   which made an ordinary second import a silent data-loss event; it merges now.
5. **The root password was shared in plaintext** during setup and should be
   rotated. Key auth is installed, so nothing depends on it.
