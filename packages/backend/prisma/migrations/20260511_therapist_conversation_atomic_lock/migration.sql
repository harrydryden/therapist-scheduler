-- Atomic-lock anchor for the availability-collection agent's tool executor.
--
-- Phase 2 shipped a non-atomic human-control check (read-then-act) because
-- no tool had irreversible side effects yet — every tool wrote to a JSON
-- column. Phase 3 adds `send_email` to the tool surface, which DOES have
-- an irreversible side effect (outbound mail), so the read-then-act gap
-- is no longer benign. This column gives the executor a data field for
-- the atomic `updateMany` with `humanControlEnabled: false + status:
-- 'active'` predicate — same pattern that ai-tool-executor.service.ts
-- uses against appointment_requests.last_tool_executed_at.
--
-- Safety: pure ALTER TABLE ADD COLUMN, NULL default. No data touched.
-- Safe online.

ALTER TABLE "therapist_conversations"
  ADD COLUMN "last_tool_executed_at" TIMESTAMP(3);
