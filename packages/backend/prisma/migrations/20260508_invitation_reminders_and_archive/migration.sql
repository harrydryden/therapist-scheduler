-- Adds two columns to signup_invitations:
--   reminder_sent_at — nullable timestamp; set when the pre-expiry reminder
--                       email is sent so the background tick won't re-send.
--   archived_at      — nullable timestamp; set by the archival cron when an
--                       expired or revoked invitation rolls past 90 days.
--                       Archived rows fall out of the default admin listing
--                       but are not deleted, so the audit trail is intact.
--
-- Both are pure ADD COLUMN of nullable timestamps — metadata-only on
-- PostgreSQL 11+ and safe to run online.

ALTER TABLE "signup_invitations" ADD COLUMN "reminder_sent_at" TIMESTAMP(3);
ALTER TABLE "signup_invitations" ADD COLUMN "archived_at"      TIMESTAMP(3);

CREATE INDEX "signup_invitations_archived_at_idx" ON "signup_invitations"("archived_at");
