#!/usr/bin/env bash
#
# Lead Portal — one-time setup on the Contabo VPS (169.58.34.205).
#
#   ssh leadportal 'bash /root/deploy/provision.sh'
#
# THIS SERVER IS NOT EMPTY. It runs ~10 live sites (leadquasar.com,
# spideychat, xiangqiplay.online, zayrclothing.com, maison-fayard, saleshandy,
# bvr-preview) behind one nginx, on one PostgreSQL 17 cluster. Everything below
# is written to add a tenant beside them and touch nothing that already exists.
#
# What this script deliberately DOES NOT do, and why:
#   * No `apt-get install nginx/postgresql/nodejs/certbot` — all four are
#     already present (nginx 1.24.0, PostgreSQL 17.10, Node v22.23.1,
#     certbot 2.9.0). Installing the `postgresql` metapackage in particular
#     would add a SECOND cluster on port 5433 beside the live one.
#   * No `default_server` and no `server_name _` — nothing currently claims
#     default on :80/:443, and taking it would silently capture every request
#     for every hostname that does not match another vhost.
#   * No `rm /etc/nginx/sites-enabled/default` — it does not exist here.
#   * No `ufw --force enable` and no rule changes — ufw is already active with
#     22/80/443 open, which is exactly what is needed.
#   * No changes to any existing vhost, database, or user.
#
# Idempotent: safe to re-run. Never overwrites an existing secret.

set -euo pipefail

SITE="leadportal"
APP_ROOT="/var/www/vhosts/${SITE}"
ENV_DIR="/etc/${SITE}"
# Uploaded call recordings. Deliberately not under APP_ROOT: a deploy replaces
# the whole release directory, so anything stored there is gone at the next
# release and a rollback cannot bring it back. /var/lib is where state that
# outlives the code belongs.
RECORDINGS_DIR_PATH="/var/lib/${SITE}/recordings"
# Desktop screenshots from SpiderHunts Monitor, for the same reason and in the
# same place. The volume is not comparable — several images per agent per hour,
# all day — which is why retention (below) is provisioned alongside it rather
# than left as something to remember later.
SCREENSHOTS_DIR_PATH="/var/lib/${SITE}/screenshots"
DB_NAME="lead_portal"
DB_USER="leadportal"
# The public hostname, a subdomain of the company's existing Hostinger-hosted
# marketing site. Only an A record was added there; nothing about that site
# changed, and it keeps serving from Hostinger's own addresses.
DOMAIN="leads.spiderhunts-coworkingspace.com"

# The original sslip.io name, kept as a second name on the same certificate.
# It costs nothing and it is the way back in if the spiderhunts DNS zone is ever
# edited by someone working on the marketing site — this box does not control
# that zone, so the hostname the portal answers to can be taken away by a change
# made somewhere else entirely.
ALT_DOMAIN="leadportal.169-58-34-205.sslip.io"

# The certificate LINEAGE name, which is a directory under /etc/letsencrypt/live
# and is NOT the same thing as the hostname. It stays pinned to the sslip name
# because that is the directory the live cert already occupies and the path
# nginx/leadportal.conf points `ssl_certificate` at. Renaming it would leave the
# vhost pointing at a directory that no longer exists, and nginx refuses to
# start when `ssl_certificate` is missing — which on this box takes down all ten
# sites, not just this one.
CERT_NAME="$ALT_DOMAIN"
WEBROOT="/var/www/certbot"
BLUE_PORT=3031
GREEN_PORT=3032

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."

# --- Guard rails -----------------------------------------------------------
# Refuse to run if the server is not the one this was written against, rather
# than adapting silently and half-configuring something.
log "Verifying preconditions"

command -v nginx   >/dev/null || die "nginx not found — this script expects the existing install."
command -v psql    >/dev/null || die "psql not found — this script expects PostgreSQL 17 already running."
command -v certbot >/dev/null || die "certbot not found."
command -v node    >/dev/null || die "node not found."

NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node $(node -v) is too old; Next.js 16 needs >= 20.9."
echo "  node $(node -v), nginx $(nginx -v 2>&1 | sed 's/.*\///'), $(psql --version)"

# The point of this check is "is another tenant on this port", not "is anything
# listening". On a re-run — which is how a new setting like INGEST_TOKEN gets
# added to an already-deployed box — our own slot is listening and that is
# correct. Refusing then made the script a one-shot, which it is documented not
# to be.
for slot_port in "blue:${BLUE_PORT}" "green:${GREEN_PORT}"; do
  slot="${slot_port%%:*}"; p="${slot_port##*:}"
  if ss -tln | grep -q ":${p} "; then
    if systemctl is-active --quiet "leadportal@${slot}"; then
      echo "  port ${p} in use by leadportal@${slot} — ours, fine"
    else
      die "Port ${p} is in use by something that is not leadportal@${slot}. Pick another pair and update deploy.sh and the slot env files."
    fi
  else
    echo "  port ${p} free"
  fi
done

# Both names have to resolve before certbot runs, because HTTP-01 validates
# every -d on the command line and one missing record fails the whole issuance.
for d in "$DOMAIN" "$ALT_DOMAIN"; do
  getent hosts "$d" >/dev/null \
    || die "${d} does not resolve. Check the DNS A record (or, for the sslip.io name, whether sslip.io is down)."
  echo "  ${d} resolves"
done

# --- Service account -------------------------------------------------------
# Matches the existing per-site convention (leadquasar, zayr, spideychat):
# a system account, home at the vhost root, no login shell.
if ! id -u "$DB_USER" >/dev/null 2>&1; then
  log "Creating service account ${DB_USER}"
  adduser --system --group --home "$APP_ROOT" --shell /usr/sbin/nologin "$DB_USER"
else
  log "Service account ${DB_USER} already exists"
fi

log "Creating ${APP_ROOT}"
mkdir -p "${APP_ROOT}"/{repo,blue,green}
chown "${DB_USER}:${DB_USER}" "$APP_ROOT"
chmod 750 "$APP_ROOT"

# The release slots are what the service reads, so they belong to the app user.
chown -R "${DB_USER}:${DB_USER}" "${APP_ROOT}/blue" "${APP_ROOT}/green"

# The repo is NOT the app user's. It is root's build workspace: deploy.sh runs
# as root and does git fetch/checkout in it, and the running service never opens
# it. Chowning it to the app user (which `chown -R` on APP_ROOT used to do) made
# git refuse to operate as root -- "detected dubious ownership" -- so every
# deploy died at the fetch, immediately after announcing which slot it would
# build into.
chown -R root:root "${APP_ROOT}/repo"

# Call recordings: written by the app user, readable by nobody else. 0750 on
# the parent as well, because the filenames alone say how many client calls
# have been recorded and when.
#
# Screenshots the same way, and for a stronger version of the same reason: a
# directory listing there is a record of when somebody's screen was
# photographed, which is not something the rest of the box needs to be able to
# read.
log "Creating ${RECORDINGS_DIR_PATH} and ${SCREENSHOTS_DIR_PATH}"
mkdir -p "$RECORDINGS_DIR_PATH" "$SCREENSHOTS_DIR_PATH"
chown -R "${DB_USER}:${DB_USER}" "/var/lib/${SITE}"
chmod 750 "/var/lib/${SITE}" "$RECORDINGS_DIR_PATH" "$SCREENSHOTS_DIR_PATH"

# --- Database on the EXISTING cluster --------------------------------------
log "Configuring database on the existing PostgreSQL 17 cluster"
mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"

DB_PASS_FILE="${ENV_DIR}/db-password"
if [[ ! -f "$DB_PASS_FILE" ]]; then
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32 > "$DB_PASS_FILE"
  chmod 600 "$DB_PASS_FILE"
  log "Generated database password (alphanumeric only, so it needs no URL-encoding)"
else
  log "Reusing existing database password"
fi
DB_PASS="$(cat "$DB_PASS_FILE")"

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  sudo -u postgres psql -qc "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
  log "Created role ${DB_USER}"
else
  sudo -u postgres psql -qc "ALTER ROLE ${DB_USER} PASSWORD '${DB_PASS}';"
  log "Updated password for role ${DB_USER}"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  log "Created database ${DB_NAME} (alongside spideychat, leadquasar, zayr_commerce, saleshandy)"
else
  log "Database ${DB_NAME} already exists"
fi

# PostgreSQL 15+ no longer grants CREATE on public to everyone; Prisma's
# migrations need it.
sudo -u postgres psql -q -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

# --- Runtime environment ---------------------------------------------------
# Shared secret for POST /api/leads/ingest, which the Yelp scraper (a separate
# project on another box) calls. Kept in its own file for the same reason as
# the database password: it must survive re-running this script, and it has to
# be readable on its own so it can be handed to the scraper's operator without
# printing DATABASE_URL alongside it.
INGEST_TOKEN_FILE="${ENV_DIR}/ingest-token"
if [[ ! -f "$INGEST_TOKEN_FILE" ]]; then
  openssl rand -hex 32 > "$INGEST_TOKEN_FILE"
  chmod 600 "$INGEST_TOKEN_FILE"
  log "Generated ingest token for the scraper"
else
  log "Reusing existing ingest token"
fi
INGEST_TOKEN="$(cat "$INGEST_TOKEN_FILE")"

# Shared secret for POST /api/maintenance/screenshot-retention, which the
# nightly cron job below calls. Its own file for the same reasons, and generated
# here rather than typed by hand so that a box which has been provisioned has a
# working retention sweep without anyone remembering to configure one — the
# route refuses every request while this is unset, so a missing token means
# screenshots accumulate forever.
RETENTION_TOKEN_FILE="${ENV_DIR}/screenshot-retention-token"
if [[ ! -f "$RETENTION_TOKEN_FILE" ]]; then
  openssl rand -hex 32 > "$RETENTION_TOKEN_FILE"
  chmod 600 "$RETENTION_TOKEN_FILE"
  log "Generated screenshot retention token"
else
  log "Reusing existing screenshot retention token"
fi
SCREENSHOT_RETENTION_TOKEN="$(cat "$RETENTION_TOKEN_FILE")"

if [[ ! -f "${ENV_DIR}/env" ]]; then
  log "Writing ${ENV_DIR}/env"
  cat > "${ENV_DIR}/env" <<EOF
# Lead Portal — runtime environment, injected by systemd. root:root 0600.
NODE_ENV=production
# Loopback only: nginx is the sole way in, so the Basic Auth in front of it
# cannot be bypassed by connecting to the port directly.
HOSTNAME=127.0.0.1
# connection_limit caps Prisma's pool. Default is (cpus*2+1) = 25 here, and with
# two slots briefly overlapping during a deploy that is 50 connections from this
# app alone — against a cluster shared with four other databases.
#
# QUOTED, and it must stay quoted. systemd's EnvironmentFile format does not
# require quotes and strips them if present, but deploy.sh also sources this
# file with `.` — and there, the unquoted `&` before connection_limit is a shell
# control operator. The assignment would run in a background subshell and never
# reach the parent, leaving DATABASE_URL unset with no error at all.
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}?schema=public&connection_limit=8"
# Bearer token for the scraper's POST /api/leads/ingest. With this unset the
# route rejects every request rather than accepting anonymous writes, so an
# empty value here disables scraper ingest — it does not open it up.
INGEST_TOKEN="${INGEST_TOKEN}"
# Where uploaded call recordings are written. Outside the release tree, because
# a deploy replaces the slot directory wholesale — audio kept inside it would
# be destroyed by the next release and unrecoverable by a rollback. The unit
# file grants write access to exactly this path.
RECORDINGS_DIR="${RECORDINGS_DIR_PATH}"
# Where desktop screenshots from SpiderHunts Monitor are written. Outside the
# release tree for the same reason as recordings, and on a path the unit file
# grants write access to.
SCREENSHOTS_DIR="${SCREENSHOTS_DIR_PATH}"
# How long screenshots are kept. The server owns this number; nothing on an
# agent's workstation can change it. Unset it and the sweep uses 30 days.
SCREENSHOT_RETENTION_DAYS=30
# Bearer token for POST /api/maintenance/screenshot-retention, called once a day
# by /usr/local/bin/${SITE}-screenshot-retention. With this unset the route
# refuses every request, so screenshots would simply never be deleted.
SCREENSHOT_RETENTION_TOKEN="${SCREENSHOT_RETENTION_TOKEN}"
# SMTP for the sign-in verification code. Signing in is password + a 6-digit
# code emailed to the address on the user's record, so the login route refuses
# every attempt while these are unset — it fails closed rather than falling back
# to password-only sessions.
#
# SMTP_PASSWORD IS DELIBERATELY EMPTY. It is the Hostinger mailbox password and
# has no business in a version-controlled script; fill it in here, on the box,
# then \`systemctl restart leadportal@blue leadportal@green\`.
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=leads@spiderhunts-coworkingspace.com
SMTP_FROM=leads@spiderhunts-coworkingspace.com
SMTP_PASSWORD=
EOF
  chmod 600 "${ENV_DIR}/env"
else
  warn "${ENV_DIR}/env exists — left untouched."
  # ...except for a key added after that file was first written. Appending is
  # safe (last assignment wins in both systemd and `.`-sourcing) and skipped
  # when the key is already there, so re-running never duplicates it.
  if ! grep -q '^INGEST_TOKEN=' "${ENV_DIR}/env"; then
    printf 'INGEST_TOKEN="%s"\n' "$INGEST_TOKEN" >> "${ENV_DIR}/env"
    log "Added INGEST_TOKEN to the existing ${ENV_DIR}/env"
  fi
  if ! grep -q '^RECORDINGS_DIR=' "${ENV_DIR}/env"; then
    printf 'RECORDINGS_DIR="%s"\n' "$RECORDINGS_DIR_PATH" >> "${ENV_DIR}/env"
    log "Added RECORDINGS_DIR to the existing ${ENV_DIR}/env"
  fi
  # The screenshot block, added with the Monitor's scheduler. One key at a time,
  # so an operator who has already chosen a retention window keeps it.
  if ! grep -q '^SCREENSHOTS_DIR=' "${ENV_DIR}/env"; then
    printf 'SCREENSHOTS_DIR="%s"\n' "$SCREENSHOTS_DIR_PATH" >> "${ENV_DIR}/env"
    log "Added SCREENSHOTS_DIR to the existing ${ENV_DIR}/env"
  fi
  if ! grep -q '^SCREENSHOT_RETENTION_DAYS=' "${ENV_DIR}/env"; then
    printf 'SCREENSHOT_RETENTION_DAYS=%s\n' "30" >> "${ENV_DIR}/env"
    log "Added SCREENSHOT_RETENTION_DAYS to the existing ${ENV_DIR}/env"
  fi
  if ! grep -q '^SCREENSHOT_RETENTION_TOKEN=' "${ENV_DIR}/env"; then
    printf 'SCREENSHOT_RETENTION_TOKEN="%s"\n' "$SCREENSHOT_RETENTION_TOKEN" >> "${ENV_DIR}/env"
    log "Added SCREENSHOT_RETENTION_TOKEN to the existing ${ENV_DIR}/env"
  fi
  # The SMTP block, added when email OTP was introduced. Appended one key at a
  # time so an operator who has already filled in a value keeps it, and with
  # SMTP_PASSWORD left empty for exactly the same reason it is empty above.
  if ! grep -q '^SMTP_HOST=' "${ENV_DIR}/env"; then
    {
      printf 'SMTP_HOST=%s\n' "smtp.hostinger.com"
      printf 'SMTP_PORT=%s\n' "465"
      printf 'SMTP_USER=%s\n' "leads@spiderhunts-coworkingspace.com"
      printf 'SMTP_FROM=%s\n' "leads@spiderhunts-coworkingspace.com"
      printf 'SMTP_PASSWORD=\n'
    } >> "${ENV_DIR}/env"
    warn "Added the SMTP block to ${ENV_DIR}/env — set SMTP_PASSWORD before anyone tries to sign in."
  fi
fi

# Sign-in is impossible without this, so say so every run rather than only on
# the run that added the key.
if ! grep -qE '^SMTP_PASSWORD=.+' "${ENV_DIR}/env"; then
  warn "SMTP_PASSWORD is empty in ${ENV_DIR}/env. Verification codes cannot be sent, and NOBODY WILL BE ABLE TO SIGN IN until it is set."
fi

printf 'PORT=%s\n' "$BLUE_PORT"  > "${ENV_DIR}/slot-blue.env"
printf 'PORT=%s\n' "$GREEN_PORT" > "${ENV_DIR}/slot-green.env"
chmod 600 "${ENV_DIR}"/slot-*.env

# --- systemd ---------------------------------------------------------------
log "Installing systemd template unit"
install -m 644 "$(dirname "$0")/leadportal@.service" /etc/systemd/system/leadportal@.service
systemctl daemon-reload

# --- Nightly backup ---------------------------------------------------------
# Installed here rather than left as undocumented server state, so a rebuilt box
# gets it without anyone remembering. Idempotent: the script is overwritten each
# run (it is version-controlled, so that is the point) and the crontab line is
# only appended when absent.
#
# 03:45 is chosen to clear the 03:30 spideychat and leadquasar dumps — three
# concurrent pg_dumps against the one shared cluster is avoidable load, and this
# box has been saturated by careless scheduling before (see the CONCURRENCY note
# on the leadquasar warm-pages job).
log "Installing nightly backup"
install -m 750 "$(dirname "$0")/leadportal-backup" /usr/local/bin/leadportal-backup
install -d -m 700 "/var/backups/${SITE}/daily" "/var/backups/${SITE}/weekly"

CRON_LINE="45 3 * * * /usr/local/bin/${SITE}-backup >> /var/log/${SITE}-backup.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "${SITE}-backup"; then
  log "Backup cron entry already present, leaving it alone"
else
  # Read-modify-write of root's crontab. `crontab -l` exits non-zero when no
  # crontab exists at all, hence the `|| true` — without it this would install
  # an empty crontab over the ten jobs the other sites depend on.
  { crontab -l 2>/dev/null || true; \
    printf '\n# Lead Portal: nightly Postgres dump + recordings, 14 daily / 8 weekly.\n'; \
    printf '%s\n' "$CRON_LINE"; } | crontab -
  log "Added nightly backup at 03:45"
fi

# Keep the log from growing without bound, the same way every other site here
# does it.
cat > "/etc/logrotate.d/${SITE}-backup" <<EOF
/var/log/${SITE}-backup.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  create 640 root adm
  # /var/log is root:syslog 775 on this box, and logrotate refuses to rotate
  # inside a directory writable by a group other than its own user unless told
  # explicitly whose privileges to use. Without this the rule silently skips
  # every run and the log grows forever. \`su root root\` is what cloud-init and
  # postgresql-common already use here.
  su root root
}
EOF

# --- Nightly screenshot retention -------------------------------------------
# The server owns retention, not the agent's workstation — so it is scheduled
# here, on the same crontab the backup uses, rather than left to a timer inside
# the application. A `setInterval` in the Node process would run once per PM2
# worker and once per blue/green slot; cron runs it once.
#
# 04:30 is after the 03:45 dump has finished, on purpose: a sweep that deleted a
# month of screenshots *before* the night's backup would mean the only copy of
# them disappearing from both places on the same night.
#
# The script itself deletes nothing. It calls the application, which deletes by
# database row and server-stamped `created_at` — never by filename.
log "Installing nightly screenshot retention"
install -m 750 "$(dirname "$0")/leadportal-screenshot-retention" \
  "/usr/local/bin/${SITE}-screenshot-retention"

RETENTION_CRON="30 4 * * * /usr/local/bin/${SITE}-screenshot-retention >> /var/log/${SITE}-screenshot-retention.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "${SITE}-screenshot-retention"; then
  log "Screenshot retention cron entry already present, leaving it alone"
else
  { crontab -l 2>/dev/null || true; \
    printf '\n# Lead Portal: delete screenshots past SCREENSHOT_RETENTION_DAYS (file + row).\n'; \
    printf '%s\n' "$RETENTION_CRON"; } | crontab -
  log "Added nightly screenshot retention at 04:30"
fi

cat > "/etc/logrotate.d/${SITE}-screenshot-retention" <<EOF
/var/log/${SITE}-screenshot-retention.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  create 640 root adm
  su root root
}
EOF

# --- Basic Auth ------------------------------------------------------------
HTPASSWD="/etc/nginx/${SITE}.htpasswd"
if [[ ! -f "$HTPASSWD" ]]; then
  command -v htpasswd >/dev/null || { apt-get update -qq && apt-get install -y -qq apache2-utils; }
  BASIC_USER="agent"
  BASIC_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 18)"
  htpasswd -bcB "$HTPASSWD" "$BASIC_USER" "$BASIC_PASS" >/dev/null 2>&1
  chown root:www-data "$HTPASSWD"; chmod 640 "$HTPASSWD"
  printf '\n\033[1;33m  PORTAL LOGIN: %s / %s\033[0m\n' "$BASIC_USER" "$BASIC_PASS"
  printf '  Write this down — it is bcrypt-hashed and cannot be recovered.\n\n'
else
  log "Basic Auth file already exists, leaving it alone"
fi

# --- nginx: HTTP only, so certbot can issue -------------------------------
# Two-stage on purpose: the TLS block cannot be installed before the
# certificate exists, because nginx fails to start when ssl_certificate points
# at a missing file — and that would take down all ten sites, not just this one.
log "Installing temporary HTTP-only vhost for ACME validation"
cat > "/etc/nginx/sites-available/${SITE}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${ALT_DOMAIN};
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 200 'provisioning\n'; add_header Content-Type text/plain; }
}
EOF
ln -sfn "/etc/nginx/sites-available/${SITE}" "/etc/nginx/sites-enabled/${SITE}"

# If the config is bad, unlink before dying. Leaving a broken vhost enabled
# would not break nginx now (it is still running the old config) but would make
# the NEXT reload fail — for whoever runs it, on whichever of the ten sites they
# were actually trying to change. That is a booby trap, not an error.
if ! nginx -t 2>&1; then
  rm -f "/etc/nginx/sites-enabled/${SITE}"
  die "nginx config test failed. Vhost removed; other sites untouched."
fi
systemctl reload nginx

log "Requesting a Let's Encrypt certificate for ${DOMAIN} and ${ALT_DOMAIN}"
# webroot, not --nginx: the nginx plugin rewrites config files, and on a box
# with ten vhosts that is a blast radius worth avoiding. This is the same
# method the existing saleshandy-sslip site uses.
#
# --expand rather than a bare re-issue, and --cert-name pinned, so re-running
# this after adding a name extends the existing lineage instead of creating a
# second one beside it. Two lineages for one vhost is how you end up renewing
# the certificate nginx is not serving.
if [[ ! -d "/etc/letsencrypt/live/${CERT_NAME}" ]]; then
  certbot certonly --webroot -w "$WEBROOT" -d "$ALT_DOMAIN" -d "$DOMAIN" \
    --cert-name "$CERT_NAME" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    || die "Certificate issuance failed. The HTTP vhost is in place; fix and re-run."
elif ! openssl x509 -in "/etc/letsencrypt/live/${CERT_NAME}/cert.pem" -noout -text 2>/dev/null \
       | grep -q "DNS:${DOMAIN}"; then
  log "Certificate exists but does not cover ${DOMAIN} — expanding it"
  certbot certonly --webroot -w "$WEBROOT" -d "$ALT_DOMAIN" -d "$DOMAIN" \
    --cert-name "$CERT_NAME" --expand \
    --non-interactive --agree-tos --register-unsafely-without-email \
    || die "Certificate expansion failed. The previous certificate is still in place."
else
  log "Certificate already exists and covers both names"
fi

# --- nginx: the real vhost -------------------------------------------------
log "Installing the TLS vhost"
cp "/etc/nginx/sites-available/${SITE}" "/tmp/${SITE}.http-only.bak"
install -m 644 "$(dirname "$0")/nginx/leadportal.conf" "/etc/nginx/sites-available/${SITE}"

# The upstream file is DEPLOY-MANAGED — deploy.sh rewrites it on every deploy to
# name the live colour slot. The copy in the repo is only a first-run seed.
# Installing it unconditionally silently repointed nginx back to whichever slot
# the seed names, which on a re-run is a slot that may be running older code, or
# be stopped, or (as happened here) be missing an environment variable that had
# just been added. Traffic moved with no deploy and no log line saying so.
if [[ ! -f "/etc/nginx/conf.d/${SITE}-upstream.conf" ]]; then
  install -m 644 "$(dirname "$0")/nginx/leadportal-upstream.conf" "/etc/nginx/conf.d/${SITE}-upstream.conf"
  log "Seeded the upstream file (first run)"
else
  log "Upstream file left alone — deploy.sh owns it ($(grep -o '127.0.0.1:[0-9]*' "/etc/nginx/conf.d/${SITE}-upstream.conf"))"
fi

# Same reasoning as above: revert to the known-good HTTP-only vhost rather than
# leaving a config that will fail somebody else's reload later.
if ! nginx -t 2>&1; then
  cp "/tmp/${SITE}.http-only.bak" "/etc/nginx/sites-available/${SITE}"
  rm -f "/etc/nginx/conf.d/${SITE}-upstream.conf"
  die "TLS vhost failed validation. Reverted to the HTTP-only vhost; other sites untouched."
fi
systemctl reload nginx

log "Provisioning complete."
cat <<EOF

  URL:       https://${DOMAIN}
  App dir:   ${APP_ROOT}
  Slots:     blue=${BLUE_PORT}  green=${GREEN_PORT}
  Database:  ${DB_NAME} (role ${DB_USER}) on the existing PG 17 cluster

  Scraper ingest token (POST /api/leads/ingest):
    ${INGEST_TOKEN}
    Also in ${INGEST_TOKEN_FILE}. Give it to the scraper as LEAD_PORTAL_TOKEN.

  Untouched: every other vhost, database, and the firewall.

Next:
  git clone <repo> ${APP_ROOT}/repo
  bash ${APP_ROOT}/repo/deploy/deploy.sh

EOF
