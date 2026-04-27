-- Add a Postgres-side `availability` column on therapists.
-- This is now the source of truth — Notion's per-day rich_text columns are
-- no longer read or written. Existing Notion availability can be copied
-- across by running scripts/backfill-therapist-availability.ts after deploy.
--
-- Safety: ADD COLUMN of a nullable JSONB without a default is metadata-only
-- on PostgreSQL 11+ and safe to run online.

ALTER TABLE "therapists" ADD COLUMN "availability" JSONB;
