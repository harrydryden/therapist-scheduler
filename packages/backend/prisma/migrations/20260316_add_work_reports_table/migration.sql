-- CreateTable
CREATE TABLE "work_reports" (
    "id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "emails_sent" INTEGER NOT NULL DEFAULT 0,
    "emails_received" INTEGER NOT NULL DEFAULT 0,
    "appointments_created" INTEGER NOT NULL DEFAULT 0,
    "appointments_confirmed" INTEGER NOT NULL DEFAULT 0,
    "appointments_completed" INTEGER NOT NULL DEFAULT 0,
    "appointments_cancelled" INTEGER NOT NULL DEFAULT 0,
    "stale_conversations_flagged" INTEGER NOT NULL DEFAULT 0,
    "human_control_takeovers" INTEGER NOT NULL DEFAULT 0,
    "chase_follow_ups_sent" INTEGER NOT NULL DEFAULT 0,
    "closure_recommendations" INTEGER NOT NULL DEFAULT 0,
    "pipeline_pending" INTEGER NOT NULL DEFAULT 0,
    "pipeline_contacted" INTEGER NOT NULL DEFAULT 0,
    "pipeline_negotiating" INTEGER NOT NULL DEFAULT 0,
    "pipeline_confirmed" INTEGER NOT NULL DEFAULT 0,
    "feedback_submissions" INTEGER NOT NULL DEFAULT 0,
    "slack_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_reports_period_end_idx" ON "work_reports"("period_end");

-- CreateIndex
CREATE INDEX "work_reports_created_at_idx" ON "work_reports"("created_at");
