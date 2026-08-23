-- A second demo link, and comments about the demo.
--
-- Both are additive, nullable columns on `demo_websites`. Nothing is
-- backfilled and nothing is rewritten: `demo_url` keeps every link already
-- saved and is now labelled "Demo link 1" on screen, `demo_url_2` starts NULL
-- everywhere, and a lead with neither still has no row here at all.
--
-- Two columns rather than one array, because the two links are labelled and
-- not ordered — the UI has a field for each, and every query that asks "has a
-- link" ORs the two nullable columns, which is an expression Postgres can
-- evaluate without unnesting anything.
--
-- `demo_comments` is text about the demo, not about the call. It is emphatically
-- NOT a copy of `leads.notes`: that column stays where it is, is written by the
-- workspace's Save bar under either module, and is untouched here. This one is
-- written only through the demo PATCH, which requires the Demo Websites module.
ALTER TABLE "demo_websites" ADD COLUMN "demo_url_2" TEXT,
ADD COLUMN "demo_comments" TEXT;
