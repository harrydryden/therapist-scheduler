-- Add agent_notes JSONB columns on users + therapists for the agent
-- profile (Layer C in the agent memory design).
--
-- Distinct from appointment_requests.memory (Layer B):
--   - Layer B is per-thread, capped at 20 notes, lives on the appointment
--     row, never crosses thread boundaries.
--   - Layer C is per-user / per-therapist, accumulates across appointments,
--     capped at 10 notes, deliberately crosses appointment boundaries so
--     the agent starts warm on subsequent bookings.
--
-- Phase 1 ships the storage + read path only. No auto-population yet —
-- profiles are only populated by admin via the dedicated endpoints in
-- admin-users.routes.ts and admin-therapists.routes.ts. Phase 2 will
-- add automatic distillation on appointment completion (LLM call gated
-- behind a feature flag, four independent privacy guards).
--
-- Strict per-entity scoping: the read/write API in agent-profile.service
-- only accepts a User.id or Therapist.id and only uses findUnique/update
-- on that primary key. Cross-user / cross-therapist leakage is not
-- possible at the storage layer.
--
-- Existing rows default to NULL; the service treats NULL as "no notes
-- yet" and behaves identically to an empty notes array.

ALTER TABLE "users"
  ADD COLUMN "agent_notes" JSONB;

ALTER TABLE "therapists"
  ADD COLUMN "agent_notes" JSONB;
