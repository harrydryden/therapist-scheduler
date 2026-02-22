-- Add new feedback form columns for restructured questions
ALTER TABLE "feedback_submissions" ADD COLUMN "understood_score" INTEGER;
ALTER TABLE "feedback_submissions" ADD COLUMN "session_benefits" TEXT;
ALTER TABLE "feedback_submissions" ADD COLUMN "improvement_suggestions" TEXT;
ALTER TABLE "feedback_submissions" ADD COLUMN "would_book_again_text" TEXT;
ALTER TABLE "feedback_submissions" ADD COLUMN "would_recommend" TEXT;
ALTER TABLE "feedback_submissions" ADD COLUMN "would_recommend_text" TEXT;
ALTER TABLE "feedback_submissions" ADD COLUMN "additional_comments" TEXT;
