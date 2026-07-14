-- Dedicated admin-freeze column for the target-availability model
-- (see docs/THERAPIST_TARGET_AVAILABILITY.md).
--
-- CRITICAL cutover-safety note: the legacy `frozen_at` column was set by the
-- retired auto-freeze on EVERY booking request, NOT only on deliberate admin
-- freezes. The new availability rule must therefore NOT read `frozen_at` as a
-- manual freeze — doing so would hide every recently-booked therapist the
-- moment this ships. Instead we add a fresh column that starts NULL for all
-- rows: at cutover nobody is spuriously frozen, therapists mid-appointment
-- stay hidden via their active appointment (not via a stale freeze), and once
-- their session completes they become live again if short of target.
--
-- We intentionally do NOT backfill `manual_freeze_at` from `frozen_at`. Any
-- therapist an admin had deliberately frozen immediately before this deploy
-- (rare) would need re-freezing via the admin UI — an acceptable trade against
-- the alternative of mass-hiding live therapists.
--
-- Idempotent so it is safe to re-run / safe against a manual prod hotfix.

ALTER TABLE "therapist_booking_status"
  ADD COLUMN IF NOT EXISTS "manual_freeze_at" TIMESTAMP(3);

-- One-time cleanup of the retired therapist-level alert signal. The old
-- inactivity flow wrote admin_alert_at and cleared it when activity resumed;
-- both writers are now no-ops, so any pre-existing unacknowledged alert would
-- otherwise linger forever on the admin dashboard with a frozen request count.
-- Clearing it here removes those phantom flags at cutover. Safe: the flag is
-- advisory only and no longer gates anything.
UPDATE "therapist_booking_status"
  SET "admin_alert_at" = NULL, "admin_alert_acknowledged" = false
  WHERE "admin_alert_at" IS NOT NULL;

