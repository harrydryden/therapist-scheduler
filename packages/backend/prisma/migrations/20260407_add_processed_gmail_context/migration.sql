-- Track why each Gmail message was marked processed. Before this, the
-- dedup table was a bare (id, processedAt) pair and the reason was only
-- in logs. Distinguishing "successfully processed" from
-- "divergence-blocked-abandoned" from "processing-failed-abandoned"
-- requires querying the DB, not grepping logs.
ALTER TABLE "processed_gmail_messages"
  ADD COLUMN IF NOT EXISTS "context" TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS "processed_gmail_messages_context_idx"
  ON "processed_gmail_messages"("context");
