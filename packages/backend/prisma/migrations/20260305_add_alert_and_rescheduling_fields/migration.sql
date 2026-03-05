-- Rescheduling support
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "rescheduling_in_progress" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "rescheduling_initiated_by" TEXT;
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "previous_confirmed_date_time" TEXT;

-- Conversation stall detection
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "conversation_stall_alert_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "conversation_stall_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- Thread divergence tracking
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "thread_diverged_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "thread_divergence_details" TEXT;
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "thread_divergence_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- Last tool execution tracking
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "last_tool_executed_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "last_tool_execution_failed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "appointment_requests" ADD COLUMN IF NOT EXISTS "last_tool_failure_reason" TEXT;

-- Indexes for alert dashboards and queries
CREATE INDEX IF NOT EXISTS "appointment_requests_conversation_stall_alert_at_idx" ON "appointment_requests"("conversation_stall_alert_at");
CREATE INDEX IF NOT EXISTS "appointment_requests_last_tool_executed_at_idx" ON "appointment_requests"("last_tool_executed_at");
