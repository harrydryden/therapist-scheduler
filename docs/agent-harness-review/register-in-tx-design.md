# Design: closing the register-in-tx crash window for confirm/cancel/complete

Status: **draft — for review before any implementation.**

This is finding #10 from `docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md`, the last of the three items deferred out of the original refactor pass. Per the review's own note (`stage-b-design.md` §6 open decision 4), this was intentionally kept separate from Stage B because it touches the hot confirm/cancel/complete path directly, not the periodic-effects code Stage B covered.

## 1. What's actually broken (re-verified against current code)

> Status transition commits before side effects are even registered — a crash/deploy in the window permanently drops confirmation/cancellation emails, Slack, and therapist freeze sync.

Only the appointment-creation flow has a true outbox today: `justintime_start` is registered *inside* the creation transaction (`appointments.routes.ts:463-468`, via `sideEffectTrackerService.registerInTransaction`). Every lifecycle transition instead registers its side-effect rows *after* commit, inside a fire-and-forget background task:

- **`confirmed.ts`**: `prisma.appointmentRequest.update(...)` commits the status (line 196) → two awaited audit writes (275-294) → `fireAndForget(transitionSideEffectsService.onConfirmed(...))` (310-321) and `fireAndForget(appointmentNotificationsService.notifyConfirmed(...))` (330-346). `notifyConfirmed` awaits a settings query, then for each email calls `runReplayableTrackedSideEffect`, whose `runBackgroundTask` body renders the payload (timezone lookup + settings + template load — multiple DB round-trips) and *only then* registers the row (`side-effect-harness.ts:209-224`).
- **`cancelled.ts`**: same shape, dispatched after `runTerminalTransitionTx` commits (219-258).
- **`completed.ts`**: same shape (124-164) — Slack-only, no emails today.

A process exit (deploy SIGKILL, OOM, crash) anywhere between the status commit and the side effect's registration leaves the transition permanently committed with zero durable record that a notification was ever due. The retry runner has nothing to pick up — the row doesn't exist yet. If registration itself later fails, the harness deliberately degrades to a single untracked attempt (`side-effect-harness.ts:70-79`); a render failure registers nothing at all.

**Failure scenario:** Agent confirms a booking; the row flips to `confirmed`; the process is killed by a deploy 200ms later, before the confirmation-email rows are registered. Neither party ever receives a confirmation email, no `side_effect_logs` row exists, no retry, no alert. The appointment proceeds toward `session_held` on schedule while both humans believe nothing was booked.

## 2. Key finding that changes the shape of this fix: no schema migration needed

Same discovery as Stage B. I assumed this would need a new `params`/intent column. It doesn't:

- `sideEffectTrackerService.registerInTransaction(tx, appointmentId, transition, effect, transitionGeneration?)` already exists and is fully generic — it's the exact primitive `appointments.routes.ts` uses for `justintime_start`. It just needs to be called from three more places.
- The `payload Json?` column already exists and already supports being set *after* registration via `sideEffectTrackerService.updatePayload(idempotencyKey, payload)` — built for `email_session_reminder_pair`'s incremental-progress tracking in Stage B. The same helper covers "register intent now, fill in the rendered payload once it's computed" with no new column.

This is a refactor of **sequencing**, not of storage.

## 3. Second key finding: the post-commit path needs almost no changes, because idempotency keys already de-duplicate

`registerSideEffects` / `registerTherapistSideEffects` already treat "a row with this idempotency key already exists" as a no-op: they look it up and return the existing row instead of creating a second one (`side-effect-tracker.service.ts:296-318`). The idempotency key is a deterministic hash of `(appointmentId, transition, effectType, transitionGeneration?)` — no randomness, no dependency on *when* it's computed.

That means: if we pre-register a row **inside** the transition transaction using the same `(appointmentId, transition, effectType, transitionGeneration)` the post-commit code will later hash, the existing post-commit call to `registerSideEffects` inside `runReplayableTrackedSideEffect` / `runTrackedSideEffect` will find that row and silently reuse it. **`side-effect-harness.ts`, `appointment-notifications.service.ts`, and `transition-side-effects.service.ts` need zero changes.** The fix is close to purely additive: new pre-commit registration calls, plus one gap described in §4.

This is the main reason I think the risk here is lower than the review's original framing ("highest-risk PR of the plan") suggested — verified by re-reading the actual idempotency-key logic before writing this doc, not assumed.

## 4. The one real gap: retry must handle a pre-render crash

Today, `side-effect-retry.service.ts`'s `email_client_confirmation` / `email_therapist_confirmation` / `email_client_cancellation` / `email_therapist_cancellation` branches **throw** if `payload` is null or malformed (lines 372-380 etc.) — this is currently unreachable in practice, since `runReplayableTrackedSideEffect` always registers *with* a payload (render happens before register). The comment says "registration predates payload support," a defensive guard for a case that doesn't occur today.

Once we pre-register these rows before render, that stops being true: a crash between the transaction commit and the post-commit render will leave a row `pending`, `attempts: 0`, `payload: null`. `getEffectsToRetry`'s existing "stale pending, never attempted" bucket (already built for the `justintime_start` outbox pattern, 10-minute cutoff) will surface it — and today's code would throw immediately, burning the row's 5-attempt budget almost instantly and abandoning it with an unhelpful error.

**Fix:** for exactly these four effect types, treat `payload === null` as "never rendered — render fresh now" instead of "corrupt/legacy — throw." This is safe specifically because a null payload for these types is now unambiguous: it can only mean "registered pre-commit, crashed before the original render/send ever ran," so there's no send to duplicate and no "settings drifted since the original render" concern (there was no original render).

Concretely: extract the four `renderPayload` closures currently inline in `appointment-notifications.service.ts`'s `notifyConfirmed`/`notifyCancelled` into standalone exported functions (mirrors Stage B's `periodic-effect-finalizers.ts` extraction — one function, two callers):

```ts
// services/transition-email-renderers.ts (new file)
export async function renderClientConfirmationEmail(params: {
  userEmail: string; userName: string | null; therapistName: string | null;
  confirmedDateTime: string; confirmedDateTimeParsed: Date | null | undefined;
}): Promise<{ to: string; subject: string; body: string }> { /* body moved verbatim from notifyConfirmed */ }
// + renderTherapistConfirmationEmail, renderClientCancellationEmail, renderTherapistCancellationEmail
```

- **Original call site** (`notifyConfirmed`): `renderPayload: () => renderClientConfirmationEmail({...})` — pure extraction, no behavior change.
- **Retry fallback** (`side-effect-retry.service.ts`): when `effect.payload` is null for one of these four types, call the matching renderer with data re-fetched from the appointment row (already fetched at the top of `executeEffect`), persist the result via `sideEffectTrackerService.updatePayload(effect.idempotencyKey, payload)` (so a *second* crash mid-retry doesn't re-render again), then proceed exactly like the existing payload path (enqueue, no finalizer needed — these are one-shot, not sentinel-gated).

No-payload effect types (`slack_notify_*`, `therapist_freeze_sync`, `therapist_unfreeze_sync`) need **no retry-executor changes at all** — they already re-derive entirely from the DB row, both today and after this fix.

## 5. Structural difference between the three transitions — this is where the real risk is

`cancelled.ts` and `completed.ts` already run inside `runTerminalTransitionTx`'s `prisma.$transaction(..., { isolationLevel: Serializable, timeout: 10000 })`. Adding intent registration there means adding one new hook to a transaction that already exists:

```ts
// terminal-tx.ts — new optional hook on RunTerminalTransitionTxArgs
registerEffects?: (tx: Prisma.TransactionClient, row: TRow, postUpdateGeneration: number) => Promise<void>;
```

Called right after the audit-event insert, before the transaction returns. Low risk — no new transaction, no new isolation level, just more statements inside a lock scope that's already held for a similarly-shaped set of writes.

`confirmed.ts` is different: it is **not** currently wrapped in `$transaction` at all. Its atomicity comes from a single `prisma.appointmentRequest.update()` call whose `where` clause encodes every precondition (source status, "not already at target," optional human-control/atomic-status guards) — one UPDATE statement, no explicit transaction, no row lock beyond what Postgres does internally for that statement. To register side-effect rows atomically with this commit, the update itself must move inside an explicit `$transaction`:

```ts
const { updated, registeredEffects } = await prisma.$transaction(async (tx) => {
  const updated = await tx.appointmentRequest.update({ where: whereClause, data: updateData, select: { transitionGeneration: true } });
  const registeredEffects = await registerConfirmedIntents(tx, appointmentId, updated.transitionGeneration, { sendEmails, /* which effects apply */ });
  return { updated, registeredEffects };
});
```

The existing P2025 (`RecordNotFound`) catch-and-reclassify logic (atomic-skip / idempotent-skip / invalid-transition — lines 203-271) needs to move *inside* the transaction callback too (catching the error there and returning a discriminated result, rather than letting `$transaction` reject and catching outside it) so the re-fetch used to attribute the failure reads via the same `tx` client — this is actually a small consistency *improvement* over today (today's re-fetch is a fresh, non-transactional `prisma.appointmentRequest.findUnique` racing against whatever else is happening to the row).

**Isolation level recommendation: do not escalate to Serializable.** `confirmed.ts`'s concurrency safety today comes entirely from the WHERE-clause preconditions on a single UPDATE, not from Serializable isolation — there's no multi-statement read-then-write race to protect against beyond what those preconditions already close. Wrapping the same update (plus new insert statements that don't read any contested state) in a plain `$transaction` at Prisma's default (Read Committed) isolation preserves today's safety without introducing a new failure class. Serializable transactions can throw serialization-conflict errors under concurrent load that today's code has never had to handle — I don't think we should add that risk to the highest-traffic transition for no corresponding safety gain. Flagged as an open decision below in case you'd rather match `terminal-tx.ts` for consistency.

## 6. Idempotency-key continuity (must-not-break)

The pre-commit registration call must generate **exactly** the idempotency key the existing post-commit code will later compute, or we get two rows (a leaked duplicate, not a crash-safety win). Concretely:

- `slack_notify_confirmed`, `email_client_confirmation`, `email_therapist_confirmation`: keyed on `(appointmentId, 'confirmed', effectType, transitionGeneration)` — `transitionGeneration` **is** included today (confirmed.ts threads `postUpdateGeneration` into `notifyConfirmed`). The in-tx call must use the same post-update generation.
- `therapist_freeze_sync` (via `transitionSideEffectsService.onConfirmed`): keyed on `(appointmentId, 'confirmed', 'therapist_freeze_sync')` — **no** `transitionGeneration` today (`transition-side-effects.service.ts`'s call to `runTrackedSideEffect` doesn't pass one). The in-tx registration for this one must also omit it, or it'll mismatch and duplicate. Same asymmetry applies to `therapist_unfreeze_sync` in `cancelled.ts`/`completed.ts`.
- Mirror this per-effect-type generation-or-not choice exactly for `cancelled.ts` (`slack_notify_cancelled`, `email_client_cancellation`, `email_therapist_cancellation`, `therapist_unfreeze_sync`) and `completed.ts` (`slack_notify_completed`, `therapist_unfreeze_sync`).
- Conditional effects (e.g. `email_therapist_cancellation` only fires if `therapistGmailThreadId` is set; `email_therapist_confirmation` only if `therapistEmail` is set; Slack notifications gated on settings) must apply the **same** conditions at pre-commit registration time that the post-commit code applies — otherwise we'd register a row for an effect that will never actually be dispatched (harmless but noisy — it'll sit `pending` forever) or, worse, skip registering one that later does fire (recreates today's gap for that specific case). Settings-gated conditions (Slack toggles, email toggles) are the trickier ones: they're fetched via `getNotificationSettings()` in the notifications service today, after commit. Pre-commit registration would need to fetch settings *before* the transaction (outside the tx, cached/short-lived) to decide which rows to register — a settings flip between pre-commit registration and post-commit dispatch is an acceptable, bounded edge case (matches the existing "no schema migration" philosophy of not over-engineering this).

## 7. Migration plan — phased, each step independently shippable

1. **Extend `runTerminalTransitionTx` with the `registerEffects` hook.** Pure addition, opt-in, no existing callers affected until they pass it.
2. **Wire `cancelled.ts` and `completed.ts`** to register their intents (Slack + email + freeze-sync rows) via the new hook, using the generation math already computed in each file today. Lower risk — no new transaction, no isolation change.
3. **Extract the four email-render closures** into `services/transition-email-renderers.ts`; wire `appointment-notifications.service.ts`'s `notifyConfirmed`/`notifyCancelled` to call them (pure extraction, no behavior change — same pattern and same low risk as Stage B's finalizer extraction).
4. **Add the null-payload render-fresh fallback** to `side-effect-retry.service.ts`'s four email branches, using the extracted renderers + `updatePayload`.
5. **Ship steps 1-4 as one PR.** This closes the crash window for `cancelled` and `completed` entirely, and de-risks the harder step by proving the renderer-extraction + retry-fallback pattern against two transitions first.
6. **Separately: restructure `confirmed.ts`** into an explicit `$transaction` (Read Committed, per §5) wrapping the update + P2025 handling + intent registration. Ship as its own PR once step 5 has had time to prove out in production — this is the one piece that changes control flow on the hottest transition, so it gets the most isolated blast radius and the easiest revert if something's off.

## 8. Failure-mode walkthroughs (after the fix)

**Scenario A — crash 200ms after `confirmed.ts` commits (the review's original scenario):**
Today: nothing registered, silent total loss.
After: the status update + intent registrations for `slack_notify_confirmed`, `email_client_confirmation`, `email_therapist_confirmation`, `therapist_freeze_sync` all commit atomically in the same transaction as the status flip. The process dies before the post-commit `fireAndForget` calls even start. The rows sit `pending`/`attempts: 0`. The retry runner's stale-pending bucket picks them up after 10 minutes, renders fresh (client/therapist emails) or re-derives from DB (Slack, freeze-sync), and completes. One 10-minute delay, zero silent loss.

**Scenario B — crash during render, after intent registered (e.g. mid-`notifyConfirmed`, timezone lookup succeeds, template load throws):**
Today: nothing registered (render precedes register) — same total loss as scenario A.
After: the row already exists (registered pre-commit) with `payload: null`. Retry picks it up, renders fresh, proceeds — recoverable.

**Scenario C — crash after render succeeds, before the harness's own registration call (today) / before send (after fix):**
After the fix, "registration" isn't a separate step anymore for these rows — it already happened pre-commit. So this scenario collapses: render succeeds, `updatePayload` persists it (recommended addition, see §9.2), and if the process dies before `execute` sends the email, retry finds a `pending` row *with* a payload already and replays it verbatim — no re-render needed, matching the existing non-crash retry contract exactly.

## 9. Open decisions for you before I implement

1. **Isolation level for `confirmed.ts`'s new transaction.** I recommend Read Committed (Prisma's default), not Serializable — see §5's reasoning. Do you agree, or would you rather match `terminal-tx.ts`'s Serializable for consistency even though I don't think it's load-bearing here?
2. **Persist the payload immediately after render, before send.** Cheap addition (`updatePayload` right after `renderPayload` resolves, before `execute` runs) that closes Scenario C above completely rather than leaving a small window where a crash between render and send forces a re-render. I'd bundle this in since the file is already open for the extraction in step 3. Agree?
3. **Settings-gated conditional registration (§6, last paragraph).** Pre-commit registration decides which effect types to register based on notification settings fetched *before* the transaction; a settings toggle flipped in the narrow window between that fetch and the post-commit dispatch is a bounded, accepted edge case (worst case: one row sits `pending` forever with nothing to execute against it, or very rarely the reverse — a toggle flipped on mid-flight means that email won't get an intent row this one time, same as today's total gap but only for the toggle-flip window instead of the whole crash window). Acceptable, or do you want a stronger guarantee here (e.g. re-check settings inside the transaction too)?
4. **Scope/sequencing: two PRs (terminal transitions first, `confirmed.ts` separately) as proposed in §7, or do you want it all in one PR?** My default is two PRs — it lets the lower-risk half (cancelled/completed, no new transaction) prove the pattern before the higher-risk half (`confirmed.ts`'s structural change) ships.
5. **File organization.** Should `transition-email-renderers.ts` live next to `appointment-notifications.service.ts` (current flat `services/` layout) or should this be the moment `appointment-notifications.service.ts` + `transition-side-effects.service.ts` move into `domain/scheduling/lifecycle/` (mentioned as a possible follow-up in earlier planning)? I'd treat the file move as out of scope for this PR — bundling a directory move with a transactional-behavior change makes the diff harder to review and revert independently. Agree it should stay deferred?

Approved as written (all five recommendations accepted) — implementation follows in §10.

## 10. Implementation notes (found while building Phase 1)

Phase 1 (steps 1-4 above) is implemented: `terminal-tx.ts`'s new `registerEffects` hook, `cancelled.ts` + `completed.ts` wired to it, the four renderers extracted to `transition-email-renderers.ts`, and the null-payload fallback added to `side-effect-retry.service.ts`. `confirmed.ts` is untouched (Phase 2, separate PR, per decision 4).

- **A gap not caught until implementation: the two cancellation email types can't simply render "fresh from the appointment row" on a null payload.** `renderClientCancellationEmail`/`renderTherapistCancellationEmail` branch on `cancelledBy` and interpolate `reason` — neither is a durable `appointmentRequest` column (only baked into the `notes` prepend as a human-readable string in `cancelled.ts`'s `buildUpdateData`). A truly-null payload therefore isn't enough to re-render a cancellation email; the confirmation emails don't have this problem (everything they need — `confirmedDateTime`, names, emails — is already on the row).

  Fixed by having the two cancellation registrations in `cancelled.ts`'s `registerEffects` pass a small `payload: { cancelledBy, reason }` at registration time — not the final rendered envelope, just enough render *context* to reconstruct it later. `side-effect-retry.service.ts` distinguishes the two payload shapes structurally (`isRenderedTransitionEmail` checks for `to`/`subject`/`body`; anything else is treated as render context, or absent context for the confirmation types which don't need any). This is still "no schema migration" — it's the same `payload Json?` column, just holding a smaller shape before the first real render, exactly like Stage B's `updatePayload`-based incremental-progress pattern for `email_session_reminder_pair`.

- **`registerSideEffects` doesn't update an existing row's payload.** When the post-commit dispatch code (`runReplayableTrackedSideEffect`) calls `registerSideEffects` and finds a row already registered (by idempotency key — exactly the pre-commit case), it returns the existing row as-is; it does not overwrite the row's `payload` column with the freshly-rendered envelope. Left alone, this would mean a successfully-sent confirmation/cancellation email's `side_effect_logs` row keeps its small pre-commit render-context (or `null`) forever, instead of the full envelope actually sent — breaking the "replay verbatim" contract for any future retry of that row. Fixed per decision 2 (§9.2): `runReplayableTrackedSideEffect` now calls `sideEffectTrackerService.updatePayload(reg.idempotencyKey, payload)` immediately after registration succeeds, unconditionally (harmless redundant write for the still-not-pre-registering `confirmed.ts` path too).

- **Verification:** `npm run typecheck` / `npm run lint` clean. Full backend suite: 1712 passed (up from 1694 pre-Phase-1), 0 failures. New coverage: `run-terminal-transition-tx.test.ts` (registerEffects hook wiring), `register-in-tx-cancelled-completed.test.ts` (which effect types register under which settings/skipNotifications/missing-thread scenarios, and the per-effect-type generation-or-not + payload-or-not shape), `side-effect-harness-replayable.test.ts` (payload persisted after render regardless of new-vs-existing row), and four new cases in `side-effect-retry-executor.test.ts` (verbatim replay vs. render-fresh-and-persist for both confirmation and cancellation types, plus the missing-render-context throw).
