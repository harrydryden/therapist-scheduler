-- System review (Sept 2026): schema consolidation.
-- Every statement is idempotent so this can be re-run safely
-- (docs/SCHEMA_MIGRATIONS.md).

-- ---------------------------------------------------------------------------
-- 1. Weekly mailing: per-recipient send-once guard (the only guard was a
--    Redis key; a lost key re-blasted the whole list).
-- ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_weekly_mailing_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 2. Durable completed-client record per therapist. The "target
--    appointments reached" availability rule counted completed rows live,
--    which retention deletes after a year, so graduated therapists came
--    back onto the public finder. Seeded from today's completed rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "therapist_completed_clients" (
  "id"                TEXT NOT NULL,
  "therapist_id"      TEXT NOT NULL,
  "client_email_hash" TEXT NOT NULL,
  "completed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "therapist_completed_clients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "therapist_completed_clients_therapist_id_client_email_hash_key"
  ON "therapist_completed_clients"("therapist_id", "client_email_hash");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'therapist_completed_clients_therapist_id_fkey'
  ) THEN
    ALTER TABLE "therapist_completed_clients"
      ADD CONSTRAINT "therapist_completed_clients_therapist_id_fkey"
      FOREIGN KEY ("therapist_id") REFERENCES "therapists"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
-- Seed from existing completed appointments (sha256 of lowercased email,
-- matching the application's hashing). Rows whose therapist_id is null
-- (legacy) are resolved through the handle.
INSERT INTO "therapist_completed_clients" ("id", "therapist_id", "client_email_hash", "completed_at")
SELECT
  gen_random_uuid()::text,
  t.id,
  encode(sha256(convert_to(lower(a.user_email), 'UTF8')), 'hex'),
  COALESCE(a.updated_at, CURRENT_TIMESTAMP)
FROM "appointment_requests" a
JOIN "therapists" t
  ON t.id = a.therapist_id
  OR (a.therapist_id IS NULL AND t.notion_id = a.therapist_handle)
WHERE a.status = 'completed'
ON CONFLICT ("therapist_id", "client_email_hash") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Booking-request email verification. Existing rows are treated as
--    verified as of their creation so nothing in flight is gated.
-- ---------------------------------------------------------------------------
ALTER TABLE "appointment_requests"
  ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "email_verification_sent_at" TIMESTAMP(3);
UPDATE "appointment_requests"
   SET "email_verified_at" = "created_at"
 WHERE "email_verified_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Side-effect generation stamp so the retry runner can supersede an
--    effect whose transition has been overtaken (e.g. a "confirmed for
--    Tue 3pm" email retried after a reschedule).
-- ---------------------------------------------------------------------------
ALTER TABLE "side_effect_logs"
  ADD COLUMN IF NOT EXISTS "transition_generation" INTEGER;

-- ---------------------------------------------------------------------------
-- 5. Drop the Phase-3a conversation mirror. Nothing ever read it, every
--    agent turn wrote the ~500KB blob twice, and two remediation scripts
--    skipped it. The decision recorded in docs/REFACTOR_PLAN.md was
--    "cut over or drop"; this drops.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "appointment_conversations";

-- ---------------------------------------------------------------------------
-- 6. Legacy JSON-string conversation state → jsonb object. Writers now
--    store objects; rows that never receive another save keep the string
--    shape and break jsonb_set in the lifecycle audit path (SQLSTATE
--    22023). Only string-typed rows are touched.
-- ---------------------------------------------------------------------------
UPDATE "appointment_requests"
   SET "conversation_state" = ("conversation_state" #>> '{}')::jsonb
 WHERE jsonb_typeof("conversation_state") = 'string';
UPDATE "weekly_mailing_inquiries"
   SET "conversation_state" = ("conversation_state" #>> '{}')::jsonb
 WHERE jsonb_typeof("conversation_state") = 'string';
-- Re-run the 20260517 checkpoint_at backfill for rows the string shape
-- prevented it from reaching.
UPDATE "appointment_requests"
   SET "checkpoint_at" = NULLIF("conversation_state" -> 'checkpoint' ->> 'checkpoint_at', '')::timestamptz
 WHERE "checkpoint_at" IS NULL
   AND jsonb_typeof("conversation_state") = 'object'
   AND ("conversation_state" -> 'checkpoint' ->> 'checkpoint_at') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Indexes. Add the hot-path ones the review found missing; drop
--    single-column duplicates of @unique columns and prefixes of existing
--    composite indexes (write overhead, no read benefit).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "appointment_requests_therapist_handle_status_idx"
  ON "appointment_requests"("therapist_handle", "status");
CREATE INDEX IF NOT EXISTS "appointment_requests_status_updated_at_idx"
  ON "appointment_requests"("status", "updated_at");
CREATE INDEX IF NOT EXISTS "pending_emails_status_last_retry_at_idx"
  ON "pending_emails"("status", "last_retry_at");
CREATE INDEX IF NOT EXISTS "side_effect_logs_status_created_at_idx"
  ON "side_effect_logs"("status", "created_at");

DROP INDEX IF EXISTS "users_od_id_idx";
DROP INDEX IF EXISTS "users_email_idx";
DROP INDEX IF EXISTS "users_subscribed_idx";
DROP INDEX IF EXISTS "therapists_od_id_idx";
DROP INDEX IF EXISTS "therapists_notion_id_idx";
DROP INDEX IF EXISTS "therapists_handle_idx";
DROP INDEX IF EXISTS "appointment_requests_idempotency_key_created_at_idx";
DROP INDEX IF EXISTS "idx_appointments_idempotency_key";
DROP INDEX IF EXISTS "appointment_requests_tracking_code_idx";
DROP INDEX IF EXISTS "pending_emails_status_idx";
DROP INDEX IF EXISTS "side_effect_logs_status_idx";
DROP INDEX IF EXISTS "message_processing_failures_abandoned_idx";
DROP INDEX IF EXISTS "therapist_conversations_status_idx";

-- ---------------------------------------------------------------------------
-- 8. Reconcile constraints the schema declares but the migration history
--    never created (they exist in prod via the original db push; they were
--    missing on migration-built databases such as CI/staging).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_requests_tracking_code_key"
  ON "appointment_requests"("tracking_code");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'side_effect_logs_appointment_id_fkey'
  ) THEN
    ALTER TABLE "side_effect_logs"
      ADD CONSTRAINT "side_effect_logs_appointment_id_fkey"
      FOREIGN KEY ("appointment_id") REFERENCES "appointment_requests"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
