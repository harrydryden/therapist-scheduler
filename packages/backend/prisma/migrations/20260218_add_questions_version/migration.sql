-- Add questions_version column to track when default questions change
ALTER TABLE "feedback_form_config" ADD COLUMN "questions_version" INTEGER NOT NULL DEFAULT 0;
