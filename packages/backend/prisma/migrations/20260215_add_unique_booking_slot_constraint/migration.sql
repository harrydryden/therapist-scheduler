-- Add unique constraint to prevent double-booking same therapist + time slot
-- This prevents two users from booking the same therapist at the exact same time
--
-- The constraint only applies to active bookings (not cancelled/rejected)
-- This is a critical race condition fix - ensures database-level atomicity

-- Create partial unique index for same therapist + date + time
-- Only one active booking can exist per (therapist, date, time) combination
CREATE UNIQUE INDEX IF NOT EXISTS "idx_unique_booking_slot"
ON "appointment_requests" ("therapist_notion_id", "confirmed_date_time")
WHERE "status" NOT IN ('cancelled', 'rejected', 'completed')
  AND "confirmed_date_time" IS NOT NULL;

-- Add comment explaining the constraint
COMMENT ON INDEX "idx_unique_booking_slot" IS
  'Prevents double-booking: only one active appointment per therapist at any given date/time. Race condition protection.';

-- Add index for common query patterns (performance optimization)
CREATE INDEX IF NOT EXISTS "idx_appointments_status_therapist_datetime"
ON "appointment_requests" ("status", "therapist_notion_id", "confirmed_date_time_parsed")
WHERE "confirmed_date_time_parsed" IS NOT NULL;

-- Add index for admin dashboard queries
CREATE INDEX IF NOT EXISTS "idx_appointments_needs_attention"
ON "appointment_requests" ("status", "is_stale", "human_control_enabled", "updated_at")
WHERE "status" IN ('pending', 'contacted', 'negotiating');

-- Add index for idempotency key lookups (will be used after schema update)
-- This index helps with fast duplicate detection
CREATE INDEX IF NOT EXISTS "idx_appointments_idempotency"
ON "appointment_requests" ("user_email", "therapist_notion_id", "created_at" DESC)
WHERE "status" NOT IN ('cancelled', 'completed');
