-- The whole of the screenshot upload rate limit's state: one nullable
-- timestamp per monitor device, written only from the server's clock.
--
-- Nullable with no default and no backfill on purpose. NULL means "this
-- workstation has never had a screenshot accepted", which is exactly the state
-- every existing device is in, and the limiter reads it as "allowed".
-- AlterTable
ALTER TABLE "monitor_devices" ADD COLUMN "last_screenshot_at" TIMESTAMP(3);
