-- Target-based availability model (see docs/THERAPIST_TARGET_AVAILABILITY.md).
--
-- A therapist's public-site availability is now derived from how many
-- distinct clients they have completed a session with, relative to a
-- per-therapist target. This column stores that target.

-- Add the column. Default 2 matches the config default for NEW therapists,
-- and (per the cutover decision) is also the value ACTIVE existing therapists
-- keep, so they are NOT removed from the finder at ship time unless they have
-- already completed 2+ distinct clients.
ALTER TABLE "therapists"
  ADD COLUMN IF NOT EXISTS "target_appointments" INTEGER NOT NULL DEFAULT 2;

-- Backfill decision (cutover): ARCHIVED therapists (active = false) get target
-- 1; ACTIVE therapists keep the column default of 2 (the "new" target).
-- Keying the backfill on `active` — rather than on the column value — is
-- deliberate: it is unambiguous and re-run-safe (archived rows are idempotently
-- set to 1 and active rows are never touched), unlike a value-based guard which
-- cannot distinguish a defaulted 2 from a deliberate 2. Archived therapists are
-- hidden from the finder regardless, so their target only matters if they are
-- later un-archived.
UPDATE "therapists"
  SET "target_appointments" = 1
  WHERE "active" = false;
