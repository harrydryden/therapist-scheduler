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
 * Match ISO 8601 with an EXPLICIT timezone offset — `Z` or `±HH:MM`.
 * We reject the date-only and offset-less forms (e.g. "2026-05-19" or
 * "2026-05-19T14:00:00") because `Date.parse` accepts them but their
 * meaning depends on the runtime's local timezone, which silently
 * corrupts the absolute-instant guarantee the stored window relies on.
 *
 * Seconds are optional, fractional seconds are optional.
 */
const ISO_DATETIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const isoDatetimeWithOffset = (label: string) =>
  z
    .string()
    .min(1)
    .max(50)
    .refine(
      (s) => ISO_DATETIME_WITH_OFFSET.test(s) && !isNaN(Date.parse(s)),
      `${label} must be ISO 8601 with an explicit timezone offset (e.g. "2026-05-19T14:00:00+01:00" or "...Z")`,
    );

/**
 * Validate an availability-window tool call. Both ends must be
 * parseable ISO 8601 datetimes WITH offset; ordering and "not entirely
 * in the past" are checked at execution time so we can give the agent
 * a specific error message rather than a generic Zod failure.
 */
export const recordAvailabilityWindowInputSchema = z.object({
  starts_at: isoDatetimeWithOffset('starts_at'),
  ends_at: isoDatetimeWithOffset('ends_at'),
  status: z.enum(['available', 'unavailable']),
  source: z.enum(['therapist', 'user']),
  quote: z.string().min(1).max(280),
});

/**
 * Availability-collection variant of record_availability_window. Same
 * shape as the booking-side schema minus the `source` field — this
 * agent only ever talks to the therapist, so the source is always
 * 'therapist' and is hardcoded in the executor rather than asked of
 * the model.
 */
export const availabilityRecordWindowInputSchema = z.object({
  starts_at: isoDatetimeWithOffset('starts_at'),
  ends_at: isoDatetimeWithOffset('ends_at'),
  status: z.enum(['available', 'unavailable']),
  quote: z.string().min(1).max(280),
});

/**
 * Booking-link capture for the availability-collection agent. Just a
 * URL string; the executor stores it verbatim on Therapist.bookingLink.
 * Validation is "is a parseable URL" only — no domain allowlist,
 * because therapists use many scheduling tools and gating bookings on
 * a hardcoded list of providers would create false negatives.
 */
export const recordBookingLinkInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .url('url must be a parseable URL with a scheme (e.g. "https://calendly.com/...")'),
});

/**
 * Slim send_email used by the availability-collection agent. The
 * booking-side `sendEmailInputSchema` accepts a `to` field because the
 * agent picks the recipient (client vs therapist); here the recipient
 * is hardcoded to the therapist in the executor, so the schema only
 * carries subject + body.
 */
export const availabilitySendEmailInputSchema = z.object({
  subject: z.string().min(1).max(1000),
  body: z.string().min(1).max(50000),
});

/**
 * Slim mark_complete used by the availability-collection agent. The
 * booking side has a richer `mark_scheduling_complete` (datetime,
 * notes) because it finalises an actual appointment; here the agent
 * is just declaring it has captured enough info to stop talking.
 */
export const availabilityMarkCompleteInputSchema = z.object({
  summary: z.string().min(1).max(500),
});

/**
 * Shared schema for flag_for_human_review. Both agents (booking and
 * availability-collection) take the same shape, so we keep one
 * definition rather than two near-identical copies.
 */
export const flagForHumanReviewInputSchema = z.object({
  reason: z.string().min(1).max(500),
  suggested_action: z.string().max(500).optional(),
});
