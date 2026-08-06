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
DB_NAME="lead_portal"
DB_USER="leadportal"
DOMAIN="leadportal.169-58-34-205.sslip.io"
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

for p in "$BLUE_PORT" "$GREEN_PORT"; do
  ss -tln | grep -q ":${p} " && die "Port ${p} is already in use. Pick another pair and update deploy.sh."
done
echo "  ports ${BLUE_PORT}/${GREEN_PORT} free"

getent hosts "$DOMAIN" >/dev/null || die "${DOMAIN} does not resolve. sslip.io may be down."
echo "  ${DOMAIN} resolves"

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
chown -R "${DB_USER}:${DB_USER}" "$APP_ROOT"
chmod 750 "$APP_ROOT"

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
EOF
  chmod 600 "${ENV_DIR}/env"
else
  warn "${ENV_DIR}/env exists — left untouched."
fi

printf 'PORT=%s\n' "$BLUE_PORT"  > "${ENV_DIR}/slot-blue.env"
printf 'PORT=%s\n' "$GREEN_PORT" > "${ENV_DIR}/slot-green.env"
chmod 600 "${ENV_DIR}"/slot-*.env

# --- systemd ---------------------------------------------------------------
log "Installing systemd template unit"
install -m 644 "$(dirname "$0")/leadportal@.service" /etc/systemd/system/leadportal@.service
systemctl daemon-reload

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
    server_name ${DOMAIN};
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

log "Requesting a Let's Encrypt certificate for ${DOMAIN}"
# webroot, not --nginx: the nginx plugin rewrites config files, and on a box
# with ten vhosts that is a blast radius worth avoiding. This is the same
# method the existing saleshandy-sslip site uses.
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    || die "Certificate issuance failed. The HTTP vhost is in place; fix and re-run."
else
  log "Certificate already exists"
fi

# --- nginx: the real vhost -------------------------------------------------
log "Installing the TLS vhost"
cp "/etc/nginx/sites-available/${SITE}" "/tmp/${SITE}.http-only.bak"
install -m 644 "$(dirname "$0")/nginx/leadportal.conf" "/etc/nginx/sites-available/${SITE}"
install -m 644 "$(dirname "$0")/nginx/leadportal-upstream.conf" "/etc/nginx/conf.d/${SITE}-upstream.conf"

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

  Untouched: every other vhost, database, and the firewall.

Next:
  git clone <repo> ${APP_ROOT}/repo
  bash ${APP_ROOT}/repo/deploy/deploy.sh

EOF
