-- A reset code can now be requested by the person who needs it, from the
-- sign-in screen, in which case it is emailed rather than read out by an
-- administrator and there is no issuer to record.
--
-- Nullable rather than "the subject issued it to themselves": storing the user
-- twice would make `issued_by_user_id` unable to answer the only question it
-- exists to answer — which administrator did this. NULL says "nobody did; they
-- asked for it".
ALTER TABLE "password_resets" ALTER COLUMN "issued_by_user_id" DROP NOT NULL;
