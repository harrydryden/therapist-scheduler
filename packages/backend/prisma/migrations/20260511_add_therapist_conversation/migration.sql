-- Therapist-only conversation tracking + per-therapist episodic availability.
--
-- Two related additions, shipped together because the availability-collection
-- agent (introduced in subsequent phases) writes to both:
--
-- 1) therapists.upcoming_availability — one-off availability windows the
--    therapist has shared, captured by the agent in JSONB. Same row shape as
--    AppointmentRequest.memory.availabilityWindows (see agent-memory.service.ts):
--    [{id, startsAt, endsAt, status, source, quote, recordedAt}] with ISO 8601
--    timestamps. The recurring weekly schedule continues to live on
--    therapists.availability — this column complements it for ad-hoc windows
--    the agent learns about outside of any specific appointment thread.
--
-- 2) therapist_conversations table — a slim conversation entity parallel to
--    appointment_requests but anchored to a single therapist with no client
--    counterpart. Created for two flows:
--      - kind='onboarding'  outbound first-contact after PDF ingestion /
--                           signup-invitation acceptance, asking the therapist
--                           when they're available.
--      - kind='nudge_reply' the existing "still looking" nudge email now
--                           includes an availability ask; replies route to a
--                           row of this kind instead of the unmatched queue.
--
--    Supersession (superseded_at / superseded_by_appointment_id /
--    superseded_ack_sent) handles the case where a real client booking lands
--    while a therapist-only conversation is still active: the booking takes
--    priority, this row is marked superseded, and subsequent replies on the
--    same Gmail thread are captured silently — except the first one, which
--    gets a one-shot ack and then we go silent.
--
-- Safety: pure CREATE TABLE + ALTER TABLE ADD COLUMN with no NOT NULL on the
-- new column. No data is touched on existing rows. Safe online.

ALTER TABLE "therapists" ADD COLUMN "upcoming_availability" JSONB;

CREATE TABLE "therapist_conversations" (
  "id"                            TEXT NOT NULL,
  "therapist_id"                  TEXT NOT NULL,
  "kind"                          TEXT NOT NULL,
  "status"                        TEXT NOT NULL DEFAULT 'active',
  "gmail_thread_id"               TEXT,
  "initial_message_id"            TEXT,
  "conversation_state"            JSONB,
  "memory"                        JSONB,
  "message_count"                 INTEGER NOT NULL DEFAULT 0,
  "last_activity_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "is_stale"                      BOOLEAN NOT NULL DEFAULT false,
  "human_control_enabled"         BOOLEAN NOT NULL DEFAULT false,
  "human_control_taken_by"        TEXT,
  "human_control_taken_at"        TIMESTAMP(3),
  "human_control_reason"          TEXT,
  "superseded_at"                 TIMESTAMP(3),
  "superseded_by_appointment_id"  TEXT,
  "superseded_ack_sent"           BOOLEAN NOT NULL DEFAULT false,
  "completed_at"                  TIMESTAMP(3),
  "created_at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "therapist_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "therapist_conversations_therapist_id_idx"           ON "therapist_conversations"("therapist_id");
CREATE INDEX "therapist_conversations_gmail_thread_id_idx"        ON "therapist_conversations"("gmail_thread_id");
CREATE INDEX "therapist_conversations_status_idx"                 ON "therapist_conversations"("status");
CREATE INDEX "therapist_conversations_kind_status_idx"            ON "therapist_conversations"("kind", "status");
CREATE INDEX "therapist_conversations_status_last_activity_at_idx" ON "therapist_conversations"("status", "last_activity_at");

ALTER TABLE "therapist_conversations"
  ADD CONSTRAINT "therapist_conversations_therapist_id_fkey"
  FOREIGN KEY ("therapist_id") REFERENCES "therapists"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
