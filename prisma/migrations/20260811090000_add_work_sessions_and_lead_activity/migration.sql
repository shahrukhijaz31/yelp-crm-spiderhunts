-- Agent performance tracking: who worked which lead, and when they were here.
--
-- Two tables, no changes to any existing one. Nothing in the schema recorded
-- *who* did anything to a lead — `leads` holds the outcome and overwrites it in
-- place — so per-agent reporting was not derivable from the tables that already
-- existed, at any price. These are the minimum structures that make it real
-- rather than estimated.

-- CreateEnum
--
-- Four acts, not "every field that changed". Each one is a decision an agent
-- made and a number somebody asks for at the end of a day. Declaration order is
-- the enum's sort order in Postgres and must match `LeadActivityKind` in
-- schema.prisma exactly, or a later `prisma migrate diff` sees a change that is
-- not one.
CREATE TYPE "lead_activity_kind" AS ENUM (
  'call_logged',
  'callback_scheduled',
  'meeting_booked',
  'meeting_completed'
);

-- CreateTable
--
-- Append-only. The application never updates or deletes a row here: a lead
-- worked on Monday and again on Friday is two facts, and a column on `leads`
-- could only ever hold the second one.
--
-- `status` is a copy of the outcome *as saved*, deliberately. `leads.status` is
-- where the lead stands now and moves whenever anyone edits it; if reports read
-- that instead, last week's numbers would quietly rewrite themselves every time
-- somebody corrected a mis-click today.
CREATE TABLE "lead_activities" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "lead_activity_kind" NOT NULL,
    "status" "call_status",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- A shift, not a browser. `sessions` is one row per cookie and is deleted at
-- logout; this is one open row per *user* however many tabs they have, and it
-- is kept afterwards because the whole point is to still have it at the end of
-- the month.
--
-- `ended_at IS NULL` is the only definition of "still working". `last_seen_at`
-- is the browser's heartbeat, and it is what bounds a session whose browser
-- died: reconciliation closes it at the last heartbeat rather than at the
-- moment somebody noticed, so a closed laptop costs minutes and never runs a
-- clock forever.
CREATE TABLE "work_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "ended_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- Every report is "this agent over this window" or "everyone over this window",
-- so the composite leads with the agent and the plain one on the clock serves
-- the team roll-up. The third supports counting *distinct leads worked*, which
-- is a different question from counting calls.
CREATE INDEX "lead_activities_user_id_created_at_idx" ON "lead_activities"("user_id", "created_at");
CREATE INDEX "lead_activities_created_at_idx" ON "lead_activities"("created_at");
CREATE INDEX "lead_activities_lead_id_created_at_idx" ON "lead_activities"("lead_id", "created_at");

-- CreateIndex
--
-- "The open session for this user" runs on every page load, so it gets the
-- composite that ends on the nullable column; the other two serve the reports'
-- range scans.
CREATE INDEX "work_sessions_user_id_ended_at_idx" ON "work_sessions"("user_id", "ended_at");
CREATE INDEX "work_sessions_user_id_started_at_idx" ON "work_sessions"("user_id", "started_at");
CREATE INDEX "work_sessions_started_at_idx" ON "work_sessions"("started_at");

-- AddForeignKey
--
-- Leads cascade: activity against a lead that is gone cannot be shown, filtered
-- or explained. Users restrict, matching `meeting_recordings` and
-- `password_resets` — accounts here are disabled rather than deleted, and a
-- delete that silently took a month of somebody's performance record with it
-- would be precisely the wrong default for a table whose only job is
-- attribution.
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--
-- Cascade here, unlike the activity log: a deleted account's shifts have nobody
-- left to report them for.
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
