-- Track per-message post-match processing failures.
-- Database is the source of truth so the missed-message scanner can correctly
-- abandon broken messages even when Redis is unavailable. The previous Redis-only
-- counter returned 1 on every Redis failure, so the 3-attempt abandonment
-- threshold was never reached and the scanner looped forever.
CREATE TABLE IF NOT EXISTS "message_processing_failures" (
  "id" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "last_error" TEXT NOT NULL,
  "first_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "abandoned" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "message_processing_failures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "message_processing_failures_abandoned_idx"
  ON "message_processing_failures"("abandoned");

CREATE INDEX IF NOT EXISTS "message_processing_failures_last_failed_at_idx"
  ON "message_processing_failures"("last_failed_at");

CREATE INDEX IF NOT EXISTS "message_processing_failures_abandoned_last_failed_at_idx"
  ON "message_processing_failures"("abandoned", "last_failed_at");
