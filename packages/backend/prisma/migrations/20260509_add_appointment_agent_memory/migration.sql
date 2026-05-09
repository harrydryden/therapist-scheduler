-- Add memory JSONB column on appointment_requests for the agent's
-- self-curated thread notes (Layer B in the agent memory design).
--
-- Distinct from `conversation_state.facts` (regex-extracted scheduling
-- primitives) and `conversation_state.checkpoint` (FSM stage). This
-- column holds free-form observations the agent itself decides to
-- retain via the new `remember` tool — preferences, constraints, prior
-- decisions, situational context that the regex extractor doesn't catch.
--
-- Strict per-appointment scoping: the read/write API in
-- agent-memory.service.ts only accepts an appointment ID and only uses
-- findUnique/update on that primary key. Cross-appointment leakage is
-- not possible at the storage layer.
--
-- Existing rows default to NULL; the service treats NULL as "no notes
-- yet" and behaves identically to an empty notes array.

ALTER TABLE "appointment_requests"
  ADD COLUMN "memory" JSONB;
