/**
 * Shared Zod validation schemas for AI tool inputs.
 *
 * Used by both justin-time.service.ts (legacy tool execution path)
 * and ai-tool-executor.service.ts (extracted tool executor).
 */

import { z } from 'zod';

export const sendEmailInputSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(1000),
  body: z.string().min(1).max(50000),
});

export const updateAvailabilityInputSchema = z.object({
  availability: z.record(z.string(), z.string()),
});

export const markCompleteInputSchema = z.object({
  confirmed_datetime: z.string().min(1),
  notes: z.string().optional(),
});

export const cancelAppointmentInputSchema = z.object({
  reason: z.string().min(1).max(500),
  cancelled_by: z.enum(['client', 'therapist']),
});

export const recommendCancelMatchInputSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const initiateRescheduleInputSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const issueVoucherCodeInputSchema = z.object({
  email: z.string().email().max(255),
});

export const rememberInputSchema = z.object({
  note: z.string().min(1).max(280),
  category: z.enum(['preference', 'constraint', 'context', 'decision']),
});

/**
 * Validate an availability-window tool call. Both ends must be
 * parseable ISO 8601 datetimes; ordering and "not entirely in the
 * past" are checked at execution time so we can give the agent a
 * specific error message rather than a generic Zod failure.
 */
export const recordAvailabilityWindowInputSchema = z.object({
  starts_at: z.string().min(1).max(50).refine(
    (s) => !isNaN(Date.parse(s)),
    'starts_at must be a parseable ISO 8601 datetime (e.g. "2026-02-03T10:00:00+00:00")',
  ),
  ends_at: z.string().min(1).max(50).refine(
    (s) => !isNaN(Date.parse(s)),
    'ends_at must be a parseable ISO 8601 datetime',
  ),
  status: z.enum(['available', 'unavailable']),
  source: z.enum(['therapist', 'user']),
  quote: z.string().min(1).max(280),
});
