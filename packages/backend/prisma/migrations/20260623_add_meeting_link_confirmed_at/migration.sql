-- Records positive evidence that a real meeting link exists for a booking
-- (stamped when an inbound therapist email actually contains a meeting URL).
-- The appointment-lifecycle tick uses it to distinguish a verified
-- confirmed->session_held transition from one driven purely by the clock,
-- so the system stops silently asserting that unverified sessions were held.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) per docs/SCHEMA_MIGRATIONS.md.
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "meeting_link_confirmed_at" TIMESTAMP(3);
