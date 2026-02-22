-- Add partial unique index to prevent duplicate active appointments
-- between the same user and therapist pair.
--
-- This allows:
-- - Multiple CANCELLED appointments between same user/therapist
-- - Multiple CONFIRMED appointments (e.g., rescheduled sessions)
-- - One PENDING/CONTACTED/NEGOTIATING appointment at a time
--
-- A user CAN book with multiple DIFFERENT therapists simultaneously.

-- Create partial unique index for active (non-cancelled, non-confirmed) appointments
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_requests_user_therapist_active_unique"
ON "appointment_requests" ("user_email", "therapist_notion_id")
WHERE "status" IN ('pending', 'contacted', 'negotiating');

-- Add comment explaining the constraint
COMMENT ON INDEX "appointment_requests_user_therapist_active_unique" IS
  'Prevents duplicate active appointment requests between the same user and therapist. Users can book with multiple different therapists simultaneously.';
