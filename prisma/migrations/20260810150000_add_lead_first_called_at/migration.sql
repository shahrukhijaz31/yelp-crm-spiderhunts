-- AlterTable
--
-- `first_called_at` is when a lead was first *worked*: stamped once, when an
-- agent saves a call outcome, and never cleared. It is what the worklist's
-- New/Called split reads, and it is a column rather than a re-reading of
-- `status` because a status can be moved back to `not_called` by a correction,
-- which must not send a lead that has already been called back to the New
-- queue for someone to call again.
--
-- Nullable with no default, so the add is metadata-only and takes no table
-- rewrite: existing rows get NULL, which is exactly "never called".
ALTER TABLE "leads" ADD COLUMN "first_called_at" TIMESTAMP(3);

-- Backfill.
--
-- Every lead already carrying a status other than `not_called` has, by
-- definition, been worked — that is what `isCalled` has always meant — so those
-- rows belong in Called from the first page load rather than reappearing in New
-- for agents to redial. `updated_at` is the closest honest instant available for
-- when that happened: it is the last time the row was touched, and for a lead
-- whose only edits are its call outcome it *is* the call. Rows never worked keep
-- their NULL.
UPDATE "leads" SET "first_called_at" = "updated_at" WHERE "status" <> 'not_called';

-- CreateIndex
CREATE INDEX "leads_first_called_at_idx" ON "leads"("first_called_at");
