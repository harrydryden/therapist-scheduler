-- FIX #21: Add denormalized columns for message count and checkpoint stage
-- to avoid loading the full conversation_state blob (up to 500KB) in list queries.

ALTER TABLE "appointment_requests" ADD COLUMN "message_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "appointment_requests" ADD COLUMN "checkpoint_stage" TEXT;

-- Backfill message_count from conversation_state JSON
-- This counts the number of elements in the "messages" array within the JSON blob
UPDATE "appointment_requests"
SET "message_count" = COALESCE(
  jsonb_array_length(
    CASE
      WHEN conversation_state IS NOT NULL
        AND (conversation_state::jsonb ->> 'messages') IS NOT NULL
      THEN conversation_state::jsonb -> 'messages'
      ELSE '[]'::jsonb
    END
  ),
  0
);

-- Backfill checkpoint_stage from conversation_state JSON
UPDATE "appointment_requests"
SET "checkpoint_stage" = (conversation_state::jsonb -> 'checkpoint' ->> 'stage')
WHERE conversation_state IS NOT NULL
  AND (conversation_state::jsonb -> 'checkpoint' ->> 'stage') IS NOT NULL;
