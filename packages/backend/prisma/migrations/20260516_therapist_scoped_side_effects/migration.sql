-- Allow side_effect_logs rows to be scoped to either an appointment OR
-- a therapist (e.g. for therapist-nudge cadence emails which don't
-- attach to any single appointment). A CHECK constraint enforces that
-- exactly one of the two foreign keys is set on every row.

ALTER TABLE "side_effect_logs"
  ALTER COLUMN "appointment_id" DROP NOT NULL;

ALTER TABLE "side_effect_logs"
  ADD COLUMN "therapist_id" TEXT;

ALTER TABLE "side_effect_logs"
  ADD CONSTRAINT "side_effect_logs_scope_check"
  CHECK (
    (appointment_id IS NOT NULL AND therapist_id IS NULL)
    OR (appointment_id IS NULL AND therapist_id IS NOT NULL)
  );

ALTER TABLE "side_effect_logs"
  ADD CONSTRAINT "side_effect_logs_therapist_id_fkey"
  FOREIGN KEY ("therapist_id") REFERENCES "therapists"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "side_effect_logs_therapist_id_idx" ON "side_effect_logs"("therapist_id");
