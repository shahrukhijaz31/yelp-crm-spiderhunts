# Deploying the Lead Portal

Target: `root@169.58.34.205`, Ubuntu 22.04/24.04, served on the bare IP behind
nginx with HTTP Basic Auth.

## What this application is

Established by inspection, not assumption:

| | |
|---|---|
| Framework | Next.js 16.3.0 (App Router, Turbopack), React 19.2.8 |
| Language | TypeScript 5, strict |
| Runtime | Node.js **≥ 20.9** (`next/package.json` `engines`) — provisioned as 22 LTS |
| Database | PostgreSQL, via Prisma 7.9.1 with the `@prisma/adapter-pg` driver adapter |
| Build | `prisma generate && next build`, emitting `.next/standalone` |
| Env vars | `DATABASE_URL` only. Plus `NODE_ENV`/`PORT`/`HOSTNAME`, which the platform sets |
| Client env | **None.** No `NEXT_PUBLIC_*` anywhere, so no secret can be inlined into the browser bundle |
| Routes | All 11 are dynamic (`ƒ`). No ISR, no static pages, no shared cache to coordinate |
| Long requests | `POST /api/leads/upload` parses and writes a whole CSV in one request |

Prisma 7 uses a **driver adapter**, not a bundled query engine. There is no
platform-specific binary to match to the server's libc — the same build runs on
Windows and on Ubuntu. This was verified by running `.next/standalone/server.js`
locally against Postgres: health 200, 35 rows returned, SSR 200.

## Deployment shape and why

**`output: "standalone"`** — `next build` traces what the server actually
imports and emits a self-contained tree. Each release is complete and runnable,
so a rollback is starting a directory that is already on disk rather than
reinstalling. Verified: `.next/standalone` does not contain `lib/generated/prisma`
or `@prisma/adapter-pg` as loose files because Turbopack bundles them into the
server chunks — the running server proves they resolve.

**Blue/green on two loopback ports** — you asked for updates without downtime.
A single service means `systemctl restart`, which is a real outage on every
deploy, however brief. Instead: build into the idle slot, health-check it on its
own port while the live one keeps serving, then `nginx -s reload` — graceful, so
in-flight requests finish on the old worker and new ones go to the new port. At
no point are zero backends listening, which is the only thing that produces a 502.

**systemd over PM2** — systemd is already PID 1, already starts on boot, already
has journald and rotation, and provides the sandboxing the unit uses
(`ProtectSystem=strict`, `ReadWritePaths`, `MemoryMax=1G`). PM2 would be a second
supervisor that itself needs a systemd unit. `ecosystem.config.cjs` is provided
if you want PM2 anyway.

**`HOSTNAME=127.0.0.1`** — the app binds loopback only. Without it the Node
process is reachable directly on the public IP and the Basic Auth in nginx is
trivially bypassed.

**Basic Auth at nginx** — the app has no authentication and
`POST /api/leads/upload` deletes every row before inserting. Anyone who found the
IP could destroy the database with one `curl`. This is a stopgap at the edge, not
real auth.

## Files

| File | Installed to |
|---|---|
| `provision.sh` | run once from `/root` |
| `lead-portal@.service` | `/etc/systemd/system/lead-portal@.service` |
| `nginx/lead-portal.conf` | `/etc/nginx/sites-available/lead-portal` |
| `nginx/lead-portal-upstream.conf` | `/etc/nginx/conf.d/` — **rewritten by deploy.sh** |
| `deploy.sh` | `/var/www/lead-portal/repo/deploy/` |
| `rollback.sh` | same |
| `ecosystem.config.cjs` | only if you choose PM2 |

Server layout:

```
/var/www/lead-portal/
  repo/          git checkout; builds happen here
  blue/          release slot, port 3001
  green/         release slot, port 3002
/etc/lead-portal/
  env            root:root 0600 — DATABASE_URL, NODE_ENV, HOSTNAME
  slot-blue.env  PORT=3001
  slot-green.env PORT=3002
  db-password    root:root 0600
```

Secrets live outside the release tree, so a deploy cannot overwrite them and a
rollback cannot revert them.

## First deploy

### 1. Push the code

The remote is `yelp-crm-spiderhunts` but only the Create-Next-App commit is on
it — everything since is uncommitted. Nothing can deploy until it is pushed.

```bash
git add -A
git commit -m "Postgres data layer and production deployment"
git push origin main
```

### 2. Provision the server

```bash
scp -r deploy root@169.58.34.205:/root/deploy
ssh root@169.58.34.205 'bash /root/deploy/provision.sh'
```

Installs Node 22, PostgreSQL, nginx, ufw; creates the `leadportal` service
account, the database and its role with a generated password; writes
`/etc/lead-portal/env`; generates the self-signed certificate and the Basic Auth
user; enables the firewall.

**It prints a username and password once.** Write them down — the file is
bcrypt-hashed and the password cannot be recovered.

### 3. Clone and deploy

```bash
ssh root@169.58.34.205
git clone https://github.com/shahrukhijaz31/yelp-crm-spiderhunts.git /var/www/lead-portal/repo
bash /var/www/lead-portal/repo/deploy/deploy.sh
```

Private repo? Create a deploy key first:

```bash
ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N ''
cat /root/.ssh/id_ed25519.pub     # add as a read-only deploy key on GitHub
git clone git@github.com:shahrukhijaz31/yelp-crm-spiderhunts.git /var/www/lead-portal/repo
```

### 4. Check it

```bash
curl -k https://169.58.34.205/api/health          # {"status":"ok","database":"up"}
curl -k -u agent:PASSWORD https://169.58.34.205/api/leads
```

Then open `https://169.58.34.205` and accept the certificate warning once.

### 5. Optional: seed

The table is empty after the first migration. To load the sample CSV:

```bash
cd /var/www/lead-portal/repo
set -a; . /etc/lead-portal/env; set +a
npx prisma db seed
```

## Updating, without downtime

```bash
ssh root@169.58.34.205 'bash /var/www/lead-portal/repo/deploy/deploy.sh'
```

Deploy a specific ref with `deploy.sh <branch|tag|sha>`.

The script aborts before touching traffic if the build fails, if migrations
fail, or if the new release does not pass its health check within 30s — in every
one of those cases the old release is still serving and users see nothing.

Roll back:

```bash
ssh root@169.58.34.205 'bash /var/www/lead-portal/repo/deploy/rollback.sh'
```

### Migration safety

Migrations run *before* the traffic flip, so the old code briefly runs against
the new schema. That is fine for additive changes — a new nullable column, a new
table, a new index — which is the normal case.

It is **not** fine for dropping or renaming a column the old code still selects:
that throws for the few seconds between migrate and flip. For those, use two
deploys (expand/contract): first add the new shape and write to both, then a
second deploy removing the old one. Note this applies to
`prisma migrate deploy` only — `deploy.sh` never runs `migrate dev`, which can
offer to reset the database on drift.

## DNS

**None required.** You chose to serve on the bare IP, so nothing needs to
resolve. `169.58.34.205` must simply be the VPS's public address.

When you do get a domain, this is the whole change:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `leads` (or `@`) | `169.58.34.205` | 300 |

Then, on the server:

```bash
apt-get install -y certbot python3-certbot-nginx
sed -i 's/server_name _;/server_name leads.example.com;/' /etc/nginx/sites-available/lead-portal
certbot --nginx -d leads.example.com          # rewrites the cert paths itself
```

Certbot installs its own renewal timer; confirm with `systemctl list-timers | grep certbot`.
Once the certificate is trusted, uncomment the `Strict-Transport-Security` line
in the vhost — it is off deliberately while the cert is self-signed, because
HSTS plus an untrusted cert is an outage you cannot click through.

## Firewall

`provision.sh` sets this up. Final state:

| Port | Access | Why |
|---|---|---|
| 22 | open | SSH |
| 80 | open | redirects to 443 |
| 443 | open | the application |
| 3001, 3002 | **closed** | app slots; loopback-bound, reachable only via nginx |
| 5432 | **closed** | Postgres; loopback-bound, never remote |

Verify: `ufw status verbose`, and `ss -tlnp` to confirm 3001/3002/5432 show
`127.0.0.1` and not `0.0.0.0`.

Consider also moving SSH off password auth if it is not already:
`PasswordAuthentication no` in `/etc/ssh/sshd_config`.

## Operating it

```bash
systemctl status lead-portal@blue           # or @green
journalctl -u lead-portal@blue -f           # live logs
journalctl -u lead-portal@blue --since "1 hour ago" -p err
grep 3001 /etc/nginx/conf.d/lead-portal-upstream.conf && echo "blue is live"
cat /var/www/lead-portal/blue/RELEASE_SHA   # what is deployed
htpasswd -B /etc/nginx/lead-portal.htpasswd newagent   # add a login
```

The app logs to stdout/stderr with a route prefix (`GET /api/leads failed:`),
which journald timestamps and rotates. No log files to manage.

Back up the database — nothing here does:

```bash
sudo -u postgres pg_dump lead_portal | gzip > /root/lead_portal-$(date +%F).sql.gz
```

## Known gaps

1. **No application authentication.** Basic Auth is one shared password at the
   proxy. There is no per-agent identity, so nothing attributes a status change
   to a person, and revoking one agent means rotating everyone's password.
2. **No database backups configured.** The `pg_dump` line above is manual. Put
   it in a cron job before this holds anything you cannot re-scrape.
3. **A failed save reverts silently** in the UI apart from a console error —
   see the note in the root README.
4. **`POST /api/leads/upload` is destructive by design** (it replaces the whole
   table). Behind Basic Auth that is a deliberate feature; exposed, it is a
   delete button.
