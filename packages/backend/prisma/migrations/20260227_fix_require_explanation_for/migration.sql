-- Fix: the previous 20260227_add_require_explanation_for migration was marked
-- as applied by baseline.sh without the SQL ever executing (migration_lock.toml
-- was missing, causing prisma migrate deploy to always fail).
-- Use IF NOT EXISTS so this is safe on fresh deployments where the column exists.
ALTER TABLE "feedback_form_config" ADD COLUMN IF NOT EXISTS "require_explanation_for" JSONB NOT NULL DEFAULT '["No", "Unsure"]';
