-- CreateTable
CREATE TABLE "screenshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_session_id" TEXT NOT NULL,
    "monitor_device_id" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "file_size" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "display_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screenshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "screenshots_storage_key_key" ON "screenshots"("storage_key");

-- CreateIndex
CREATE INDEX "screenshots_user_id_captured_at_idx" ON "screenshots"("user_id", "captured_at");

-- CreateIndex
CREATE INDEX "screenshots_work_session_id_captured_at_idx" ON "screenshots"("work_session_id", "captured_at");

-- CreateIndex
CREATE INDEX "screenshots_captured_at_idx" ON "screenshots"("captured_at");

-- AddForeignKey
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_work_session_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "work_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_monitor_device_id_fkey" FOREIGN KEY ("monitor_device_id") REFERENCES "monitor_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
