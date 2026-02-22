-- CreateTable
CREATE TABLE "feedback_form_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "form_name" TEXT NOT NULL DEFAULT 'Therapy Interview Feedback',
    "description" TEXT,
    "welcome_title" TEXT NOT NULL DEFAULT 'Session Feedback',
    "welcome_message" TEXT NOT NULL DEFAULT 'Please take a moment to share your feedback about your therapy session.',
    "thank_you_title" TEXT NOT NULL DEFAULT 'Thank you!',
    "thank_you_message" TEXT NOT NULL DEFAULT 'Thanks for sharing your feedback - we really appreciate it.',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "requires_auth" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_form_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_submissions" (
    "id" TEXT NOT NULL,
    "tracking_code" TEXT,
    "appointment_request_id" TEXT,
    "user_email" TEXT,
    "user_name" TEXT,
    "therapist_name" TEXT NOT NULL,
    "responses" JSONB NOT NULL,
    "safety_score" INTEGER,
    "listened_to_score" INTEGER,
    "professional_score" INTEGER,
    "would_book_again" TEXT,
    "synced_to_notion" BOOLEAN NOT NULL DEFAULT false,
    "notion_page_id" TEXT,
    "synced_at" TIMESTAMP(3),
    "sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_submissions_tracking_code_idx" ON "feedback_submissions"("tracking_code");

-- CreateIndex
CREATE INDEX "feedback_submissions_appointment_request_id_idx" ON "feedback_submissions"("appointment_request_id");

-- CreateIndex
CREATE INDEX "feedback_submissions_user_email_idx" ON "feedback_submissions"("user_email");

-- CreateIndex
CREATE INDEX "feedback_submissions_therapist_name_idx" ON "feedback_submissions"("therapist_name");

-- CreateIndex
CREATE INDEX "feedback_submissions_synced_to_notion_idx" ON "feedback_submissions"("synced_to_notion");

-- CreateIndex
CREATE INDEX "feedback_submissions_created_at_idx" ON "feedback_submissions"("created_at");

-- AddForeignKey
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_appointment_request_id_fkey" FOREIGN KEY ("appointment_request_id") REFERENCES "appointment_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Insert default form configuration with standard questions
INSERT INTO "feedback_form_config" ("id", "form_name", "description", "welcome_title", "welcome_message", "thank_you_title", "thank_you_message", "questions", "is_active", "requires_auth", "created_at", "updated_at")
VALUES (
    'default',
    'Therapy Interview Feedback',
    'Post-session feedback form sent to clients after their therapy session.',
    'Session Feedback',
    'Please take a moment to share your feedback about your therapy session. Your responses help us ensure the quality of care.',
    'Thank you!',
    'Thanks for sharing your feedback - we really appreciate it.',
    '[
        {
            "id": "therapist_confirmation",
            "type": "text",
            "question": "Please confirm the name of the therapist you had a session with",
            "required": true,
            "prefilled": true
        },
        {
            "id": "safety_comfort",
            "type": "scale",
            "question": "How safe and comfortable did you feel with this therapist?",
            "required": true,
            "scaleMin": 0,
            "scaleMax": 5,
            "scaleMinLabel": "Not at all",
            "scaleMaxLabel": "Very"
        },
        {
            "id": "listened_to",
            "type": "scale",
            "question": "Did you feel listened to?",
            "required": true,
            "scaleMin": 0,
            "scaleMax": 5,
            "scaleMinLabel": "Not at all",
            "scaleMaxLabel": "Very"
        },
        {
            "id": "professional",
            "type": "scale",
            "question": "Did the session feel professionally conducted?",
            "required": true,
            "scaleMin": 0,
            "scaleMax": 5,
            "scaleMinLabel": "Not at all",
            "scaleMaxLabel": "Very"
        },
        {
            "id": "would_book_again",
            "type": "choice",
            "question": "Would you book another session with this therapist?",
            "required": true,
            "options": ["Yes", "Maybe", "No"]
        }
    ]'::jsonb,
    true,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
