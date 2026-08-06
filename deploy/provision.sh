#!/usr/bin/env bash
#
# Lead Portal — one-time VPS bootstrap. Ubuntu 22.04 / 24.04.
#
#   scp deploy/provision.sh root@169.58.34.205:/root/
#   ssh root@169.58.34.205 'bash /root/provision.sh'
#
# Idempotent: safe to re-run. It installs nothing it finds already present and
# never overwrites the password file, the certificate or the env file once they
# exist, so a re-run cannot silently rotate a credential out from under you.
#
# What it does NOT do: check out the code or start the app. That is deploy.sh,
# so that the first deploy and every later one take exactly the same path and
# the deploy script is never a special case on day one.

set -euo pipefail

APP_NAME="lead-portal"
APP_USER="leadportal"
APP_ROOT="/var/www/${APP_NAME}"
ENV_DIR="/etc/${APP_NAME}"
CERT_DIR="/etc/ssl/${APP_NAME}"
NODE_MAJOR=22
DB_NAME="lead_portal"
DB_USER="leadportal"
SERVER_IP="169.58.34.205"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

# --- Packages --------------------------------------------------------------
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git rsync ufw \
  nginx apache2-utils \
  postgresql postgresql-contrib \
  openssl

# Node 22 LTS. Ubuntu's own `nodejs` package is far too old — Next.js 16
# requires >= 20.9, and 24.04 ships 18.x.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
else
  log "Node $(node -v) already present, leaving it alone"
fi

# --- Service account -------------------------------------------------------
# A system account with no login shell and no home: the app never needs to be
# a person, and a compromised render process should not get a shell.
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Creating service account ${APP_USER}"
  adduser --system --group --no-create-home --shell /usr/sbin/nologin "$APP_USER"
else
  log "Service account ${APP_USER} already exists"
fi

# --- Directories -----------------------------------------------------------
log "Creating ${APP_ROOT}"
mkdir -p "$APP_ROOT"/{releases,blue,green,repo}
chown -R "${APP_USER}:${APP_USER}" "$APP_ROOT"
# 750: the service account and root can read it, nobody else on the box can.
chmod 750 "$APP_ROOT"

# --- PostgreSQL ------------------------------------------------------------
log "Configuring PostgreSQL"
systemctl enable --now postgresql

DB_PASS_FILE="${ENV_DIR}/db-password"
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

if [[ ! -f "$DB_PASS_FILE" ]]; then
  # Generated, not chosen: this password is only ever read by the env file, so
  # there is no reason for a human to know it or to reuse one.
  openssl rand -base64 32 | tr -d '/+=' | head -c 32 > "$DB_PASS_FILE"
  chmod 600 "$DB_PASS_FILE"
  log "Generated a database password at ${DB_PASS_FILE}"
else
  log "Reusing existing database password"
fi
DB_PASS="$(cat "$DB_PASS_FILE")"

# A dedicated role that owns only this database — not the postgres superuser.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  sudo -u postgres psql -qc "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
  log "Created role ${DB_USER}"
else
  sudo -u postgres psql -qc "ALTER ROLE ${DB_USER} PASSWORD '${DB_PASS}';"
  log "Updated password for existing role ${DB_USER}"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  log "Created database ${DB_NAME} owned by ${DB_USER}"
else
  log "Database ${DB_NAME} already exists"
fi

# Prisma needs CREATE on the public schema to apply migrations. On PostgreSQL
# 15+ the public schema is no longer world-writable, so this is required.
sudo -u postgres psql -q -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

# --- Application environment ----------------------------------------------
# Postgres listens on loopback only by default on Ubuntu; nothing here changes
# that, so the database is not reachable from the internet at all.
if [[ ! -f "${ENV_DIR}/env" ]]; then
  log "Writing ${ENV_DIR}/env"
  cat > "${ENV_DIR}/env" <<EOF
# Lead Portal — shared runtime environment. Read by every systemd slot.
# Owned by root, mode 600: the app user cannot read it, systemd injects it.
NODE_ENV=production
# Bind to loopback only. nginx is the sole way in; without this the Node
# process would be reachable directly on the public IP, bypassing Basic Auth.
HOSTNAME=127.0.0.1
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}?schema=public&connection_limit=10
EOF
  chmod 600 "${ENV_DIR}/env"
else
  warn "${ENV_DIR}/env already exists — left untouched. Check DATABASE_URL matches ${DB_PASS_FILE}."
fi

log "Writing per-slot port files"
printf 'PORT=3001\n' > "${ENV_DIR}/slot-blue.env"
printf 'PORT=3002\n' > "${ENV_DIR}/slot-green.env"
chmod 600 "${ENV_DIR}"/slot-*.env

# --- systemd ---------------------------------------------------------------
log "Installing systemd template unit"
install -m 644 "$(dirname "$0")/lead-portal@.service" /etc/systemd/system/lead-portal@.service 2>/dev/null \
  || warn "lead-portal@.service not next to this script — copy it to /etc/systemd/system/ manually"
systemctl daemon-reload

# --- TLS -------------------------------------------------------------------
# Self-signed, because Let's Encrypt will not issue for a bare IP address.
# This gets the Basic Auth password off the wire; it does not prove identity.
mkdir -p "$CERT_DIR"
if [[ ! -f "${CERT_DIR}/privkey.pem" ]]; then
  log "Generating a self-signed certificate for ${SERVER_IP} (10 years)"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "${CERT_DIR}/privkey.pem" \
    -out "${CERT_DIR}/fullchain.pem" \
    -subj "/CN=${SERVER_IP}" \
    -addext "subjectAltName=IP:${SERVER_IP}" 2>/dev/null
  chmod 600 "${CERT_DIR}/privkey.pem"
  chmod 644 "${CERT_DIR}/fullchain.pem"
else
  log "Certificate already present, leaving it alone"
fi

# --- Basic Auth ------------------------------------------------------------
HTPASSWD=/etc/nginx/lead-portal.htpasswd
if [[ ! -f "$HTPASSWD" ]]; then
  BASIC_USER="agent"
  BASIC_PASS="$(openssl rand -base64 18 | tr -d '/+=' | head -c 18)"
  htpasswd -bcB "$HTPASSWD" "$BASIC_USER" "$BASIC_PASS" >/dev/null 2>&1
  chown root:www-data "$HTPASSWD"
  chmod 640 "$HTPASSWD"
  printf '\n\033[1;33m  LOGIN: %s / %s\033[0m\n' "$BASIC_USER" "$BASIC_PASS"
  printf '  Write this down now — it is bcrypt-hashed in %s and cannot be recovered.\n' "$HTPASSWD"
  printf '  Add more users later with: htpasswd -B %s <name>\n\n' "$HTPASSWD"
else
  log "Basic Auth file already exists, leaving it alone"
fi

# --- nginx -----------------------------------------------------------------
log "Installing nginx vhost"
SRC="$(dirname "$0")/nginx"
install -m 644 "${SRC}/lead-portal.conf" /etc/nginx/sites-available/lead-portal
install -m 644 "${SRC}/lead-portal-upstream.conf" /etc/nginx/conf.d/lead-portal-upstream.conf
ln -sfn /etc/nginx/sites-available/lead-portal /etc/nginx/sites-enabled/lead-portal

# Ubuntu's default vhost also claims default_server on :80, which collides.
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx

# --- Firewall --------------------------------------------------------------
log "Configuring ufw"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
# 3001/3002 are deliberately NOT opened: the app slots bind to 127.0.0.1 and
# must only be reachable through nginx. 5432 stays closed for the same reason.
ufw --force enable
ufw status verbose

log "Provisioning complete."
cat <<EOF

Next: deploy the application.

  ssh root@${SERVER_IP}
  bash ${APP_ROOT}/repo/deploy/deploy.sh        # after the first clone

The first deploy needs the repository present:

  git clone <repo-url> ${APP_ROOT}/repo
  bash ${APP_ROOT}/repo/deploy/deploy.sh

EOF
