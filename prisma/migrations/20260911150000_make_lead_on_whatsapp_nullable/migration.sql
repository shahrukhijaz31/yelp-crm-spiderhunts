-- `on_whatsapp` becomes a Yes / No / not-yet-checked answer.
--
-- As a checkbox it had only two states, so "unticked" had to mean both "nobody
-- has looked" and "looked, and the number is not on WhatsApp" — an agent could
-- not record the second at all. NULL now means not checked, and false means an
-- agent confirmed the number has no account.
--
-- Every existing false is a "not checked": the checkbox offered no way to say
-- no, so none of those rows is a confirmed answer. Rows ticked true keep it.
ALTER TABLE "leads"
  ALTER COLUMN "on_whatsapp" DROP NOT NULL,
  ALTER COLUMN "on_whatsapp" DROP DEFAULT;

UPDATE "leads" SET "on_whatsapp" = NULL WHERE "on_whatsapp" = false;
