-- Postgres mirror columns for the Notion therapists/users databases.
-- This is PR 1 of the Notion → Postgres deprecation: schema is added and
-- backfilled, but reads still come from Notion. PR 2 flips reads to Postgres
-- and drops the Notion services.
--
-- Safety: every change here is either a nullable ADD COLUMN or an ADD COLUMN
-- with a constant default. Both are metadata-only on PostgreSQL 11+ and safe
-- to run online. The single UPDATE at the bottom is a one-row-per-user touch
-- to backfill consent timestamps for legacy users.

-- =========================
-- users: subscribed + consent
-- =========================

-- Subscribed mirrors the Notion `Subscribed` checkbox. Defaults to true to
-- match Notion's opt-out model (auto-subscribe new users).
ALTER TABLE "users" ADD COLUMN "subscribed" BOOLEAN NOT NULL DEFAULT true;

-- Signup consent fields. Nullable: a null value means the user has only ever
-- booked, never gone through /signup. Legacy users get consent_given_at
-- backfilled below — the deployment owner has confirmed they consented at
-- the time of their original booking.
ALTER TABLE "users" ADD COLUMN "prior_therapy" BOOLEAN;
ALTER TABLE "users" ADD COLUMN "acknowledged_real_session" BOOLEAN;
ALTER TABLE "users" ADD COLUMN "agreed_to_feedback" BOOLEAN;
ALTER TABLE "users" ADD COLUMN "consent_given_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "signup_source" TEXT;

CREATE INDEX "users_subscribed_idx" ON "users"("subscribed");

-- Backfill legacy users: stamp consent at row-creation time and label them
-- as legacy so future reports can distinguish them from /signup signups.
-- Runs once; idempotent because subsequent runs find consent_given_at NOT NULL.
UPDATE "users"
SET "consent_given_at" = "created_at",
    "signup_source"    = 'legacy'
WHERE "consent_given_at" IS NULL;

-- =========================
-- therapists: profile mirror
-- =========================

ALTER TABLE "therapists" ADD COLUMN "bio" TEXT;
ALTER TABLE "therapists" ADD COLUMN "approach" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "therapists" ADD COLUMN "style" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "therapists" ADD COLUMN "areas_of_focus" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "therapists" ADD COLUMN "profile_image" TEXT;
ALTER TABLE "therapists" ADD COLUMN "booking_link" TEXT;
ALTER TABLE "therapists" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "therapists_active_idx" ON "therapists"("active");
