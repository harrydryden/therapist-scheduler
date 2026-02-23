-- Add missing index on initial_message_id for email matching (Priority 2 query)
-- This field is used in findMatchingAppointmentRequest to match emails by
-- In-Reply-To/References headers against the appointment's initial message ID.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointment_requests_initial_message_id_idx"
  ON "appointment_requests" ("initial_message_id");
