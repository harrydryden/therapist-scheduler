-- Add user_name column to appointment_requests table
ALTER TABLE appointment_requests ADD COLUMN IF NOT EXISTS user_name TEXT;
