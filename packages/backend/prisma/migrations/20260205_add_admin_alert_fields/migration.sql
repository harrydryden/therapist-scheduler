-- AlterTable
ALTER TABLE "therapist_booking_status" ADD COLUMN "admin_alert_at" TIMESTAMP(3);
ALTER TABLE "therapist_booking_status" ADD COLUMN "admin_alert_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "therapist_booking_status_admin_alert_at_idx" ON "therapist_booking_status"("admin_alert_at");
