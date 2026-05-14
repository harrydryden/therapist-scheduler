-- Phase 3a — Extract conversationState + memory from appointment_requests
-- into a sibling appointment_conversations table.
--
-- This migration is EXPAND-ONLY. The legacy columns on
-- appointment_requests are NOT dropped or modified. After this
-- deploys, every writer dual-writes to both tables; reads still
-- come from appointment_requests. The cutover (switch reads to
-- the new table) and contract (drop legacy columns) happen in
-- follow-up PRs after a production validation window.
--
-- Safety:
--   - Additive only. No locks on appointment_requests.
--   - PK is the appointment id, FK ON DELETE CASCADE — no orphaned
--     rows possible.
--   - No backfill in this migration — the backfill script lives at
--     src/scripts/backfill-appointment-conversation.ts so it can be
--     re-run idempotently after the migration deploys.

CREATE TABLE "appointment_conversations" (
  "appointment_id"     TEXT NOT NULL,
  "conversation_state" JSONB,
  "memory"             JSONB,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "appointment_conversations_pkey" PRIMARY KEY ("appointment_id")
);

-- FK with cascade delete: removing an appointment removes its
-- conversation row automatically. The FK is also the PK, so the
-- relation is unambiguous and 1:1 at the schema level.
ALTER TABLE "appointment_conversations"
  ADD CONSTRAINT "appointment_conversations_appointment_id_fkey"
  FOREIGN KEY ("appointment_id") REFERENCES "appointment_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
