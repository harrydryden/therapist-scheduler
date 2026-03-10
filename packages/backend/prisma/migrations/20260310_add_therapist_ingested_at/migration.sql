-- Add ingested_at column to track when therapists were added to the platform
ALTER TABLE "therapists" ADD COLUMN IF NOT EXISTS "ingested_at" TIMESTAMP(3);
