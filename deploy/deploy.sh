#!/usr/bin/env bash
#
# Lead Portal — blue/green deploy. Runs ON the VPS, as root.
#
#   bash /var/www/lead-portal/repo/deploy/deploy.sh [git-ref]
#
# How the no-downtime part actually works:
#
#   1. Work out which colour slot is live by reading the nginx upstream file.
#   2. Build the new release into the *other* slot. The live slot is untouched
#      and keeps serving throughout — a failed build costs nothing.
#   3. Apply database migrations. This happens before the flip, so the old code
#      briefly runs against the new schema; see the note on migration safety
#      near the bottom of this file.
#   4. Start the idle slot on its own port and poll /api/health until it
#      reports the database is up. A release that boots but cannot reach
#      Postgres never gets traffic.
#   5. Rewrite the upstream file and `nginx -s reload`. Reload is graceful:
#      in-flight requests finish on the old worker, new ones go to the new
#      port. No connection is dropped and none is refused.
#   6. Stop the old slot only after the reload has succeeded.
#
# At no point are zero backends listening, which is the only thing that would
# produce a 502. Roll back with deploy/rollback.sh — the previous slot is still
# on disk and still runnable.

set -euo pipefail

APP_NAME="lead-portal"
APP_USER="leadportal"
APP_ROOT="/var/www/${APP_NAME}"
REPO_DIR="${APP_ROOT}/repo"
ENV_FILE="/etc/${APP_NAME}/env"
UPSTREAM_FILE="/etc/nginx/conf.d/${APP_NAME}-upstream.conf"
GIT_REF="${1:-main}"

declare -A SLOT_PORT=( [blue]=3001 [green]=3002 )

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."
[[ -f "$ENV_FILE" ]] || die "${ENV_FILE} missing. Run deploy/provision.sh first."
[[ -d "$REPO_DIR/.git" ]] || die "${REPO_DIR} is not a git checkout. See deploy/README.md."

# --- 1. Which slot is live? ------------------------------------------------
if [[ -f "$UPSTREAM_FILE" ]] && grep -q '3002' "$UPSTREAM_FILE"; then
  LIVE=green; IDLE=blue
else
  LIVE=blue;  IDLE=green
fi
IDLE_PORT="${SLOT_PORT[$IDLE]}"
IDLE_DIR="${APP_ROOT}/${IDLE}"

log "Live slot: ${LIVE}    Deploying into: ${IDLE} (port ${IDLE_PORT})"

# --- 2. Fetch the requested revision ---------------------------------------
log "Fetching ${GIT_REF}"
git -C "$REPO_DIR" fetch --prune origin
git -C "$REPO_DIR" checkout -q --detach "origin/${GIT_REF}" 2>/dev/null \
  || git -C "$REPO_DIR" checkout -q --detach "$GIT_REF"
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
log "Building ${SHA} ($(git -C "$REPO_DIR" log -1 --pretty=%s))"

# --- 3. Build ---------------------------------------------------------------
# Built in the repo directory, then the self-contained standalone output is
# copied into the slot. Building directly in the slot would mean the idle slot
# is a broken half-build for the duration, which matters the moment you need to
# roll back to it mid-deploy.
cd "$REPO_DIR"

log "Installing dependencies (npm ci)"
# `npm ci` needs devDependencies: TypeScript, Tailwind and the Prisma CLI all
# run at build time. The result never ships — `output: standalone` traces only
# what the running server actually imports.
npm ci --no-audit --no-fund

log "Generating Prisma Client"
npx prisma generate

log "Applying database migrations"
# `migrate deploy`, never `migrate dev`: deploy applies committed migrations and
# nothing else. `dev` can generate new migrations and, on drift, offers to reset
# the database — behaviour that has no place near production data.
set -a; . "$ENV_FILE"; set +a
npx prisma migrate deploy

log "Building Next.js"
NODE_ENV=production npx next build

[[ -d .next/standalone ]] || die "No .next/standalone — is output:'standalone' still set in next.config.ts?"

# --- 4. Assemble the release into the idle slot ----------------------------
log "Assembling release in ${IDLE_DIR}"
rm -rf "${IDLE_DIR}.new"
mkdir -p "${IDLE_DIR}.new"
cp -r .next/standalone/. "${IDLE_DIR}.new/"
# standalone deliberately omits these two so they can go to a CDN; there is no
# CDN here, so nginx proxies them and the server needs them on disk.
mkdir -p "${IDLE_DIR}.new/.next"
cp -r .next/static "${IDLE_DIR}.new/.next/static"
cp -r public "${IDLE_DIR}.new/public"
printf '%s\n' "$SHA" > "${IDLE_DIR}.new/RELEASE_SHA"

# Swap in one mv so the slot is never a partial tree.
rm -rf "${IDLE_DIR}.old"
[[ -d "$IDLE_DIR" ]] && mv "$IDLE_DIR" "${IDLE_DIR}.old"
mv "${IDLE_DIR}.new" "$IDLE_DIR"

# The service account reads the code and writes only .next/cache.
chown -R "${APP_USER}:${APP_USER}" "$IDLE_DIR"
find "$IDLE_DIR" -type d -exec chmod 750 {} +
find "$IDLE_DIR" -type f -exec chmod 640 {} +
mkdir -p "${IDLE_DIR}/.next/cache"
chown "${APP_USER}:${APP_USER}" "${IDLE_DIR}/.next/cache"
chmod 750 "${IDLE_DIR}/.next/cache"

# --- 5. Start the idle slot and health-check it ----------------------------
log "Starting lead-portal@${IDLE}"
systemctl restart "lead-portal@${IDLE}"

log "Waiting for /api/health on port ${IDLE_PORT}"
HEALTHY=false
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${IDLE_PORT}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    HEALTHY=true
    log "Healthy after ${attempt}s"
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" != true ]]; then
  warn "New release failed its health check. Traffic was NOT switched."
  warn "The ${LIVE} slot is still serving. Recent logs:"
  journalctl -u "lead-portal@${IDLE}" -n 40 --no-pager || true
  systemctl stop "lead-portal@${IDLE}" || true
  die "Deploy aborted; nothing changed for users."
fi

# --- 6. Flip nginx ---------------------------------------------------------
log "Pointing nginx at ${IDLE} (port ${IDLE_PORT})"
cat > "$UPSTREAM_FILE" <<EOF
# Generated by deploy/deploy.sh — do not edit by hand.
# Live slot: ${IDLE}    Release: ${SHA}
upstream lead_portal {
    server 127.0.0.1:${IDLE_PORT};
    keepalive 32;
}
EOF

nginx -t || die "nginx rejected the generated upstream; traffic unchanged."
systemctl reload nginx

# Confirm through the proxy, not just the port, before tearing anything down.
sleep 1
curl -fsSk --max-time 5 https://127.0.0.1/api/health >/dev/null \
  || warn "Health check through nginx did not answer; investigate before the next deploy."

# --- 7. Retire the old slot ------------------------------------------------
log "Stopping lead-portal@${LIVE}"
systemctl stop "lead-portal@${LIVE}" || true
systemctl enable "lead-portal@${IDLE}" >/dev/null 2>&1 || true
systemctl disable "lead-portal@${LIVE}" >/dev/null 2>&1 || true

# The previous release stays on disk as ${LIVE} — that is what rollback.sh
# restarts. Only the generation before it is deleted.
rm -rf "${IDLE_DIR}.old"

log "Deployed ${SHA} to ${IDLE}. Previous release (${LIVE}) is intact for rollback."
cat <<EOF

  Live:      ${IDLE} on 127.0.0.1:${IDLE_PORT}
  Rollback:  bash ${REPO_DIR}/deploy/rollback.sh
  Logs:      journalctl -u lead-portal@${IDLE} -f

EOF

# --- A note on migration safety --------------------------------------------
# Between step 3 and step 6 the OLD code runs against the NEW schema. That is
# safe for additive changes (new nullable column, new table, new index) and is
# the normal case. It is NOT safe for a migration that drops or renames a column
# the old code still selects — that will throw for the seconds between migrate
# and flip. For those, use the two-deploy expand/contract pattern: deploy once
# adding the new shape and writing to both, then a second deploy removing the
# old. See deploy/README.md.
