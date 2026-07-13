-- Target-based availability model (see docs/THERAPIST_TARGET_AVAILABILITY.md).
--
-- A therapist's public-site availability is now derived from how many
-- distinct clients they have completed a session with, relative to a
-- per-therapist target. This column stores that target.
--
-- Idempotent (IF NOT EXISTS + guarded backfill) so it is safe to re-run and
-- safe if prod was hotfixed manually.

-- Add the column. Default 2 matches the config default for NEW therapists.
ALTER TABLE "therapists"
  ADD COLUMN IF NOT EXISTS "target_appointments" INTEGER NOT NULL DEFAULT 2;

-- Backfill: every therapist that exists at migration time is a pre-release
-- ("existing") counsellor and keeps the old single-trial expectation of 1.
-- We only touch rows still sitting at the column default (2) so re-running
-- the migration after new therapists have been created at 2 does not
-- clobber them. `updated_at` is intentionally NOT bumped — this is a
-- backfill, not a business event.
UPDATE "therapists"
  SET "target_appointments" = 1
  WHERE "target_appointments" = 2;
