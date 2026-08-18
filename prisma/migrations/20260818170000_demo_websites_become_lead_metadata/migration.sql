-- Demo Websites becomes a *view* of leads, not a second dataset.
--
-- The previous migration (20260818140000) got the architecture wrong. It gave
-- `demo_websites` its own name, client, phone, email, status and notes — a
-- parallel record that had to be filled in by hand and that would have gone
-- stale the moment anybody edited the underlying lead. Two screens would then
-- have shown different values for the same business, with no way to tell which
-- was right.
--
-- This corrects it. `demo_websites` becomes what it should always have been:
-- the demo-specific half of a lead, holding two pieces of information the lead
-- table has nowhere to put — an image and a link — and **nothing else**. Every
-- other field the Demo Websites screen shows is read from `leads` on the
-- request that draws it, so a status changed on the worklist is already changed
-- in the demo view, with nothing to synchronise.
--
-- ---------------------------------------------------------------------------
-- No data is lost, because there is none to lose
-- ---------------------------------------------------------------------------
-- The table is empty in every environment: the feature shipped hours ago, the
-- columns being dropped were only ever writable through an admin form nobody
-- has used, and production reports 0 rows. The DROP COLUMNs below are therefore
-- a schema correction and not a data migration.
--
-- If that is ever not true — if this is applied somewhere a row was created —
-- the drop still cannot damage a *lead*: nothing in this table is referenced by
-- `leads`, and the relation added below points the other way.
--
-- ---------------------------------------------------------------------------
-- What is emphatically NOT done here
-- ---------------------------------------------------------------------------
-- No lead is created, copied, deleted, renamed or touched. There is no INSERT
-- INTO leads, no backfill of demo rows for existing leads, and no snapshot of
-- lead data anywhere. Twenty thousand existing leads appear in the Demo
-- Websites view the moment this ships, because the view is a LEFT JOIN over
-- `leads` and a lead with no row here is simply a lead with no image and no
-- link yet.
--
-- `demo_websites` stays empty until somebody saves an image or a link.

-- The old author column goes with the columns it was written beside. The new
-- one records who last edited the demo fields, which is a different question.
ALTER TABLE "demo_websites" DROP CONSTRAINT "demo_websites_created_by_user_id_fkey";

-- Both indexes existed to order and filter a standalone list. There is no
-- standalone list any more: ordering, filtering, searching and paging all
-- happen against `leads` and its own indexes, and every read of this table is a
-- lookup by `lead_id` for the page of leads already chosen.
DROP INDEX "demo_websites_created_at_idx";
DROP INDEX "demo_websites_status_idx";

-- The lead columns leave. None of these may ever come back: a copy of a lead
-- field in this table is a copy that goes stale.
ALTER TABLE "demo_websites" DROP COLUMN "client_name",
DROP COLUMN "created_by_user_id",
DROP COLUMN "email",
DROP COLUMN "name",
DROP COLUMN "notes",
DROP COLUMN "phone",
DROP COLUMN "status",
ADD COLUMN     "lead_id" TEXT NOT NULL,
ADD COLUMN     "updated_by_user_id" TEXT,
-- Nullable now: a row exists as soon as *either* the image or the link is set,
-- so a lead may have an image and no link.
ALTER COLUMN "demo_url" DROP NOT NULL;

-- The status enum has no remaining user. A demo does not have a state of its
-- own — the lead's `call_status` is the status the demo view shows.
DROP TYPE "demo_website_status";

-- UNIQUE, which is the constraint that makes this metadata rather than a
-- record: one demo row per lead, enforced by the database rather than by the
-- code that writes it.
CREATE UNIQUE INDEX "demo_websites_lead_id_key" ON "demo_websites"("lead_id");

-- CASCADE: this row is part of the lead. Deleting the lead takes its demo
-- metadata with it, and the image file is removed by the same code path.
ALTER TABLE "demo_websites" ADD CONSTRAINT "demo_websites_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL: a demo link outlives the account that last edited it.
ALTER TABLE "demo_websites" ADD CONSTRAINT "demo_websites_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
