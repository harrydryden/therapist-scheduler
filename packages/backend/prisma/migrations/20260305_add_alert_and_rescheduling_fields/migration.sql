-- Rescheduling support
ALTER TABLE "appointment_requests" ADD COLUMN "rescheduling_in_progress" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "appointment_requests" ADD COLUMN "rescheduling_initiated_by" TEXT;
ALTER TABLE "appointment_requests" ADD COLUMN "previous_confirmed_date_time" TEXT;

-- Conversation stall detection
ALTER TABLE "appointment_requests" ADD COLUMN "conversation_stall_alert_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN "conversation_stall_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- Invalid date alert tracking
ALTER TABLE "appointment_requests" ADD COLUMN "invalid_date_alert_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN "invalid_date_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- Thread divergence tracking
ALTER TABLE "appointment_requests" ADD COLUMN "thread_diverged_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN "thread_divergence_details" TEXT;
ALTER TABLE "appointment_requests" ADD COLUMN "thread_divergence_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- Last tool execution tracking
ALTER TABLE "appointment_requests" ADD COLUMN "last_tool_executed_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN "last_tool_execution_failed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "appointment_requests" ADD COLUMN "last_tool_failure_reason" TEXT;

-- Indexes for alert dashboards and queries
CREATE INDEX "appointment_requests_invalid_date_alert_at_idx" ON "appointment_requests"("invalid_date_alert_at");
CREATE INDEX "appointment_requests_conversation_stall_alert_at_idx" ON "appointment_requests"("conversation_stall_alert_at");
CREATE INDEX "appointment_requests_last_tool_executed_at_idx" ON "appointment_requests"("last_tool_executed_at");
