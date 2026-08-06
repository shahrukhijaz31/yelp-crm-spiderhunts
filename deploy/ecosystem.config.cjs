/**
 * Lead Portal — PM2 configuration.
 *
 * ALTERNATIVE to the systemd units, not a companion. Run one or the other; two
 * supervisors both trying to own port 3001 will fight.
 *
 * systemd is the default in this repo (deploy/lead-portal@.service) because it
 * is already PID 1 on the box, already starts things at boot, already has
 * journald for logs and rotation, and already offers the sandboxing the unit
 * file uses (ProtectSystem, ReadWritePaths, MemoryMax). PM2 would add a second
 * long-running supervisor that itself needs a systemd unit to survive a reboot.
 *
 * PM2 does earn its place if you want:
 *   - `pm2 reload` cluster-mode restarts without the blue/green dance, or
 *   - more than one worker on a multi-core box.
 *
 * Both are configured below. If you use this, skip the blue/green parts of
 * deploy.sh and replace them with `pm2 reload lead-portal --update-env`, which
 * restarts workers one at a time so a listener is always accepting.
 *
 *   npm install -g pm2
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup systemd     # survive reboot
 */

module.exports = {
  apps: [
    {
      name: "lead-portal",

      // The standalone build's own entrypoint. Resolves its assets relative to
      // its directory, so cwd must be the standalone root, not the repo root.
      // deploy.sh copies the contents of .next/standalone into the slot root,
      // so server.js sits directly in the slot directory.
      script: "server.js",
      cwd: "/var/www/vhosts/leadportal/blue",

      // Cluster mode is what makes `pm2 reload` zero-downtime: PM2 restarts
      // workers one by one behind a shared listening socket.
      //
      // Safe here only because every route in this app is dynamic (`ƒ` in the
      // build output) — there is no ISR cache for workers to disagree about.
      // If a route ever becomes statically revalidated, either drop to a single
      // worker or configure a shared cacheHandler; per-worker on-disk caches
      // would otherwise serve different content depending on which one answers.
      exec_mode: "cluster",
      instances: 2,

      env: {
        NODE_ENV: "production",
        PORT: 3031,
        // Loopback only — nginx is the only way in, so the Basic Auth in front
        // of it cannot be bypassed by hitting the port directly.
        HOSTNAME: "127.0.0.1",
        // DATABASE_URL is deliberately absent: it is a secret and does not
        // belong in a file that is committed. Supply it at start time from the
        // same root-owned file systemd reads:
        //   set -a; . /etc/lead-portal/env; set +a
        //   pm2 start deploy/ecosystem.config.cjs --update-env
      },

      // Restart policy mirrors the systemd unit.
      autorestart: true,
      max_restarts: 5,
      min_uptime: "30s",
      restart_delay: 2000,

      // Matches MemoryMax=1G in the systemd unit: a runaway render should kill
      // the worker, not the Postgres process beside it.
      max_memory_restart: "1G",

      // PM2 owns rotation via pm2-logrotate (`pm2 install pm2-logrotate`);
      // without that these files grow unbounded, which journald would not.
      error_file: "/var/log/lead-portal/error.log",
      out_file: "/var/log/lead-portal/out.log",
      merge_logs: true,
      time: true,

      // Give in-flight CSV imports a chance to finish before SIGKILL.
      kill_timeout: 10000,
      listen_timeout: 15000,
    },
  ],
};
