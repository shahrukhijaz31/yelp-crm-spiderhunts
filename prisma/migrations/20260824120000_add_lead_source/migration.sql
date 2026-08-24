-- Where a lead was scraped from.
--
-- Until now every row in this table came from one scraper reading Yelp, so the
-- directory a lead came from was not worth recording — there was only one
-- answer. A second scraper (Google Maps) now pushes to the same
-- `/api/leads/ingest`, into the same table, and the two directories disagree
-- about the same business often enough that an agent needs to know which one
-- they are looking at: Google carries a phone Yelp does not, Yelp carries an
-- owner Google does not, and a rating means a different thing on each.
--
-- An enum rather than free text, for the same reason `call_status` is one: this
-- value is filtered on, drawn as a badge and written by a machine on another
-- box, and a scraper that starts sending "Google Maps" instead of "google"
-- should be refused at the door rather than quietly creating a third source
-- nothing in the UI knows how to label.
CREATE TYPE "lead_source" AS ENUM ('yelp', 'google');

-- `DEFAULT 'yelp'` is the backfill. Every row already in the table came from
-- the Yelp scraper, so the default is not a placeholder to be corrected later —
-- it is the true value for all of them, and Postgres applies it to existing
-- rows without rewriting the table (a non-volatile default is stored in the
-- catalogue since PG 11).
--
-- It also stays the default for *new* rows on purpose: the Yelp scraper is
-- deployed and pushing today, and it does not send a source column. A NOT NULL
-- column with no default would have broken that push the moment this migration
-- landed. `parseLeadsCsv` names the same fallback, so the two agree.
ALTER TABLE "leads" ADD COLUMN "source" "lead_source" NOT NULL DEFAULT 'yelp';

-- The filter rail offers Source beside Status, and the panel shows a count per
-- source, so this column is both a `WHERE` and a `GROUP BY` on every worklist
-- page. Two distinct values makes it a low-cardinality index — worth having for
-- the grouped count, and Postgres is free to ignore it for a filter that
-- matches half the table.
CREATE INDEX "leads_source_idx" ON "leads"("source");
