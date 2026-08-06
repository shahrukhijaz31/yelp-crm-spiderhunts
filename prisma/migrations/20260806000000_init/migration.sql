-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('not_called', 'no_answer', 'voicemail', 'interested', 'not_interested', 'do_not_call', 'bad_number');

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phone" TEXT,
    "website" TEXT,
    "rating" DOUBLE PRECISION,
    "owner" TEXT,
    "url" TEXT,
    "status" "call_status" NOT NULL DEFAULT 'not_called',
    "notes" TEXT NOT NULL DEFAULT '',
    "callback_date" DATE,
    "meeting_time" TEXT,
    "meeting_attendees" TEXT,
    "meeting_notes" TEXT NOT NULL DEFAULT '',
    "meeting_completed_at" DATE,
    "is_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "source_batch" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_callback_date_idx" ON "leads"("callback_date");

-- CreateIndex
CREATE INDEX "leads_source_batch_idx" ON "leads"("source_batch");

-- CreateIndex
CREATE INDEX "leads_is_duplicate_idx" ON "leads"("is_duplicate");

