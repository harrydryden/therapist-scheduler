-- Make Therapist.notion_id nullable.
--
-- PR 2 of the Notion deprecation: Notion is no longer authoritative, so
-- new therapists ingested via the CV pipeline don't need a Notion page ID.
-- Existing rows keep their notion_id (it's still the public-facing handle
-- used by the frontend and booking flow), so this migration is purely a
-- relaxation of the NOT NULL constraint.
--
-- Safety: DROP NOT NULL is metadata-only on PostgreSQL — no table rewrite,
-- no exclusive lock on the data — so this is safe to run online.

ALTER TABLE "therapists" ALTER COLUMN "notion_id" DROP NOT NULL;
