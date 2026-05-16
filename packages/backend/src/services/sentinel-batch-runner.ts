/**
 * Sentinel-claim batch runner — outer loop for periodic services that
 * follow the candidate-query → tryClaimSentinel → schedule-effect →
 * sentinel-reset-on-prep-error pattern.
 *
 * Every `process*` method in `post-booking-followup.service.ts` hand-rolled
 * the same scaffolding around the side-effect harness: fetch candidates,
 * iterate, optionally pre-filter, try-claim the row's sentinel, on success
 * render + queue an effect, on prep failure roll the sentinel back so the
 * next tick can re-evaluate, and emit a single summary log at the end. The
 * variation was always inside `fetchCandidates` (different `where`/`select`),
 * `preCheck` (status drift, not-yet-due, missing FK, etc.) and `schedule`
 * (the body that builds an envelope and hands it to the harness).
 *
 * This module captures the invariant scaffolding so each callsite shrinks
 * to its candidate query + pre-filter + schedule body — the parts that
 * legitimately differ between effects.
 *
 * Failure-mode split (matches the rest of the harness stack):
 *   - prep errors (template render, settings read, missing FK) throw
 *     synchronously out of `schedule` and are caught here, which rolls
 *     the sentinel back via `releaseSentinelClaim` (only flips it if
 *     it's still the EPOCH sentinel — won't clobber drift).
 *   - execute errors land inside the harness and are retried by the
 *     side-effect-retry runner; they do NOT flow through here.
 */

import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import {
  tryClaimSentinel,
  releaseSentinelClaim,
  type AppointmentSentinelField,
} from '../utils/atomic-sentinel-claim';

/**
 * Pre-claim decision. Returned from `preCheck` to tell the runner how
 * to handle this candidate before attempting the sentinel claim.
 *
 * - 'proceed' — claim the sentinel and call `schedule`
 * - 'skip'    — count toward `skipped` in the summary log; optional
 *               `debugLog` message is emitted at debug level
 * - 'wait'    — silent continue (not yet due, etc.); not counted
 */
export type PreCheckDecision =
  | { kind: 'proceed' }
  | { kind: 'skip'; debugLog?: string }
  | { kind: 'wait' };

/**
 * Schedule outcome. Returned from `schedule` to tell the runner whether
 * this candidate consumed a queue slot or was tombstoned post-claim.
 *
 * - undefined / void — queued an effect (counted as `sent`)
 * - 'skipped'        — post-claim tombstone (e.g. missing FK; the
 *                      callback has already advanced the sentinel
 *                      itself via confirmSentinelClaim). Counted as
 *                      `skipped` in the summary log.
 */
export type ScheduleOutcome = void | 'skipped';

export interface SentinelBatchSpec<Candidate extends { id: string }> {
  /** Trace id from the outer periodic-check tick — included in every log line. */
  checkId: string;
  /**
   * Short human-readable name used in the trailing summary log and the
   * "already being processed" debug log. Examples: 'session reminder',
   * 'meeting link check', 'feedback form', 'feedback reminder'.
   */
  effectName: string;
  /** Column on `appointmentRequest` that gates this effect. */
  sentinelField: AppointmentSentinelField;
  /**
   * Extra `where` clause passed to `tryClaimSentinel` — typically a
   * status precondition that aborts the claim if the row drifted
   * out of the expected state between candidate query and claim time.
   */
  claimPrecondition?: Prisma.AppointmentRequestWhereInput;
  /**
   * Fetch the candidate batch. The runner handles the empty case
   * (returns silently, no summary log when nothing was checked).
   */
  fetchCandidates: () => Promise<Candidate[]>;
  /**
   * Optional pre-claim filter. Runs before the sentinel claim, so
   * `skip` here doesn't waste a claim cycle. Without this hook, every
   * candidate proceeds to the claim attempt.
   */
  preCheck?: (candidate: Candidate) => Promise<PreCheckDecision>;
  /**
   * Called after the sentinel is claimed. The body typically:
   *   1. Renders the email envelope synchronously (so render errors
   *      flow through the runner's catch block and reset the sentinel).
   *   2. Calls `runPeriodicTrackedSideEffect` with the rendered payload.
   *
   * Return `'skipped'` to count this candidate as skipped instead of
   * sent (used for post-claim tombstones — e.g. missing tracking code
   * where the callback advances the sentinel itself).
   */
  schedule: (candidate: Candidate) => Promise<ScheduleOutcome>;
}

/**
 * Run the candidate-query → claim → schedule → summary loop for one
 * periodic effect. Returns silently when the candidate batch is empty;
 * emits a single info-level "X processing complete" log when at least
 * one candidate was acted on.
 */
export async function processSentinelBatch<C extends { id: string }>(
  spec: SentinelBatchSpec<C>,
): Promise<void> {
  const candidates = await spec.fetchCandidates();
  if (candidates.length === 0) return;

  let sent = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    if (spec.preCheck) {
      const decision = await spec.preCheck(candidate);
      if (decision.kind === 'wait') continue;
      if (decision.kind === 'skip') {
        if (decision.debugLog) {
          logger.debug(
            { checkId: spec.checkId, appointmentId: candidate.id },
            decision.debugLog,
          );
        }
        skipped++;
        continue;
      }
    }

    const claimed = await tryClaimSentinel(candidate.id, spec.sentinelField, {
      extraWhere: spec.claimPrecondition,
    });
    if (!claimed) {
      logger.debug(
        { checkId: spec.checkId, appointmentId: candidate.id },
        `${spec.effectName} already being processed or precondition changed`,
      );
      continue;
    }

    try {
      const outcome = await spec.schedule(candidate);
      if (outcome === 'skipped') {
        skipped++;
      } else {
        sent++;
      }
    } catch (error) {
      // Prep errors (template render, settings read) land here. Roll
      // the sentinel back so the row can be re-evaluated next tick.
      // releaseSentinelClaim only flips if the field is still EPOCH —
      // won't clobber a real timestamp if some other path raced ahead.
      await releaseSentinelClaim(candidate.id, spec.sentinelField);
      logger.error(
        { checkId: spec.checkId, appointmentId: candidate.id, error },
        `Failed to prepare ${spec.effectName} email - will retry next cycle`,
      );
    }
  }

  if (sent > 0 || skipped > 0) {
    logger.info(
      { checkId: spec.checkId, sent, skipped, checked: candidates.length },
      `${spec.effectName} processing complete`,
    );
  }
}
