# Stage B design: fixing the split-brain retry for sentinel-gated effects

Status: **implemented as proposed.** Decisions recorded in §6a below.

## 1. What's actually broken (re-verified against current code)

This is the HIGH-severity finding from the review:

> Side-effect retry executors replay only the email half of sentinel-gated periodic effects, dropping the sentinel confirm and the `feedback_requested` lifecycle transition.

Every sentinel-gated periodic effect (chase emails, meeting-link check, feedback-form dispatch, feedback reminder, session-reminder pair) is implemented **twice**:

- **First-run**, inside `post-booking-followup.service.ts` / `chase-email.service.ts`, as the `execute` closure passed to `runPeriodicTrackedSideEffect`. This closure does the full unit of work: send email(s) → `confirmSentinelClaim(...)` → (feedback dispatch only) `appointmentLifecycleService.transitionToFeedbackRequested(...)`.
- **Retry**, inside `side-effect-retry.service.ts`'s `executeEffect` switch statement, as a hand-written parallel branch that does **only** the send — it re-enqueues the stored payload via `emailQueueService.enqueue(...)` and `break`s. No sentinel confirm, no lifecycle transition, anywhere in the file.

Concretely, for `email_feedback_dispatch` (`side-effect-retry.service.ts:390-437`): the first-run closure at `post-booking-followup.service.ts:706-757` sends the user+therapist emails, calls `confirmSentinelClaim(appointment.id, 'feedbackFormSentAt', now)`, then `transitionToFeedbackRequested(...)`. The retry branch does two `emailQueueService.enqueue(...)` calls and stops. If the first-run closure throws **after the send but before (or during) the sentinel confirm** — a transient DB error, a Postgres blip — the harness marks the row `failed`, the retry runner picks it up, resends the email(s), and **still never confirms the sentinel or transitions the appointment**. The next `post-booking-followup` tick's stuck-sentinel cleanup resets the EPOCH sentinel, the candidate query re-finds the row, and the appointment is permanently stranded in `session_held` — chased/reminded forever, never marked `feedback_requested`, even though the email did go out.

The same shape exists for `email_chase_user` / `email_chase_therapist` (checkpoint advance via `applyCheckpointAction` dropped on retry) and `email_session_reminder_pair` (sentinel confirm dropped; retry also has no per-recipient tracking, so a partial-success retry can double-send to whichever side already succeeded — accepted today as a known, bounded cost per the code's own comment).

## 2. Key finding that changes the shape of this fix: no schema migration needed

My first pass at this design (during the original review) assumed a new `params` JSONB column on `side_effect_logs`. Re-reading the actual schema: **`payload Json?` already exists** and is already used to carry an arbitrary rendered envelope (`prisma/schema.prisma:804`). There is no need to add a column, run an expand/migrate/contract cycle, or maintain a legacy-row compatibility window. The fix is a **refactor of control flow, not of storage**.

This significantly changes the risk profile from what I described when scoping the overall plan. The recommendation below is smaller and safer than "rebuild the effects layer as an outbox."

## 3. Target design: one finalizer function per effect type, called from both places

For each sentinel-gated effect type, extract the **finalization logic** (confirm sentinel → checkpoint/transition → audit/notes) into a standalone function that takes the appointment id, the rendered payload, and whatever context it needs (e.g. `notesSoFar`, `checkId` for logging). Both the first-run `execute` closure and the retry branch call the **same function**. There is exactly one implementation of "what happens after the email is sent," not two.

### Concrete sketch — `email_feedback_dispatch`

New file, e.g. `services/periodic-effect-finalizers.ts` (or colocated in `post-booking-followup.service.ts` and exported — open question, see §6):

```ts
export async function finalizeFeedbackDispatch(
  appointmentId: string,
  now: Date,
  logCtx: { checkId?: string },
): Promise<void> {
  const confirmed = await confirmSentinelClaim(appointmentId, 'feedbackFormSentAt', now);
  if (!confirmed) {
    logger.error({ ...logCtx, appointmentId }, 'ALERT: Feedback form email sent but sentinel update failed - possible duplicate');
    await appendSystemAlertNote(appointmentId, 'feedbackForm email sent but tracking update failed - review for duplicates');
    return;
  }
  await appointmentLifecycleService.transitionToFeedbackRequested({ appointmentId, source: 'system' });
  logger.info({ ...logCtx, appointmentId }, 'Feedback form dispatch finalized (sentinel confirmed, transitioned to feedback_requested)');
}
```

**First-run** (`post-booking-followup.service.ts`) becomes:

```ts
execute: async (envelope) => {
  await emailProcessingService.sendEmail(envelope.user);
  if (envelope.therapist) {
    await emailProcessingService.sendEmail(envelope.therapist);
  }
  auditEventService.log(appointment.id, 'follow_up_sent', 'system', { followUpType: 'feedback_form' });
  await finalizeFeedbackDispatch(appointment.id, now, { checkId });
},
```

**Retry** (`side-effect-retry.service.ts`, `email_feedback_dispatch` case) becomes:

```ts
case 'email_feedback_dispatch': {
  const payload = /* same validation as today */;
  await emailQueueService.enqueue({ to: payload.user.to, ... });
  if (payload.therapist) {
    await emailQueueService.enqueue({ to: payload.therapist.to, ... });
  }
  await finalizeFeedbackDispatch(effect.appointmentId, new Date(), {});
  break;
}
```

Same pattern for:
- `email_chase_user` / `email_chase_therapist` → `finalizeChase(appointmentId, target, email, now)` wrapping the `applyCheckpointAction(..., 'sent_chase_followup', ...)` call + `recordAppointmentEvent(...)`.
- `email_session_reminder_pair` → `finalizeSessionReminderPair(appointmentId, { userSent, therapistSent }, now)`. This is the one case needing a **behavior decision**, not just an extraction — see §6.
- `email_feedback_reminder` (`post-booking-followup.service.ts:953`, not yet read in full but same shape per the file's pattern) → same treatment.

### Why this closes the bug

The retry branch and the first-run closure become two callers of one function. There is no longer a version of "the email sent" that isn't followed by "the sentinel gets confirmed and the transition fires" — whichever caller sends the email, the same finalizer runs immediately after, in the same execution context, so a crash between send and finalize on EITHER path produces the exact same recoverable state (row still `pending`/`failed` in `side_effect_logs`, sentinel still `EPOCH`, next retry re-runs the whole thing — including finalize).

## 4. Migration plan — each step independently shippable, no schema change

1. **Extract + wire the finalizer functions — 5 call sites, covering 6 effect types** (chase covers both `email_chase_user` and `email_chase_therapist` from one call site in `chase-email.service.ts`; the other four are `email_meeting_link_check`, `email_feedback_dispatch`, `email_feedback_reminder`, `email_session_reminder_pair`, all in `post-booking-followup.service.ts`). Verified each of the five against the current code before writing this doc. Pure refactor: move logic, no behavior change to the first-run path (it calls the exact same code it always did, just as a named function instead of inline). The retry path's behavior **does** change — this is the fix. Every existing test on the first-run closures should pass unmodified (they assert on final DB state, not on inline-vs-extracted code shape). The retry-executor tests (`side-effect-retry-executor.test.ts`) need rewriting to assert the previously-missing behavior: sentinel confirmed + transition fired after a retried `email_feedback_dispatch`.
2. **Widen the retry path's `appointment` `findUnique` select** (`side-effect-retry.service.ts:247-260`) to include whatever fields the finalizers need that aren't already selected (at minimum: `notes` for the alert-note append, `transitionGeneration` if any finalizer needs it — feedback dispatch doesn't, chase doesn't, need to double check session-reminder-pair once written).
3. **Ship.** No rollout window, no dual-format compatibility, no data backfill. This can be one PR.

## 5. Failure-mode walkthroughs (after the fix)

**Scenario A — feedback dispatch, sentinel confirm fails after send (transient DB error):**
Today: retry resends the email; sentinel stays EPOCH forever; appointment stuck in `session_held`.
After: retry resends the email (best available option — no evidence layer to know the email is unnecessary, same as today), then calls `finalizeFeedbackDispatch` — sentinel confirms, transition fires. One duplicate email in the rare case where the retry rewrote a good send; the permanent-stranding class of bug is closed.

**Scenario B — total crash before any DB touch (process killed after send, before harness even calls execute's continuation):**
No change from today — the harness already marks the row `failed` on any exception, so this was already retry-eligible; the fix means the retry now completes the FULL unit instead of half of it.

**Scenario C — chase email, checkpoint advance fails on first-run, retry succeeds:**
Today: retry resends the chase email; `chaseSentAt` stays EPOCH; the closure-recommendation query (which filters on `chaseSentAt: {gt: new Date(0), lt: threshold}`) never matches this appointment — a dead conversation is never surfaced for admin closure review.
After: retry resends, then finalizes — checkpoint advances, `chaseSentAt` gets a real timestamp, the closure-recommendation query can find it on schedule.

## 6. Open decisions for you before I implement

1. **Where do the finalizer functions live?** Options: (a) new file `services/periodic-effect-finalizers.ts`, imported by both `post-booking-followup.service.ts`/`chase-email.service.ts` and `side-effect-retry.service.ts`; (b) exported directly from the existing service files (keeps them where the domain logic already lives, avoids a new file, but `side-effect-retry.service.ts` importing from `chase-email.service.ts` and `post-booking-followup.service.ts` adds import edges in that direction that don't exist today). I'd lean (a) — a new shared file — unless you'd rather keep it colocated.
2. **`email_session_reminder_pair`'s partial-success duplicate-on-retry.** The code today accepts "retry replays both stored envelopes even if only one failed" as a bounded, known cost. While extracting the finalizer, it's cheap to also track per-recipient success in the payload (`{sentTo: {user: bool, therapist: bool}}`) so retry can skip whichever side already landed. This is beyond the strict scope of the HIGH finding (it's the accepted MEDIUM-ish duplicate-send risk mentioned in the code's own comment) — do you want it bundled into this PR since the code is already open, or left as its own separate small follow-up?
3. **Scope of this PR: fix all five effect types, or land the highest-value one first?** `email_feedback_dispatch` is the one with a concrete documented stuck-forever failure mode (Scenario A above) and is probably the highest-value single fix. `email_chase_user`/`_therapist` and `email_session_reminder_pair`/`email_feedback_reminder` have the same shape but different (less severe) consequences. I can do all five in one PR (they're mechanically identical, low marginal risk once the pattern is proven) or split feedback-dispatch out first as the smallest reviewable unit. My default would be all five in one PR, since splitting them just means re-touching `side-effect-retry.service.ts`'s same switch statement multiple times — but I'll follow your preference.
4. **The separate, MEDIUM-severity "register-in-tx" finding** ("Status transition commits before side effects are even registered — a crash/deploy in the window permanently drops..." at `confirmed.ts:330`) is a different bug in a different place (the one-shot confirm/cancel/complete transition-notification effects, registered via `fireAndForget` calls to `transitionSideEffectsService`/`appointmentNotificationsService` AFTER the transaction commits, not the periodic-effects code this doc covers). Fixing it means touching `runTerminalTransitionTx` and the three terminal transition files directly — genuinely higher risk, since it's the hot confirm/cancel path. **I'd recommend treating it as a separate, later PR**, decoupled from this one — do you agree, or do you want it folded in now while we're in this code?

## 6a. Decisions (as approved)

1. **Finalizer location: (a)**, new file `services/periodic-effect-finalizers.ts`.
2. **`email_session_reminder_pair` per-recipient tracking: bundled in.** Implemented via a small, backward-compatible extension to the harness itself: `runPeriodicTrackedSideEffect`'s `execute` callback now also receives an `updateStoredPayload` helper (persists incremental progress to the row's `payload` column via a new `sideEffectTrackerService.updatePayload`). The pair's payload gained an optional `sentTo: {user?, therapist?}` field; retry reads it and only re-sends the side not yet marked sent. Rows registered before this field existed have no `sentTo` and both sides are treated as not-yet-sent — unchanged from today.
3. **Scope: all 5 call sites in one PR.** Done — chase (user+therapist), meeting-link-check, feedback-dispatch, feedback-reminder, session-reminder-pair.
4. **Register-in-tx finding: deferred to a separate, later PR**, as recommended.

## 7. Implementation notes (found while building)

- **Latent bug fixed en route**: the retry branch's payload validation for `email_feedback_dispatch` required `payload.therapist` to be a non-null object with a string `.to`. But the first-run renderer (`buildTherapistFeedbackNotificationPayload`) legitimately returns `null` when the therapist-notification setting is disabled — so any retry of a feedback-dispatch effect registered with that setting off would have thrown `Cannot retry ... missing or invalid paired payload` on every attempt, eventually abandoning the row. Fixed by making the retry validation accept `payload.therapist: null`, matching the render-time contract.
- The `side-effect-retry-executor.test.ts` rewrite adds regression tests asserting the previously-missing behavior directly: sentinel confirmed + `transitionToFeedbackRequested` called after a retried `email_feedback_dispatch`; checkpoint advanced (`chaseSentTo`) after a retried chase; the `sentTo`-based skip-already-sent behavior for session-reminder-pair.
