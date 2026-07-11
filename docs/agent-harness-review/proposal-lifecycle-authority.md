# LIFECYCLE-AUTHORITY REARCHITECTURE — proposal (state-machine angle)

## 0. Verdict up front (honesty requirement)

At ~100 appointments/day the three-legged vision splits sharply by ROI:

1. **All status writes through `domain/scheduling/lifecycle/`** — already 95% true (one confirmed bypass: `appointments.routes.ts:580`). Cheap to finish, high value. **Do it.**
2. **Transactional outbox subsuming harness/tracker/retry** — justified, but not for throughput reasons. Justified because *four confirmed findings are symptoms of one structural flaw*: every effect has TWO implementations (the inline closure at the transition site, and a hand-mirrored per-effectType branch in `side-effect-retry.service.ts`), and registration happens *after* commit. The retry-executor-drops-finalization bug (HIGH), the register-after-commit crash window (MEDIUM), the stale-generation double-fire (MEDIUM), and the chase generation-stranding (MEDIUM) are all instances. Fixing them individually re-patches each effect type; the outbox fixes the class. **Do it, but by evolving `side_effect_logs`, not adding a table.**
3. **10+ periodic services → declarative rules engine** — **rejected as scoped.** `stale-check.service.ts` (982 lines) is heterogeneous business logic, not rule-shaped; a DSL rich enough to express it is a worse programming language than TypeScript. The real duplication is *scaffolding* (5 services hand-roll `LockedPeriodicService`, chase hand-rolls `sentinel-batch-runner`). Consolidate the scaffolding; keep the logic imperative.

## 1. Target architecture

```
domain/scheduling/lifecycle/          ← unchanged public API (appointmentLifecycleService)
  transitions/*, terminal-tx.ts, ...  ← transitions now REGISTER effect-intent rows
                                        inside the same tx/atomic-write as the status flip
  effects/                            ← NEW (absorbs services/transition-side-effects.service,
    registry.ts                          side-effect-harness.ts, the executor half of
    handlers/<effectType>.ts             side-effect-retry.service.ts, and the notification
                                         dispatchers' per-effect bodies)
    outbox.ts                         ← thin API over side_effect_logs (evolved tracker):
                                         registerInTx(tx, scope, effectType, params, generation)
                                         supersede(scope, effectType, olderThanGeneration)
    drain.service.ts                  ← THE ONE runner (LockedPeriodicService, 30s cadence,
                                         + post-commit in-process poke for low latency)
services/side-effect-tracker.service.ts  ← shrinks to claim-lease/mark/query internals, then folds in
services/side-effect-retry.service.ts    ← deleted (justintime_start + freeze-sync guards move
                                            into their handlers)
utils/locked-periodic-service.ts      ← the ONLY periodic scaffold; all 10+ runners subclass it
services/sentinel-batch-runner.ts     ← the ONLY claim→schedule→release loop; chase migrates onto it
```

**Ownership of currently-duplicated concepts:**

| Concept | Today (duplicated) | Target owner |
|---|---|---|
| Effect execution logic | inline closure + retry-branch per effectType | one handler per effectType in `lifecycle/effects/handlers/` — same code path on first drain and retry, so sentinel-confirm + `transitionToFeedbackRequested` can never be dropped |
| Effect durability | post-commit render→register (crash window) | intent row inserted in the transition tx; payload rendered at first drain, persisted, replayed verbatim on retry (keeps the settings-drift protection) |
| Generation supersession | none (orphaned failed rows replay) | `registerInTx` abandons older-generation pending/failed rows for the same (scope, effectType); every handler re-checks appointment state before send |
| Periodic scaffolding | LockedPeriodicService ×6 + 5 hand-rolled + 1 bare setInterval | LockedPeriodicService for all; `PeriodicService.isRunning` guard everywhere |
| Sentinel loop | sentinel-batch-runner ×4 + chase inline | sentinel-batch-runner; `cleanupStuckSentinels(fields, olderThan)` + `EPOCH_SENTINEL` in atomic-sentinel-claim.ts |
| Terminal/active status sets | inline literals ×4+ | `TERMINAL_STATUSES` + a named `ACTIVELY_NEGOTIATING_WHERE` fragment beside update-fragments.ts |
| Status writes | lifecycle + 1 raw bypass | lifecycle only, enforced by lint + unit test |

**Explicit non-goals:** SSE `notifyTransition` stays fire-and-forget (losing an SSE ping is fine); Slack alerts that are pure telemetry stay untracked; BullMQ email-send queue stays as-is (it is already a durable queue — the outbox hands envelopes to it, it does not replace it).

## 2. Migration phases (each one PR; hardening first)

**PR-1 — Correctness batch: dead/broken recovery paths (no moves).** Fix the three `"AppointmentRequest"` raw-SQL sites → `appointment_requests` + snake_case (email-queue.service.ts:401, core/email/outbound/queue.ts:241, core/email/inbound/divergence-handling.ts:102); fix `send_user_email/send_therapist_email` → `send_email` filter (ai-conversation.service.ts:471, justin-time.service.ts:162); collapse startScheduling's inline save loop onto `storeConversationStateWithRetry` with `expectedUpdatedAt` made optional; make startScheduling return failure when the final save fails (finding says current success-return is a bug: outbox row must NOT be marked completed → retry re-drives, guarded). Files: 5. Risk: low — all paths are currently dead or throwing. Verify: `prisma-schema.integration.test.ts` gains a raw-SQL-table-name assertion; new unit tests for compensation filter and startScheduling failure propagation; existing `justin-time-outbox.test.ts` covers the outbox marking.

**PR-2 — Correctness batch: mid-turn races.** (a) Per-appointment turn mutex (Redis, TTL+renewal like the message lock) wrapped around `processEmailReply`/`startScheduling` — serializes concurrent turns, which makes the ConcurrentModificationError path genuinely exceptional; then change `checkpointBeforeSideEffects` to *abort the turn* (leave the Gmail message unprocessed for the scanner) instead of adopting the newer version; make `processEmailReply` return failure when the final save fails. (b) Add `status: { notIn: TERMINAL_STATUSES }` to the send-gate `updateMany` in `core/agent/tools/send.ts:117` and dispatch.ts:104. (c) Break the tool loop on `skipReason === 'human_control'`, and make `flagForHumanReview` not clobber an existing human-takeover record. Files: ~6. Risk: medium — (a) changes liveness (a stuck turn delays the next by lock TTL); mitigate with the existing lock-renewal manager + 5-min cap. Verify: existing `agent-tool-loop-safety-circuits.test.ts`, `paused-message-not-marked.test.ts`, `process-email-reply-terminal-skip.test.ts`; add a two-concurrent-turns test asserting loser aborts unmarked, and a mid-turn-cancel test asserting send-gate refusal.

**PR-3 — Outbox core: register-in-tx + handler registry for transition effects.** Add `params` JSONB (expand-only migration) to `side_effect_logs`. `terminal-tx.ts` and `confirmed.ts` insert intent rows inside their existing tx; light transitions wrap `updateMany`+`createMany` in an interactive tx (insert only when count=1). Build `effects/registry.ts` with handlers for the confirmed/cancelled/completed effect set (confirmation emails, cancellation emails, Slack, freeze-sync — bodies lifted verbatim from transition-side-effects.service + appointment-notifications + the retry branches). `drain.service.ts` = renamed side-effect-retry runner + post-commit `setImmediate` poke (replaces `fireAndForget` dispatch; keeps user-visible latency at ~0). Keep old-format rows drainable during rollout (registry falls back to legacy branches for rows without `params` until the table ages out — retention already deletes at 24h/terminal). Risk: **highest of the plan** — interactive tx on the confirm hot path; behavior preserved except the crash window closes (that is the point). Verify: `side-effect-generation.test.ts`, `side-effect-claim-lease.test.ts`, `transition-side-effects-terminal.test.ts`, `run-terminal-transition-tx.test.ts`, `lifecycle.integration.test.ts` all must pass unmodified in assertion intent; add: kill-between-commit-and-drain test (row exists, drain completes it), render-once-replay-verbatim test.

**PR-4 — Sentinel-gated periodic effects onto the outbox.** Chase, meeting-link-check, session-reminder-pair, feedback-dispatch, feedback-reminder, therapist-nudge: sentinel claim + intent-row insert become one tx; handler owns the FULL sequence (state re-check → send → `confirmSentinelClaim` → checkpoint/`transitionToFeedbackRequested`), identical on retry — **this is the fix for the HIGH half-replay finding.** Chase passes claim-epoch as `scopeGeneration` (fixes dedupe-stranding); `registerInTx` supersedes older-generation rows (fixes walk-back double-fire); delete the per-effectType retry branches. Risk: medium; behavior change only where findings say behavior is a bug. Verify: `side-effect-retry-executor.test.ts` rewritten against the registry (assert sentinel-confirm + transition happen on the retry path — the previously-missing assertions); `chase-presend-stage-scope.test.ts`, `thread-chase-eligibility.test.ts`, `sentinel-batch-runner.test.ts`, `periodic-tracked-side-effect.test.ts` preserved.

**PR-5 — Scaffolding consolidation (mechanical).** Migrate therapist-nudge, missed-message-scanner, pending-email, slack-weekly-summary, work-report (+ the bare Slack setInterval) onto LockedPeriodicService; migrate chase's loop onto sentinel-batch-runner; add `cleanupStuckSentinels` + kill all `new Date(0)` literals; also fix LockedTaskRunner's timeout-releases-lock zombie (release only after the task settles; timeout just alerts). Named status-set fragments replace inline literals (stale-check.service.ts:326/478, admin-force.ts:187/201). Risk: low, ~40-60 lines deleted per service. Verify: `atomic-sentinel-claim.test.ts`, `therapist-nudge-send.test.ts`; add a LockedTaskRunner zombie-overlap regression test.

**PR-6 — Close the authority loop.** Route `appointments.routes.ts:580` through lifecycle (or give it generation-bump+audit via a lifecycle `resetToPendingAfterStartFailure` entry point); add ESLint (`import/no-restricted-paths`) — none exists today despite `package.json`'s lint script — banning status-field writes outside `domain/scheduling/lifecycle/` (enforce via a unit test that greps `data:\s*{[^}]*status:` outside lifecycle, since ESLint can't see Prisma field names); fold `transition-side-effects.service.ts` remnants into `lifecycle/effects/`; update lifecycle/README + core/README layouts. Risk: trivial.

## 3. Divergences from docs/REFACTOR_PLAN.md, and why

1. **The plan's Phase-2a follow-up says "move transition-side-effects into lifecycle" as a low-priority file move.** I replace the move with a semantic change (tx-registered outbox + single handler path). Reason: three confirmed CONFIRMED findings show the current fire-and-forget + mirrored-retry design is broken in ways a file move preserves.
2. **The plan defers everything reliability-shaped under "multi-instance readiness (out of scope)".** The outbox is not multi-instance work — it is single-instance crash/deploy safety (SIGKILL between commit and register currently drops confirmation emails silently). Deferring it mis-files a live bug class under a deferred scaling concern.
3. **No new tables, contra the plan's appetite for schema surgery elsewhere.** Phase 3's own audit logic ("expand-only, dual-compatible, contract later") is applied here: `side_effect_logs` *is* the outbox; it gains one JSONB column.
4. **Lint rule timing.** The plan gated the kernel lint rule on Phase 1c and never added it. I decouple: the *status-write* boundary rule lands in PR-6 regardless of the core/-vs-domain relocation dispute (which other findings show needs its own plan), because the lifecycle boundary is enforceable today with zero relocations.
5. **Dedup-callsite migration item 4 (chase → `isMessageProcessed`)** is subsumed by PR-4 rather than done as its own PR.
6. **I add correctness PRs (1-2) that appear nowhere in the plan.** The plan sequences by module geography; the confirmed findings say the highest-risk defects (last-writer-wins state saves, half-replayed retries, always-throwing recovery SQL) are orthogonal to geography and must land first.

## 4. Honest costs and risks of this angle

- **PR-3 is real surgery on the confirm path.** Interactive transactions around `updateMany`-with-RETURNING patterns are easy to get subtly wrong (tx client vs global client, serialization retries already exist in terminal-tx). Budget: this PR alone is comparable in risk to all of Phase 2 combined. Mitigation is the fallback-drain compatibility window and the fact that the drain runner is additive before the inline dispatch is removed (two-step within the PR history: register-in-tx + keep inline execute behind the claim-lease, then switch to poke-the-drainer).
- **Latency regression surface:** confirmation Slack/emails move from "setImmediate after commit" to "poke or ≤30s drain tick". At 100/day nobody will notice, but it must be stated: the drain poke is in-process and best-effort; the 30s tick is the guarantee.
- **Test churn:** `side-effect-retry-executor.test.ts` (the largest test in this area) is asserting the buggy split design and must be rewritten, temporarily reducing regression confidence exactly where risk is highest. The new kill-window and replay tests must land in the same PR, not after.
- **The rejected rules-engine leg means stale-check stays a 982-line service.** That is a deliberate trade: its complexity is essential (business policy), not accidental (scaffolding). If someone later wants it decomposed, that is a readability refactor, not an architecture one.
- **Turn mutex (PR-2) trades throughput for correctness:** two messages on one appointment now process serially (~1-2 min each). At this volume that is correct behavior (the second message should see the first's state), but a pathological stuck turn delays follow-ups until TTL expiry; the Slack alert on lock-wait timeout should be added with it.
- **Total effort:** ~6 PRs, the middle two substantial. If capacity forces triage: PR-1 and PR-2 are non-negotiable (live bugs); PR-4 delivers the highest finding-density payoff; PR-3 is the enabling cost of PR-4; PR-5/6 are opportunistic.