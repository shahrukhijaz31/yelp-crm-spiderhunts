-- Office or remote, for contributors: the office address list, the stretches
-- of each shift tagged with where they were worked, and a contributor's own
-- correction. Additive only — nothing existing reads or changes shape.

-- CreateEnum
CREATE TYPE "work_location" AS ENUM ('office', 'remote');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "location_override" "work_location",
ADD COLUMN     "location_override_basis" "work_location";

-- CreateTable
CREATE TABLE "office_networks" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "office_networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_location_segments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_session_id" TEXT NOT NULL,
    "location" "work_location" NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_location_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "office_networks_ip_key" ON "office_networks"("ip");

-- CreateIndex
CREATE INDEX "work_location_segments_work_session_id_started_at_idx" ON "work_location_segments"("work_session_id", "started_at");

-- CreateIndex
CREATE INDEX "work_location_segments_user_id_started_at_idx" ON "work_location_segments"("user_id", "started_at");

-- AddForeignKey
ALTER TABLE "office_networks" ADD CONSTRAINT "office_networks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_location_segments" ADD CONSTRAINT "work_location_segments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_location_segments" ADD CONSTRAINT "work_location_segments_work_session_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "work_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The office line, so detection works from the first deploy. Further
-- addresses are added on the Settings page.
INSERT INTO "office_networks" ("id", "ip", "label")
VALUES (gen_random_uuid()::text, '39.60.232.90', 'Office')
ON CONFLICT ("ip") DO NOTHING;
