-- Add transition_generation counter on appointment_requests.
--
-- Bumped inside the atomic update of every status transition (see
-- appointment-lifecycle.service.ts). Included in side-effect-tracker
-- idempotency keys so that re-entering the same status (e.g. cancel
-- → re-confirm) doesn't dedupe against the previous generation's
-- already-completed Slack/email side-effect rows.
--
-- Existing rows default to 0; existing side_effect_logs rows have
-- idempotency keys derived without a generation component, so they
-- never collide with new keys (the input string for the hash is
-- different).

ALTER TABLE "appointment_requests"
  ADD COLUMN "transition_generation" INTEGER NOT NULL DEFAULT 0;
