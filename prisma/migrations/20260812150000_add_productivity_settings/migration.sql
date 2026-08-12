-- The targets and weights the agent productivity score is calculated against.
--
-- One row, always id 'default' -- see the note on the model in schema.prisma.
-- No table of scores is created: productivity is computed on read from
-- lead_activities, work_sessions and activity_intervals, all of which already
-- carry the indexes those reads need ((user_id, created_at) and
-- (lead_id, created_at) on lead_activities, (user_id, started_at) on
-- work_sessions and activity_intervals).

-- CreateTable
CREATE TABLE "productivity_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "calls_target" INTEGER NOT NULL DEFAULT 50,
    "leads_target" INTEGER NOT NULL DEFAULT 40,
    "meetings_target" INTEGER NOT NULL DEFAULT 5,
    "follow_ups_target" INTEGER NOT NULL DEFAULT 30,
    "activity_target" INTEGER NOT NULL DEFAULT 80,
    "calls_weight" INTEGER NOT NULL DEFAULT 30,
    "leads_weight" INTEGER NOT NULL DEFAULT 25,
    "meetings_weight" INTEGER NOT NULL DEFAULT 25,
    "activity_weight" INTEGER NOT NULL DEFAULT 10,
    "follow_ups_weight" INTEGER NOT NULL DEFAULT 10,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productivity_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "productivity_settings" ADD CONSTRAINT "productivity_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
