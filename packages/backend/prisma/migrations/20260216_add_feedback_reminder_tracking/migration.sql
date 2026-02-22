-- Add feedback reminder tracking field
ALTER TABLE "appointment_requests" ADD COLUMN "feedback_reminder_sent_at" TIMESTAMP(3);
