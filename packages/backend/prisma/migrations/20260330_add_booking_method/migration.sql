-- AlterTable
-- Missing migration for the bookingMethod field added to schema.prisma in
-- commit 47509cd ("Add direct booking link support for therapists"). The
-- schema was updated but no migration was ever created, so production ran
-- with a Prisma client that referenced a non-existent column. Every
-- findUnique() on appointment_requests failed with:
--   The column `appointment_requests.booking_method` does not exist
-- which broke processEmailReply and by extension the entire missed-message
-- scanner recovery path.
ALTER TABLE "appointment_requests"
  ADD COLUMN IF NOT EXISTS "booking_method" TEXT NOT NULL DEFAULT 'agent_negotiated';
