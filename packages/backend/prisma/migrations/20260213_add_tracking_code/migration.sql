-- Add tracking code for deterministic email matching
-- Format: SPL<number> (e.g., SPL1, SPL2, SPL42)
-- Same code is reused for all appointments between the same user+therapist pair
ALTER TABLE "appointment_requests" ADD COLUMN "tracking_code" TEXT;

-- Create unique index for tracking codes
-- Note: Multiple appointments can share the same tracking code (same user+therapist pair)
-- but we still want an index for fast lookups
CREATE INDEX "appointment_requests_tracking_code_idx" ON "appointment_requests"("tracking_code");

-- Generate tracking codes for existing appointments
-- Group by user_email + therapist_email pair and assign incremental codes
-- This ensures the same pair gets the same code across all their appointments
WITH numbered_pairs AS (
  SELECT DISTINCT ON (LOWER(user_email), LOWER(therapist_email))
    LOWER(user_email) as user_email_lower,
    LOWER(therapist_email) as therapist_email_lower,
    ROW_NUMBER() OVER (ORDER BY MIN(created_at)) as pair_number
  FROM "appointment_requests"
  WHERE "tracking_code" IS NULL
  GROUP BY LOWER(user_email), LOWER(therapist_email)
)
UPDATE "appointment_requests" ar
SET "tracking_code" = 'SPL' || np.pair_number
FROM numbered_pairs np
WHERE LOWER(ar.user_email) = np.user_email_lower
  AND LOWER(ar.therapist_email) = np.therapist_email_lower
  AND ar."tracking_code" IS NULL;
