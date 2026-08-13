-- Foreground application usage, reported by the SpiderHunts Monitor.
--
-- One new table and nothing else: no existing table is altered, no column is
-- added to work_sessions, screenshots or activity_intervals, and no enum moves.
-- App usage is a third data source hanging off a work session, exactly as
-- screenshots and activity intervals already are, and the existing timer,
-- screenshot pipeline and activity calculation are untouched by this migration.
--
-- Deliberately absent from the columns: window titles, URLs, document names,
-- keystrokes and mouse coordinates. See the note on the model in schema.prisma.
--
-- The indexes are the four reads the reports actually issue — one agent over a
-- window, one shift, a window across everybody, and one application across
-- everybody — plus the device, which the housekeeping sweep's SET NULL needs.
-- The unique index on client_key is the duplicate protection; it is global
-- rather than scoped to the shift so a retry can never land twice.

-- CreateTable
CREATE TABLE "app_usage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_session_id" TEXT NOT NULL,
    "monitor_device_id" TEXT,
    "process_name" TEXT NOT NULL,
    "application_name" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "client_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_usage_client_key_key" ON "app_usage"("client_key");

-- CreateIndex
CREATE INDEX "app_usage_user_id_started_at_idx" ON "app_usage"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "app_usage_work_session_id_started_at_idx" ON "app_usage"("work_session_id", "started_at");

-- CreateIndex
CREATE INDEX "app_usage_started_at_idx" ON "app_usage"("started_at");

-- CreateIndex
CREATE INDEX "app_usage_application_name_started_at_idx" ON "app_usage"("application_name", "started_at");

-- CreateIndex
CREATE INDEX "app_usage_monitor_device_id_idx" ON "app_usage"("monitor_device_id");

-- AddForeignKey
ALTER TABLE "app_usage" ADD CONSTRAINT "app_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_usage" ADD CONSTRAINT "app_usage_work_session_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "work_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_usage" ADD CONSTRAINT "app_usage_monitor_device_id_fkey" FOREIGN KEY ("monitor_device_id") REFERENCES "monitor_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
