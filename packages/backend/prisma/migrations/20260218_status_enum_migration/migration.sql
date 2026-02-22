-- FIX #11: Migrate status fields from plain String to PostgreSQL enums
-- for DB-level enforcement of valid status values.

-- Step 1: Create the enum types
CREATE TYPE "appointment_status" AS ENUM (
  'pending',
  'contacted',
  'negotiating',
  'confirmed',
  'session_held',
  'feedback_requested',
  'completed',
  'cancelled'
);

CREATE TYPE "weekly_mailing_status" AS ENUM (
  'active',
  'resolved'
);

-- Step 2: Alter the columns to use the enum types
-- The USING clause casts existing string values to the new enum type.
-- Any row with an invalid status value will cause this migration to fail,
-- which is the desired behavior — we want to catch data issues, not hide them.
ALTER TABLE "appointment_requests"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" SET DATA TYPE "appointment_status" USING "status"::"appointment_status",
  ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER TABLE "weekly_mailing_inquiries"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" SET DATA TYPE "weekly_mailing_status" USING "status"::"weekly_mailing_status",
  ALTER COLUMN "status" SET DEFAULT 'active';
