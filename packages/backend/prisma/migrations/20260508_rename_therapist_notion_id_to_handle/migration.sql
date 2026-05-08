-- Rename appointment_requests.therapist_notion_id → therapist_handle.
--
-- Final cleanup of the Notion deprecation. The column has been overloaded
-- since post-Notion ingestion: it holds either a legacy notion page id
-- (for therapists ingested while Notion was authoritative) or the
-- therapist's Postgres uuid (for new ingestions). The "notion_id" name
-- is now misleading — "handle" reflects what the value actually is:
-- the public-facing therapist identifier resolved via
-- `therapist.notionId ?? therapist.id`.
--
-- Safety: ALTER TABLE RENAME COLUMN is metadata-only on PostgreSQL.
-- No table rewrite, no data scan, no exclusive lock on the data —
-- only a brief AccessExclusive on the catalog entry. All existing
-- indexes and constraints (the named partial-unique indexes from
-- earlier migrations and any auto-named Prisma indexes) are preserved
-- automatically: PostgreSQL stores them by column attnum, not by name.

ALTER TABLE "appointment_requests"
  RENAME COLUMN "therapist_notion_id" TO "therapist_handle";
