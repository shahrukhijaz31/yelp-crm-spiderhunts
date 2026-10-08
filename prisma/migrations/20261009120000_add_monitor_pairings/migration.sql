-- Workstations waiting to be connected, so an agent already signed in to the
-- portal can authorise the Monitor from there instead of typing the same
-- password and a second emailed code into a desktop application.
--
-- Starts empty, and stays nearly empty: rows live five minutes and are swept an
-- hour after they expire. Nothing to backfill — there is no record of past
-- sign-ins that could be turned into a pairing, and none would be wanted.
--
-- `user_id` is nullable on purpose rather than as a concession to existing
-- rows: a pairing names nobody until an authenticated human approves it, which
-- is what lets the start endpoint take no username at all.
CREATE TABLE "monitor_pairings" (
    "id" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "device_code_hash" TEXT NOT NULL,
    "start_ip" TEXT,
    "user_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "denied_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "device_name" TEXT,
    "platform" TEXT,
    "app_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_pairings_pkey" PRIMARY KEY ("id")
);

-- Both lookups this table has are by a unique secret: the browser arrives with
-- the public id, the workstation polls with its device code. Unique rather than
-- merely indexed because a duplicate in either column would mean one credential
-- resolving to two pairings.
CREATE UNIQUE INDEX "monitor_pairings_public_id_key" ON "monitor_pairings"("public_id");

CREATE UNIQUE INDEX "monitor_pairings_device_code_hash_key" ON "monitor_pairings"("device_code_hash");

-- The sweep, which is the only query that ranges rather than points.
CREATE INDEX "monitor_pairings_expires_at_idx" ON "monitor_pairings"("expires_at");

-- Cascade, matching `monitor_devices`: an approval belonging to a deleted
-- account can connect nothing and must not outlive them.
ALTER TABLE "monitor_pairings"
  ADD CONSTRAINT "monitor_pairings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
