-- Edge Case #6: Session reminder tracking
-- Add field to track when session reminder was sent to both user and therapist
ALTER TABLE "appointment_requests" ADD COLUMN "reminder_sent_at" TIMESTAMP(3);

-- Edge Case #7: Auto-escalation tracking
-- Add field to track when conversation was auto-escalated to human control
ALTER TABLE "appointment_requests" ADD COLUMN "auto_escalated_at" TIMESTAMP(3);

-- Index for efficient reminder queries
-- Used by post-booking service to find appointments needing reminders
CREATE INDEX "appointment_requests_status_reminder_sent_at_confirmed_date_idx"
ON "appointment_requests"("status", "reminder_sent_at", "confirmed_date_time_parsed");
