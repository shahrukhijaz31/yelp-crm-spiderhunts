-- Where a lead stands on the messaging thread.
--
-- The portal has been able to *send* a message since the WhatsApp button
-- landed, and has never been able to record that one was sent: an agent who
-- texted a lead on Monday had nowhere to say so, so on Thursday the next agent
-- either texted them again or rang a lead who had already replied elsewhere.
-- `status` could not carry it — a lead is very often both rung and messaged,
-- and one column can only hold one of those answers.
--
-- A second enum rather than more values on `call_status`, for two reasons. The
-- obvious one is that the two are independent and must both be answerable at
-- once. The quieter one is that `call_status` is load-bearing: `first_called_at`
-- and every per-agent figure in the reports are defined against "a called
-- status", and adding "SMS sent" to that list would silently promote a messaged
-- lead out of the New queue and count it as a call somebody made.
-- Three values, and only three: nothing sent, and the two channels the
-- workspace can actually send from. This column records what *we* did, not what
-- came back — a reply is a conversation, and it belongs in the notes and in the
-- call status it leads to. New values can be appended later with a one-line
-- `ALTER TYPE ... ADD VALUE`, so keeping the set small now costs nothing.
CREATE TYPE "message_status" AS ENUM ('not_messaged', 'sms_sent', 'whatsapp_sent');

-- `DEFAULT 'not_messaged'` is the backfill, and it is the true value for every
-- existing row rather than a placeholder: nothing has ever written this field,
-- so no lead in the table has a recorded message. A non-volatile default is
-- stored in the catalogue (PG 11+), so this does not rewrite the table.
ALTER TABLE "leads"
  ADD COLUMN "message_status" "message_status" NOT NULL DEFAULT 'not_messaged';

-- No index. Unlike `status` and `source`, nothing filters, groups or counts by
-- this column yet — it is read one lead at a time in the workspace, off the
-- primary key. An index here would be paid for on every import and every save
-- to serve a query that does not exist; the filter rail can add one when it
-- grows a Message group.
