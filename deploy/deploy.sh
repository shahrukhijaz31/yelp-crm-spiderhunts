#!/usr/bin/env bash
#
# Lead Portal — blue/green deploy. Runs ON the VPS, as root.
#
#   bash /var/www/vhosts/leadportal/repo/deploy/deploy.sh [git-ref]
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

# --- 0. Run from a copy, never from the working tree ------------------------
# Step 2 does `git checkout`, which rewrites the files in this repository —
# including THIS script. bash does not read a script into memory up front; it
# reads lazily and remembers a byte offset. Replacing the file underneath a
# running shell therefore makes it resume at that offset in the NEW file, which
# silently executes the wrong lines — that is exactly how a deploy ended up
# running the previous commit's `npm ci` and building without devDependencies.
#
# Copying to a temp file and re-exec'ing pins the logic for the whole run.
if [[ "${DEPLOY_PINNED:-}" != "1" ]]; then
  _pinned="$(mktemp /tmp/leadportal-deploy.XXXXXX.sh)"
  cat "$0" > "$_pinned"
  chmod +x "$_pinned"
  export DEPLOY_PINNED=1
  trap 'rm -f "$_pinned"' EXIT
  bash "$_pinned" "$@"
  exit $?
fi

SITE="leadportal"
APP_USER="leadportal"
APP_ROOT="/var/www/vhosts/${SITE}"
REPO_DIR="${APP_ROOT}/repo"
ENV_FILE="/etc/${SITE}/env"
UPSTREAM_FILE="/etc/nginx/conf.d/${SITE}-upstream.conf"
# Only used for the post-flip health check below, which forces the connection to
# 127.0.0.1 anyway — so this needs to be a name the certificate and `server_name`
# both carry, not necessarily the one users type.
DOMAIN="leads.spiderhunts-coworkingspace.com"
GIT_REF="${1:-main}"

declare -A SLOT_PORT=( [blue]=3031 [green]=3032 )

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."
[[ -f "$ENV_FILE" ]] || die "${ENV_FILE} missing. Run deploy/provision.sh first."
[[ -d "$REPO_DIR/.git" ]] || die "${REPO_DIR} is not a git checkout. See deploy/README.md."

# --- 1. Which slot is live? ------------------------------------------------
# Read the port off the `server` directive, not from anywhere in the file. A
# bare `grep 3032` also matched the seed file's comment explaining which ports
# were chosen — so with blue live, this reported green, then "deployed" into
# blue: the slot that was actually serving. The safety of blue/green depends
# entirely on this answer being right.
LIVE_PORT="$(sed -n 's/^[[:space:]]*server[[:space:]]\+127\.0\.0\.1:\([0-9]\+\).*/\1/p' \
             "$UPSTREAM_FILE" 2>/dev/null | head -1)"

if [[ "$LIVE_PORT" == "${SLOT_PORT[green]}" ]]; then
  LIVE=green; IDLE=blue
elif [[ "$LIVE_PORT" == "${SLOT_PORT[blue]}" ]]; then
  LIVE=blue;  IDLE=green
elif [[ -z "$LIVE_PORT" ]]; then
  # No upstream yet — first deploy. Blue is the seed's slot.
  LIVE=green; IDLE=blue
else
  die "Upstream names port ${LIVE_PORT}, which is neither slot (${SLOT_PORT[blue]}/${SLOT_PORT[green]}). Refusing to guess which slot is serving."
fi
IDLE_PORT="${SLOT_PORT[$IDLE]}"
IDLE_DIR="${APP_ROOT}/${IDLE}"

log "Live slot: ${LIVE}    Deploying into: ${IDLE} (port ${IDLE_PORT})"

# --- 2. Fetch the requested revision ---------------------------------------
log "Fetching ${GIT_REF}"
# Belt and braces against "detected dubious ownership": provision.sh keeps this
# repo owned by root, but a box provisioned before that fix still has it owned
# by the app user, and git refuses to touch a repo it does not own. Declaring it
# safe is idempotent and costs nothing.
git config --global --get-all safe.directory | grep -qxF "$REPO_DIR" \
  || git config --global --add safe.directory "$REPO_DIR"
git -C "$REPO_DIR" fetch --prune origin
# -f, and a hard reset afterwards: this checkout is a build artefact, not
# somewhere anyone should be editing. Without it, one stray local change — an
# scp'd hotfix, a half-finished experiment — aborts every future deploy with
# "local changes would be overwritten". Anything genuinely worth keeping belongs
# in a commit, so discarding here is the correct behaviour rather than a risk.
git -C "$REPO_DIR" checkout -qf --detach "origin/${GIT_REF}" 2>/dev/null \
  || git -C "$REPO_DIR" checkout -qf --detach "$GIT_REF"
git -C "$REPO_DIR" reset -q --hard HEAD
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
log "Building ${SHA} ($(git -C "$REPO_DIR" log -1 --pretty=%s))"

# --- 3. Build ---------------------------------------------------------------
# Built in the repo directory, then the self-contained standalone output is
# copied into the slot. Building directly in the slot would mean the idle slot
# is a broken half-build for the duration, which matters the moment you need to
# roll back to it mid-deploy.
cd "$REPO_DIR"

# Loaded before npm ci, not after: the `postinstall` hook runs `prisma
# generate`, so the environment has to be in place from the very first command.
set -a; . "$ENV_FILE"; set +a

log "Installing dependencies (npm ci)"
# --include=dev is REQUIRED, not decorative. The env sourced just above sets
# NODE_ENV=production, and npm silently omits devDependencies in that case —
# which here means no @tailwindcss/postcss, no typescript and no prisma CLI, so
# the build fails partway through on a missing PostCSS plugin.
#
# Those dev packages never reach the server that runs: `output: standalone`
# traces only what the running server actually imports, and the built release is
# copied out of .next/standalone, not out of node_modules.
npm ci --include=dev --no-audit --no-fund

log "Generating Prisma Client"
npx prisma generate

log "Applying database migrations"
# `migrate deploy`, never `migrate dev`: deploy applies committed migrations and
# nothing else. `dev` can generate new migrations and, on drift, offers to reset
# the database — behaviour that has no place near production data.
npx prisma migrate deploy

log "Building Next.js"
# Clean first. Turbopack caches resolution results under .next/build/chunks, and
# a build that failed for an environmental reason (a missing dependency, say)
# leaves that failure cached — so every later build reproduces the original
# error even after the cause is fixed, and the fix looks like it did nothing.
# A deploy must depend on the commit it is building, not on what the last one
# left behind.
rm -rf .next
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
log "Starting leadportal@${IDLE}"
systemctl restart "leadportal@${IDLE}"

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
  journalctl -u "leadportal@${IDLE}" -n 40 --no-pager || true
  systemctl stop "leadportal@${IDLE}" || true
  die "Deploy aborted; nothing changed for users."
fi

# --- 6. Flip nginx ---------------------------------------------------------
log "Pointing nginx at ${IDLE} (port ${IDLE_PORT})"
cat > "$UPSTREAM_FILE" <<EOF
# Generated by deploy/deploy.sh — do not edit by hand.
# Live slot: ${IDLE}    Release: ${SHA}
upstream leadportal_upstream {
    server 127.0.0.1:${IDLE_PORT};
    keepalive 32;
}
EOF

nginx -t || die "nginx rejected the generated upstream; traffic unchanged."
systemctl reload nginx

# Confirm through the proxy, not just the port, before tearing anything down.
# --resolve rather than plain https://127.0.0.1: this server has no
# default_server, so a request without the right Host matches no vhost at all.
# Sending the real hostname also means the certificate is validated for real,
# which a -k against the loopback address never would.
sleep 1
curl -fsS --max-time 5 --resolve "${DOMAIN}:443:127.0.0.1" \
  "https://${DOMAIN}/api/health" >/dev/null \
  || warn "Health check through nginx did not answer; investigate before the next deploy."

# --- 7. Retire the old slot ------------------------------------------------
# Drain before stopping. `systemctl reload nginx` starts new workers on the new
# config, but the OLD workers keep running until their existing connections
# finish — and those workers still hold keepalive connections to the OLD port.
# Stopping that backend immediately kills whatever is still in flight on them,
# which is measurable: an unthrottled probe across a deploy caught exactly one
# failed request out of 233 at this point in the sequence.
#
# 10s comfortably covers a drain here (`keepalive 32` in the upstream, and the
# slowest normal request is a CSV import at a couple of seconds). The old slot
# is idle for this window, not serving new traffic — nginx already stopped
# routing to it — so the wait costs nothing but deploy time.
log "Draining connections from ${LIVE} before stopping it"
sleep 10

log "Stopping leadportal@${LIVE}"
systemctl stop "leadportal@${LIVE}" || true
systemctl enable "leadportal@${IDLE}" >/dev/null 2>&1 || true
systemctl disable "leadportal@${LIVE}" >/dev/null 2>&1 || true

# The previous release stays on disk as ${LIVE} — that is what rollback.sh
# restarts. Only the generation before it is deleted.
rm -rf "${IDLE_DIR}.old"

log "Deployed ${SHA} to ${IDLE}. Previous release (${LIVE}) is intact for rollback."
cat <<EOF

  Live:      ${IDLE} on 127.0.0.1:${IDLE_PORT}
  Rollback:  bash ${REPO_DIR}/deploy/rollback.sh
  Logs:      journalctl -u leadportal@${IDLE} -f

EOF

# --- A note on migration safety --------------------------------------------
# Between step 3 and step 6 the OLD code runs against the NEW schema. That is
# safe for additive changes (new nullable column, new table, new index) and is
# the normal case. It is NOT safe for a migration that drops or renames a column
# the old code still selects — that will throw for the seconds between migrate
# and flip. For those, use the two-deploy expand/contract pattern: deploy once
# adding the new shape and writing to both, then a second deploy removing the
# old. See deploy/README.md.
