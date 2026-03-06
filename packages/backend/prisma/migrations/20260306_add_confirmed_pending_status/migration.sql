-- Add 'confirmed_pending' to appointment_status enum
-- This status represents appointments that are confirmed but awaiting a rearranged date/time.
-- Used when an admin removes the appointment date (e.g., for rearrangement).

ALTER TYPE "appointment_status" ADD VALUE IF NOT EXISTS 'confirmed_pending' AFTER 'confirmed';
