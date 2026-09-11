-- Whether an agent has confirmed the lead's number has a WhatsApp account.
--
-- Ticked by hand in the lead workspace after opening the WhatsApp link, and
-- independent of `message_status`: a number can be on WhatsApp and never have
-- been messaged there.
--
-- `DEFAULT false` is the backfill, and it means "not confirmed" rather than
-- "confirmed absent" — nobody has checked any existing row. A non-volatile
-- default is stored in the catalogue (PG 11+), so this does not rewrite the
-- table.
ALTER TABLE "leads"
  ADD COLUMN "on_whatsapp" BOOLEAN NOT NULL DEFAULT false;
