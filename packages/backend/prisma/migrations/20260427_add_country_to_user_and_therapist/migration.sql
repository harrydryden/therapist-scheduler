-- Add country column to users and therapists.
-- Existing rows are backfilled with 'UK' to match the historical UK-only deployment.
-- The DEFAULT 'UK' on the column means new rows also default to UK if no country is supplied.

ALTER TABLE "users" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'UK';
ALTER TABLE "therapists" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'UK';
