-- Screenshot-subsystem health reported by a workstation.
--
-- Additive and nullable, so an older Monitor that never reports leaves both
-- columns NULL and the dashboard falls back to judging the screenshot gap alone
-- — which is the actual control. No backfill, no default, no rewrite of the
-- table: every existing row is already correct as NULL.
--
-- `capture_health` is a free-text code validated in the application layer
-- (`lib/captureHealthRules.ts`) rather than a Postgres enum, deliberately:
-- adding a reason should not need a migration, and this column is never used in
-- a predicate that a bad value could subvert.
ALTER TABLE "monitor_devices"
  ADD COLUMN "capture_health" TEXT,
  ADD COLUMN "capture_health_at" TIMESTAMP(3);
