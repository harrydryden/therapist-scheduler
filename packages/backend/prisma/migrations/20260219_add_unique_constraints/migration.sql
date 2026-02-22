-- Add unique constraint to Therapist.email
-- This prevents duplicate therapist emails which could cause routing errors
CREATE UNIQUE INDEX IF NOT EXISTS "therapists_email_key" ON "therapists"("email");

-- Remove the now-redundant non-unique index on email (replaced by unique index)
DROP INDEX IF EXISTS "therapists_email_idx";

-- Add unique constraint to AppointmentRequest.idempotencyKey
-- This enforces idempotency at the database level to prevent duplicate appointments
-- NULL values are allowed (not all appointments have idempotency keys)
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_requests_idempotency_key_key" ON "appointment_requests"("idempotency_key");

-- Add unique constraint to prevent duplicate feedback per appointment
-- Only one feedback submission per appointment request (NULL appointment_request_id excluded)
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_submissions_appointment_request_id_key"
  ON "feedback_submissions"("appointment_request_id")
  WHERE "appointment_request_id" IS NOT NULL;
