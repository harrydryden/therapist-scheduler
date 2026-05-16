-- Default `checkpoint_stage` to `initial_contact` so freshly-created
-- appointment rows carry a valid stage before the agent's first run.
-- The denormalised column is the source of truth for dashboard list
-- queries; without a default it stays NULL on admin-created rows and
-- the operator sees a generic "Awaiting next message" fallback.
--
-- Existing rows with NULL are intentionally NOT backfilled — the
-- list endpoint's heuristic (lastEmailSentTo / lastMessageRole) already
-- carries enough signal for legacy data, and bulk-rewriting historical
-- rows to `initial_contact` would misrepresent appointments that are
-- actually further along (e.g. negotiating or rescheduling). New rows
-- pick up the default; the agent advances them as normal.
ALTER TABLE "appointment_requests"
  ALTER COLUMN "checkpoint_stage" SET DEFAULT 'initial_contact';
