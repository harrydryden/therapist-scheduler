-- CreateTable
CREATE TABLE "unmatched_email_attempts" (
    "id" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "abandoned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "unmatched_email_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "unmatched_email_attempts_abandoned_idx" ON "unmatched_email_attempts"("abandoned");

-- CreateIndex
CREATE INDEX "unmatched_email_attempts_last_seen_at_idx" ON "unmatched_email_attempts"("last_seen_at");
