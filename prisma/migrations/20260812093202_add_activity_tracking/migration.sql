-- CreateTable
CREATE TABLE "activity_intervals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_session_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "keyboard_activity_count" INTEGER NOT NULL,
    "mouse_activity_count" INTEGER NOT NULL,
    "activity_percentage" INTEGER NOT NULL,
    "client_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_adjustments" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_session_id" TEXT NOT NULL,
    "previous_started_at" TIMESTAMP(3) NOT NULL,
    "previous_ended_at" TIMESTAMP(3),
    "previous_duration_seconds" INTEGER,
    "new_started_at" TIMESTAMP(3) NOT NULL,
    "new_ended_at" TIMESTAMP(3),
    "new_duration_seconds" INTEGER,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_intervals_user_id_started_at_idx" ON "activity_intervals"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "activity_intervals_work_session_id_started_at_idx" ON "activity_intervals"("work_session_id", "started_at");

-- CreateIndex
CREATE INDEX "activity_intervals_started_at_idx" ON "activity_intervals"("started_at");

-- CreateIndex
CREATE INDEX "activity_intervals_created_at_idx" ON "activity_intervals"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "activity_intervals_work_session_id_client_key_key" ON "activity_intervals"("work_session_id", "client_key");

-- CreateIndex
CREATE INDEX "time_adjustments_user_id_created_at_idx" ON "time_adjustments"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "time_adjustments_work_session_id_idx" ON "time_adjustments"("work_session_id");

-- CreateIndex
CREATE INDEX "time_adjustments_admin_user_id_created_at_idx" ON "time_adjustments"("admin_user_id", "created_at");

-- CreateIndex
CREATE INDEX "time_adjustments_created_at_idx" ON "time_adjustments"("created_at");

-- AddForeignKey
ALTER TABLE "activity_intervals" ADD CONSTRAINT "activity_intervals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_intervals" ADD CONSTRAINT "activity_intervals_work_session_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "work_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_work_session_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "work_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
