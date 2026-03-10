-- Add ingested_at column to track when therapists were added to the platform
ALTER TABLE "therapists" ADD COLUMN IF NOT EXISTS "ingested_at" TIMESTAMP(3);

-- Backfill existing therapists: set ingested_at to now for pre-existing records
UPDATE "therapists" SET "ingested_at" = NOW() WHERE "ingested_at" IS NULL;
