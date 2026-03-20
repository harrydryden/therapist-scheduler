-- Add voucher_code column to appointment_requests for analytics
ALTER TABLE "appointment_requests" ADD COLUMN "voucher_code" TEXT;

-- Create voucher_tracking table for use-it-or-lose-it lifecycle
CREATE TABLE "voucher_tracking" (
    "id" TEXT NOT NULL,
    "strike_count" INTEGER NOT NULL DEFAULT 0,
    "last_voucher_sent_at" TIMESTAMP(3),
    "last_voucher_token" TEXT,
    "last_voucher_used_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voucher_tracking_pkey" PRIMARY KEY ("id")
);

-- Indexes for voucher tracking queries
CREATE INDEX "voucher_tracking_strike_count_idx" ON "voucher_tracking"("strike_count");
CREATE INDEX "voucher_tracking_last_voucher_sent_at_idx" ON "voucher_tracking"("last_voucher_sent_at");
