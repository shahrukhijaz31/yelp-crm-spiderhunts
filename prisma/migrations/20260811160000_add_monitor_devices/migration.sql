-- CreateTable
CREATE TABLE "monitor_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token_hash" TEXT,
    "access_expires_at" TIMESTAMP(3),
    "refresh_token_hash" TEXT NOT NULL,
    "refresh_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "device_name" TEXT,
    "platform" TEXT,
    "app_version" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monitor_devices_access_token_hash_key" ON "monitor_devices"("access_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_devices_refresh_token_hash_key" ON "monitor_devices"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "monitor_devices_user_id_idx" ON "monitor_devices"("user_id");

-- CreateIndex
CREATE INDEX "monitor_devices_refresh_expires_at_idx" ON "monitor_devices"("refresh_expires_at");

-- AddForeignKey
ALTER TABLE "monitor_devices" ADD CONSTRAINT "monitor_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
