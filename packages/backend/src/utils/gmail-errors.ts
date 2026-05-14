/**
 * Type guards for Gmail / googleapis errors.
 *
 * The `googleapis` SDK surfaces HTTP errors as `GaxiosError` objects.
 * For 404 responses the SDK sets BOTH `code` and `status` to the
 * numeric `404`, though older SDK versions and some retry wrappers
 * only set one of them. We accept either.
 *
 * Gmail's 404 message text is "Requested entity was not found." —
 * that's what production sees in alerts and operator dashboards. The
 * code-based check is the contract; the message text is just for
 * humans.
 *
 * The pattern was repeated inline at three sites before this helper
 * was added (`services/thread-fetching.service.ts:143`,
 * `services/email-ingest.service.ts:572`,
 * `routes/admin/appointments/reprocess-thread.ts:186`). Migrating
 * those is a follow-up — this file consolidates the contract and
 * gives a single hook for future extensions (e.g. surface the
 * canonical message text on the error for logs).
 */

/**
 * True iff the error looks like a Gmail / googleapis 404 ("Requested
 * entity was not found"). Tolerant of either `code` or `status`
 * being set, since the SDK and some retry wrappers populate them
 * differently.
 */
export function isGmail404(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown };
  return e.code === 404 || e.status === 404;
}
