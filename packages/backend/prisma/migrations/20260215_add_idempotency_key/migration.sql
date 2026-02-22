-- Add idempotency_key column for preventing duplicate appointment creation
-- This handles:
-- 1. Double-clicks on submit button
-- 2. Network retries
-- 3. User refreshing during submission

ALTER TABLE "appointment_requests"
ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(255);

-- Add index for fast idempotency lookups (recent requests only)
CREATE INDEX IF NOT EXISTS "idx_appointments_idempotency_key"
ON "appointment_requests" ("idempotency_key", "created_at" DESC)
WHERE "idempotency_key" IS NOT NULL;

COMMENT ON COLUMN "appointment_requests"."idempotency_key" IS
  'Client-generated or computed key for preventing duplicate appointment creation within a time window';
