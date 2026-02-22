-- CreateTable
-- Side Effect Tracking for Two-Phase Commit Pattern
-- Ensures all side effects complete and can be retried if needed

CREATE TABLE IF NOT EXISTS "side_effect_logs" (
    "id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "effect_type" TEXT NOT NULL,
    "transition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_log" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "side_effect_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE UNIQUE INDEX IF NOT EXISTS "side_effect_logs_idempotency_key_key" ON "side_effect_logs"("idempotency_key");
CREATE INDEX IF NOT EXISTS "side_effect_logs_appointment_id_idx" ON "side_effect_logs"("appointment_id");
CREATE INDEX IF NOT EXISTS "side_effect_logs_status_idx" ON "side_effect_logs"("status");
CREATE INDEX IF NOT EXISTS "side_effect_logs_effect_type_status_idx" ON "side_effect_logs"("effect_type", "status");
CREATE INDEX IF NOT EXISTS "side_effect_logs_status_last_attempt_idx" ON "side_effect_logs"("status", "last_attempt_at");
