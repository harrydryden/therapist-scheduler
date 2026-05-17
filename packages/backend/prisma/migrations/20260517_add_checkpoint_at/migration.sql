-- Denormalise `conversation_state.checkpoint.checkpoint_at` into a top-
-- level column so the chase candidate query (and any other hot-path
-- consumer) can read just one timestamp instead of pulling the full
-- conversation_state JSON blob (potentially 500KB per row × batch size
-- per stale-check tick).
--
-- Same pattern as FIX #21 (message_count, checkpoint_stage) — the JSON
-- remains the source of truth; this column is a denormalised mirror
-- maintained by the same writers (storeConversationState +
-- applyCheckpointUpdate) that update checkpoint_stage.

ALTER TABLE "appointment_requests"
  ADD COLUMN "checkpoint_at" TIMESTAMP(3);

-- Backfill from the JSON for existing rows. Mirrors the checkpoint_stage
-- backfill in 20260218_add_message_count_checkpoint_stage. Rows without
-- a checkpoint (legacy pre-instrumentation rows, freshly-created
-- admin-flow rows that haven't run the agent yet) stay NULL — the
-- chase service treats NULL as "no cutoff" and falls back to the old
-- "any inbound reply blocks" safety-first behaviour (see
-- chase-email.service.ts pre-send check).
UPDATE "appointment_requests"
SET "checkpoint_at" = ("conversation_state"::jsonb -> 'checkpoint' ->> 'checkpoint_at')::timestamp
WHERE "conversation_state" IS NOT NULL
  AND ("conversation_state"::jsonb -> 'checkpoint' ->> 'checkpoint_at') IS NOT NULL;
