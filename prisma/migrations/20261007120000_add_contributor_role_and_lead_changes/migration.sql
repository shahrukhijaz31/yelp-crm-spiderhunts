-- The Contributor role, the lead's creator, and the lead change history.
--
-- `ADD VALUE` is safe inside the migration's transaction on PG 12+ as long as
-- nothing in the same transaction uses the new value, and nothing here does.
ALTER TYPE "user_role" ADD VALUE 'CONTRIBUTOR';

-- Who typed a lead in by hand. Null for every existing row: they all came from
-- a CSV import or the scraper, and nobody in particular added them.
ALTER TABLE "leads" ADD COLUMN "created_by_user_id" TEXT;

CREATE INDEX "leads_created_by_user_id_idx" ON "leads"("created_by_user_id");

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Field-by-field history of every lead edit. Starts empty: there is no record
-- of past edits to backfill it from.
CREATE TABLE "lead_changes" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "user_id" TEXT,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_changes_lead_id_created_at_idx" ON "lead_changes"("lead_id", "created_at");

CREATE INDEX "lead_changes_user_id_idx" ON "lead_changes"("user_id");

ALTER TABLE "lead_changes"
  ADD CONSTRAINT "lead_changes_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_changes"
  ADD CONSTRAINT "lead_changes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
