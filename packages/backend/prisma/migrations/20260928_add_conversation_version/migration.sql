-- Dedicated optimistic-lock counters for conversation state.
--
-- Conversation-state writers used `updated_at` as their CAS token
-- (`UPDATE … WHERE id = $1 AND updated_at = $expected`). But
-- `@updatedAt` is bumped by EVERY write to the row, including the
-- agent's own mid-turn tool writes (the dispatch human-control gate's
-- last_tool_executed_at, send.ts's outbound stamps, lifecycle
-- transitions, and on therapist_conversations the tool executor's gate /
-- Gmail thread-id stamp / mark_complete / flag writes). The end-of-turn
-- state save therefore lost its own race on nearly every tool-using turn
-- and the turn's state (assistant text, checkpoint advance, facts,
-- response tracking) was dropped. The new counter is touched only by
-- writes that change conversation_state, so it detects genuine
-- concurrent conversation writers without tripping over unrelated
-- column writes.
--
-- Existing rows start at 0; writers CAS on the value they read, so no
-- backfill is needed. Idempotent (ADD COLUMN IF NOT EXISTS) per
-- docs/SCHEMA_MIGRATIONS.md.

ALTER TABLE "appointment_requests"
  ADD COLUMN IF NOT EXISTS "conversation_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "therapist_conversations"
  ADD COLUMN IF NOT EXISTS "conversation_version" INTEGER NOT NULL DEFAULT 0;
