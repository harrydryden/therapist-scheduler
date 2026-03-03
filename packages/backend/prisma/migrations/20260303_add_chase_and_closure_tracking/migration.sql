-- Chase follow-up tracking
-- Agent sends one chase email to the non-responding party before recommending closure
ALTER TABLE "appointment_requests" ADD COLUMN "chase_sent_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN "chase_sent_to" TEXT;
ALTER TABLE "appointment_requests" ADD COLUMN "chase_target_email" TEXT;

-- Closure recommendation tracking
-- After chase goes unanswered, system recommends admin close the thread
ALTER TABLE "appointment_requests" ADD COLUMN "closure_recommended_at" TIMESTAMP(3);
ALTER TABLE "appointment_requests" ADD COLUMN "closure_recommended_reason" TEXT;
ALTER TABLE "appointment_requests" ADD COLUMN "closure_recommendation_actioned" BOOLEAN NOT NULL DEFAULT false;

-- Indexes for chase and closure queries
CREATE INDEX "appointment_requests_status_chase_sent_at_idx" ON "appointment_requests"("status", "chase_sent_at");
CREATE INDEX "appointment_requests_closure_recommended_at_idx" ON "appointment_requests"("closure_recommended_at");
