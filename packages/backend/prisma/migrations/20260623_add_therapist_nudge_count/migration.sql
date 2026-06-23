-- Bounds the therapist "still looking for a client" nudge loop.
-- Previously only last_nudge_at was tracked, so a never-matched
-- therapist was re-nudged on the configured cadence indefinitely.
-- The nudge service now skips therapists at THERAPIST_NUDGE.MAX_NUDGES
-- and escalates to an admin once instead.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so it is safe to apply even if
-- the column was hotfixed onto production manually. See
-- docs/SCHEMA_MIGRATIONS.md.
ALTER TABLE "therapists" ADD COLUMN IF NOT EXISTS "nudge_count" INTEGER NOT NULL DEFAULT 0;
