-- Add country column to users and therapists.
-- Existing rows are backfilled with 'UK' to match the historical UK-only deployment.
-- The DEFAULT 'UK' on the column means new rows also default to UK if no country is supplied.
--
-- Safety note: PostgreSQL 11+ executes `ADD COLUMN ... NOT NULL DEFAULT <constant>`
-- as a metadata-only change (no full table rewrite, no exclusive lock on the data).
-- The migration is therefore safe to run online on these tables even when busy.

ALTER TABLE "users" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'UK';
ALTER TABLE "therapists" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'UK';
