-- Add payload column to side_effect_logs so retries can replay the
-- exact rendered subject/body/args captured at original registration time.
-- Optional: slack/notion-sync effects don't need a payload because their
-- retry executor re-derives state from the appointment row.

ALTER TABLE "side_effect_logs" ADD COLUMN "payload" JSONB;
