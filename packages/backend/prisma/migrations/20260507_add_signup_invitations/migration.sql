-- Signup invitations table.
--
-- Admin-issued one-time invitation tokens. The raw token is only in the
-- emailed URL; the DB stores only the SHA-256 hash. Rows are kept
-- indefinitely for audit and conversion reporting.
--
-- Lifecycle (status is computed, not a column):
--   pending  = revoked_at IS NULL AND accepted_at IS NULL AND expires_at > now()
--   expired  = revoked_at IS NULL AND accepted_at IS NULL AND expires_at <= now()
--   accepted = accepted_at IS NOT NULL
--   revoked  = revoked_at IS NOT NULL AND accepted_at IS NULL
--
-- Safety: pure CREATE TABLE + indexes, no data touched. Safe online.

CREATE TABLE "signup_invitations" (
  "id"                TEXT NOT NULL,
  "email"             TEXT NOT NULL,
  "name"              TEXT,
  "token_hash"        TEXT NOT NULL,
  "invited_by"        TEXT NOT NULL,
  "expires_at"        TIMESTAMP(3) NOT NULL,
  "accepted_at"       TIMESTAMP(3),
  "accepted_user_id"  TEXT,
  "revoked_at"        TIMESTAMP(3),
  "last_sent_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "send_count"        INTEGER NOT NULL DEFAULT 1,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "signup_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signup_invitations_token_hash_key" ON "signup_invitations"("token_hash");
CREATE INDEX "signup_invitations_email_idx"            ON "signup_invitations"("email");
CREATE INDEX "signup_invitations_accepted_at_idx"      ON "signup_invitations"("accepted_at");
CREATE INDEX "signup_invitations_revoked_at_idx"       ON "signup_invitations"("revoked_at");
CREATE INDEX "signup_invitations_expires_at_idx"       ON "signup_invitations"("expires_at");
