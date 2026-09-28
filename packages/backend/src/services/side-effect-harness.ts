/**
 * Side-Effect Harness — Orchestration Layer
 *
 * Sits on top of `sideEffectTrackerService` (the data layer that owns
 * the `side_effect_logs` table) and provides three public wrappers
 * that bind tracked-side-effect semantics to `runBackgroundTask`:
 *
 *   - runTrackedSideEffect — appointment-scoped, status-transition,
 *     no replay payload (executor re-derives state from DB).
 *   - runReplayableTrackedSideEffect — appointment-scoped, status-
 *     transition, captures a rendered payload at original-send time
 *     so retries replay it verbatim.
 *   - runPeriodicTrackedSideEffect — time-driven, scope-discriminated
 *     (appointment OR therapist), captures a rendered payload.
 *
 * Split out of side-effect-tracker.service.ts when that module hit ~890
 * LOC and started mixing two distinct concerns:
 *   - DB ops on side_effect_logs (the tracker class + singleton)
 *   - background-task orchestration + lifecycle (this file)
 *
 * The split is by failure mode: tracker faults are DB races / unique-
 * key conflicts; harness faults are render errors / execute timeouts /
 * registration vs. fire-and-forget sequencing. Co-locating them in one
 * module made the file grow every time we added a new scope or wrapper.
 */

import { logger } from '../utils/logger';
import { runBackgroundTask, type BackgroundTaskOptions } from '../utils/background-task';
import {
  sideEffectTrackerService,
  type SideEffectType,
  type TransitionType,
  type RegisteredSideEffect,
} from './side-effect-tracker.service';

/**
 * Parent of a periodic tracked side effect. Mirrors the DB's
 * polymorphism — every side_effect_logs row points at EXACTLY ONE of
 * an appointment or a therapist (enforced by
 * side_effect_logs_scope_check). The discriminated union is the
 * single boundary type all periodic harness callers cross; downstream
 * (register / executor / abandon hook) all branch on `kind`.
 */
export type SideEffectScope =
  | { kind: 'appointment'; appointmentId: string }
  | { kind: 'therapist'; therapistId: string };

/**
 * What the harness does when `register()` itself throws (DB outage,
 * pool timeout, ...).
 *
 *   - 'run-untracked': log and run `execute` once without a row. Degrade-
 *     rather-than-drop, for effects that have NO durable row anywhere else
 *     (the periodic harness: sentinel-gated follow-ups and therapist
 *     nudges, whose rows are only ever created here).
 *   - 'rethrow': do NOT execute; re-throw so runBackgroundTask's short
 *     in-process retry re-attempts registration. For the status-
 *     transition wrappers, whose rows were pre-registered inside the
 *     transition's own transaction (register-in-tx-design.md §7 / §11).
 *     That in-tx row is the durable owner of the effect: running the
 *     effect untracked here would leave the in-tx row `pending`, and the
 *     retry runner's stale-pending bucket would then send it AGAIN ~10
 *     minutes later (lifecycle audit L3). If registration keeps failing,
 *     the retry runner picks the in-tx row up once the DB is back.
 */
type RegistrationFailurePolicy = 'run-untracked' | 'rethrow';

/**
 * Shared body for every harness wrapper.
 *
 * Sequence (identical for all three public wrappers — the only things
 * that differ are what `register` does and the registration-failure
 * policy):
 *   register -> (on-error: per RegistrationFailurePolicy, see above)
 *            -> if status is 'completed' or 'abandoned': skip
 *            -> claim execute lease (skip if another worker holds it)
 *            -> execute
 *                 (on-execute-error: markFailed + re-throw)
 *            -> markCompletedAfterExecute
 *                 (separate phase: never marks failed, never re-throws)
 *
 * The execute and mark-completed phases are deliberately NOT in one
 * try/catch. When execute has resolved, the effect has happened (the email
 * is in Gmail, the Slack message is posted). If markCompleted then hits a
 * DB blip, treating that as an execute failure would markFailed + re-throw,
 * and runBackgroundTask's retry (every transition notification uses
 * retry: true) would re-claim the now-`failed` row and send the effect a
 * second time ~1s later (lifecycle audit L3). `markCompletedAfterExecute`
 * retries the bookkeeping write instead and leaves the row `running`
 * (lease-protected) if it cannot be persisted.
 *
 * Locking this in one place means a behaviour change (e.g. a new
 * completed/abandoned branch, or a different way of logging
 * registration failures) hits all three wrappers and can't drift.
 */
async function runWithTrackedRegistration(
  register: () => Promise<RegisteredSideEffect>,
  execute: (registered?: RegisteredSideEffect) => Promise<unknown>,
  logContext: Record<string, unknown>,
  onRegistrationFailure: RegistrationFailurePolicy,
): Promise<void> {
  let registered;
  try {
    registered = await register();
  } catch (regErr) {
    if (onRegistrationFailure === 'rethrow') {
      logger.warn(
        { err: regErr, ...logContext },
        'Side-effect registration failed; not running untracked — the row pre-registered ' +
          'in the transition transaction owns this effect (in-process retry / retry runner will re-drive it)',
      );
      throw regErr;
    }
    // Registration failure (DB outage, etc.) — fall back to running the
    // task untracked rather than dropping the side effect entirely.
    logger.warn(
      { err: regErr, ...logContext },
      'Side-effect registration failed; running untracked',
    );
    await execute();
    return;
  }

  if (registered.status === 'completed') {
    // Prior invocation already completed (e.g. process restart between
    // mark-complete and runBackgroundTask exit). Idempotency: skip.
    logger.debug(
      { ...logContext, idempotencyKey: registered.idempotencyKey },
      'Side effect already completed; skipping',
    );
    return;
  }

  if (registered.status === 'abandoned') {
    logger.warn(
      { ...logContext, idempotencyKey: registered.idempotencyKey },
      'Side effect previously abandoned; not retrying',
    );
    return;
  }

  // Atomic execute-lease claim. Without this, the periodic retry runner
  // can pick up a still-in-flight row (status='pending', age >10min) and
  // fire a parallel execute — duplicate emails were the documented risk.
  // tryClaimEffect CAS-transitions pending/failed/stuck-running to
  // running with a fresh lease. A `false` return means another worker
  // holds the lease (or the row drifted to completed/abandoned between
  // register and claim), so we silently skip — that other worker will
  // mark the row's terminal state.
  const claimed = await sideEffectTrackerService.tryClaimEffect(
    registered.idempotencyKey,
  );
  if (!claimed) {
    logger.info(
      { ...logContext, idempotencyKey: registered.idempotencyKey },
      'Side effect execute-lease held by another worker; skipping',
    );
    return;
  }

  // Phase 1: execute. Only a failure HERE means the effect did not happen.
  try {
    await execute(registered);
  } catch (err) {
    // Persist the failure so the periodic retry service picks it up.
    // Re-throw so runBackgroundTask still records the metric and runs
    // its short in-process retry sequence.
    await sideEffectTrackerService
      .markFailed(
        registered.idempotencyKey,
        err instanceof Error ? err.message : String(err),
      )
      .catch((markErr) => {
        logger.error(
          { err: markErr, ...logContext },
          'Failed to mark side effect as failed (will retry next run)',
        );
      });
    throw err;
  }

  // Phase 2: record completion. The effect has already happened — this
  // must never mark the row failed or throw back into a retry.
  await sideEffectTrackerService.markCompletedAfterExecute(
    registered.idempotencyKey,
    logContext,
  );
}

/**
 * Fire-and-forget a side effect with persistent retry coverage.
 *
 * Registers the effect in `side_effect_logs` (idempotency key = hash of
 * appointmentId+transition+effectType), runs it via `runBackgroundTask`
 * for in-process retries, and marks the row completed/failed. If the
 * in-process retries are exhausted, the row stays in `failed` status and
 * the periodic `sideEffectRetryService` picks it up across restarts.
 *
 * Use this for effects whose retry executor in `side-effect-retry.service`
 * can re-derive state from the appointment row (Slack notifications,
 * Notion syncs). For replay-sensitive effects like settings-driven emails,
 * use `runReplayableTrackedSideEffect` so the rendered payload is captured
 * at registration time and the retry replays it verbatim.
 */
export function runTrackedSideEffect(
  appointmentId: string,
  transition: TransitionType,
  effectType: SideEffectType,
  task: () => Promise<unknown>,
  options: BackgroundTaskOptions,
  transitionGeneration?: number,
): void {
  runBackgroundTask(
    () =>
      runWithTrackedRegistration(
        async () => {
          const [reg] = await sideEffectTrackerService.registerSideEffects(
            appointmentId,
            transition,
            [{ effectType }],
            transitionGeneration,
          );
          return reg;
        },
        task,
        { appointmentId, transition, effectType },
        // Every status-transition effect is pre-registered inside the
        // transition's transaction (confirmed.ts / cancelled.ts /
        // completed.ts registerEffects) — never run it untracked.
        'rethrow',
      ),
    options,
  );
}

/**
 * Variant of `runTrackedSideEffect` for replay-sensitive effects (e.g. emails
 * whose templates are settings-driven). The renderer runs first and produces
 * the rendered payload, which is persisted on the registration row. The
 * retry executor uses the persisted payload verbatim, so retries can't drift
 * from the original send even if templates or settings change between runs.
 *
 * Sequencing on a fresh process:
 *   render → register (with payload) → execute (uses same payload).
 * If render throws: nothing registers (matches the previous untracked
 * behaviour where a template-load failure dropped the email).
 * If execute throws: row is marked failed and the periodic retry runner
 * picks it up using the stored payload.
 * If registration throws: nothing executes — the row pre-registered in the
 * transition transaction owns the effect (RegistrationFailurePolicy
 * 'rethrow'); runBackgroundTask's retry or the retry runner re-drives it.
 * If execute succeeds but markCompleted fails: the row is NOT marked failed
 * and nothing re-throws (see markCompletedAfterExecute), so the email is not
 * re-sent by the in-process retry.
 */
export function runReplayableTrackedSideEffect<P>(
  appointmentId: string,
  transition: TransitionType,
  effectType: SideEffectType,
  spec: {
    /** Render the payload once at original send time. Failure aborts. */
    renderPayload: () => Promise<P>;
    /** Execute the side effect using the rendered payload. */
    execute: (payload: P) => Promise<unknown>;
  },
  options: BackgroundTaskOptions,
  transitionGeneration?: number,
): void {
  runBackgroundTask(async () => {
    const payload = await spec.renderPayload();
    await runWithTrackedRegistration(
      async () => {
        const [reg] = await sideEffectTrackerService.registerSideEffects(
          appointmentId,
          transition,
          [{ effectType, payload }],
          transitionGeneration,
        );
        // registerSideEffects no-ops (returns the existing row untouched)
        // when the idempotency key already exists — the case for a row
        // pre-registered in-tx as intent-only or render-context-only
        // (register-in-tx-design.md). Persist the freshly-rendered
        // payload explicitly so the DB row always ends up holding the
        // envelope actually sent, and so a crash between render and
        // send still leaves a full, verbatim-replayable envelope for
        // retry instead of the smaller pre-commit context.
        await sideEffectTrackerService.updatePayload(reg.idempotencyKey, payload);
        return reg;
      },
      () => spec.execute(payload),
      { appointmentId, transition, effectType },
      // Pre-registered in the transition transaction — see runTrackedSideEffect.
      'rethrow',
    );
  }, options);
}

/**
 * Periodic-effect harness — the only public entry point for time-driven
 * outbound actions that aren't tied to an `appointmentRequest.status`
 * transition. Used by chase emails, session reminders, feedback-form
 * follow-ups (appointment-scoped) and the weekly therapist-nudge
 * (therapist-scoped). Both scopes converge here so the
 * register → completed-check → abandoned-check → execute →
 * mark-completed/failed plumbing lives in exactly one place.
 *
 * Scope: discriminated on `kind`. Appointment-scoped writes
 * `(appointmentId, transition='periodic')` to side_effect_logs;
 * therapist-scoped writes `(therapistId, transition='periodic')`. The
 * DB CHECK constraint side_effect_logs_scope_check guarantees exactly
 * one parent is set.
 *
 * Idempotency: keyed on `(scopeId, [scopeGeneration?], effectType)`.
 * Without `scopeGeneration` the effective key is "once per parent,
 * ever" — matches sentinel-claim semantics like `chaseSentAt` where
 * the parent row's own field already gates re-firing. With
 * `scopeGeneration` set (typically a per-cycle claim timestamp), each
 * cadence cycle gets its own row + its own attempts budget, so a
 * single 5-retry burst that exhausts can't permanently disable
 * future cycles. The therapist-nudge service uses this.
 *
 * Concurrency: the harness's `pending` status does NOT block parallel
 * `execute` calls (two concurrent ticks both see `pending` and both
 * proceed). Callers that need single-tick-wins protection must still
 * claim a sentinel BEFORE calling this helper; the harness on top
 * provides durability + retry, not exclusion.
 *
 * Sequencing: render → register → execute (uses rendered payload).
 * On render failure: nothing registers, caller's surrounding catch
 * handles it (typically releases the sentinel so the next tick
 * re-evaluates). On execute failure: row marked failed, retry runner
 * replays via the per-effectType branch in side-effect-retry.
 *
 * `execute` also receives an `updateStoredPayload` helper — best-effort,
 * for effects whose unit of work has more than one independent part
 * (e.g. a user+therapist email pair). Calling it persists incremental
 * progress to the row's stored payload, so a crash between the two parts
 * leaves a durable record of what already landed; retry (side-effect-
 * retry.service.ts) can then skip re-doing the part that succeeded
 * instead of blindly redoing the whole unit. Most callers ignore it.
 */
export function runPeriodicTrackedSideEffect<P>(
  scope: SideEffectScope,
  effectType: SideEffectType,
  spec: {
    renderPayload: () => Promise<P>;
    execute: (payload: P, helpers: { updateStoredPayload: (patch: Partial<P>) => Promise<void> }) => Promise<unknown>;
  },
  options: BackgroundTaskOptions,
  scopeGeneration?: number,
): void {
  runBackgroundTask(async () => {
    const payload = await spec.renderPayload();
    await runWithTrackedRegistration(
      () => registerForScope(scope, effectType, payload, scopeGeneration),
      (registered) => spec.execute(payload, {
        updateStoredPayload: registered
          ? (patch) => sideEffectTrackerService.updatePayload(registered.idempotencyKey, { ...payload, ...patch })
          : async () => {
              // Registration failed (running untracked) — nothing to persist to.
            },
      }),
      scopeLogContext(scope, effectType),
      // Periodic effects have no row anywhere else — degrade to a single
      // untracked attempt rather than dropping the effect.
      'run-untracked',
    );
  }, options);
}

async function registerForScope<P>(
  scope: SideEffectScope,
  effectType: SideEffectType,
  payload: P,
  scopeGeneration: number | undefined,
): Promise<RegisteredSideEffect> {
  if (scope.kind === 'appointment') {
    const [reg] = await sideEffectTrackerService.registerSideEffects(
      scope.appointmentId,
      'periodic',
      [{ effectType, payload }],
      scopeGeneration,
    );
    return reg;
  }
  const [reg] = await sideEffectTrackerService.registerTherapistSideEffects(
    scope.therapistId,
    [{ effectType, payload }],
    scopeGeneration,
  );
  return reg;
}

function scopeLogContext(scope: SideEffectScope, effectType: SideEffectType): Record<string, unknown> {
  return scope.kind === 'appointment'
    ? { appointmentId: scope.appointmentId, effectType }
    : { therapistId: scope.therapistId, effectType };
}
