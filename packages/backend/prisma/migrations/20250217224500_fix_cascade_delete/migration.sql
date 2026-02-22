-- Fix foreign key constraint to use CASCADE DELETE
-- This ensures audit events are automatically deleted when their appointment is deleted

-- Drop the existing constraint
ALTER TABLE "appointment_audit_events" 
DROP CONSTRAINT IF EXISTS "appointment_audit_events_appointment_request_id_fkey";

-- Re-add with CASCADE DELETE
ALTER TABLE "appointment_audit_events" 
ADD CONSTRAINT "appointment_audit_events_appointment_request_id_fkey" 
FOREIGN KEY ("appointment_request_id") 
REFERENCES "appointment_requests"("id") 
ON DELETE CASCADE ON UPDATE CASCADE;
