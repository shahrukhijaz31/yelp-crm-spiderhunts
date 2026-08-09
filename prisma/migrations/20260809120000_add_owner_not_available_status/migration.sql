-- AlterEnum
--
-- `AFTER 'voicemail'` rather than appended: an enum's declaration order is what
-- Postgres sorts it by, and this outcome belongs with the other "reached
-- nobody who can say yes" ones. It matches the position in schema.prisma and
-- in CALL_STATUSES (lib/types.ts).
--
-- Adding a value is additive and takes no lock on the leads table, so no
-- existing row changes and nothing has to be backfilled.
ALTER TYPE "call_status" ADD VALUE 'owner_not_available' AFTER 'voicemail';
