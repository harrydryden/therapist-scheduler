# KERNEL-FIRST RESTRUCTURE PROPOSAL — therapist-scheduler backend

Premise: the current REFACTOR_PLAN moved code *into* `core/` by god-module lineage, not by the kernel rules `core/README.md` states. Result: `core/agent/tools` and `core/email/inbound` are the scheduling product's brain sitting inside the "generic kernel" (confirmed boundary findings), the lint rule is now impossible to add, and the concepts that actually needed a single owner (side-effect retry, periodic runners, idempotency, escalation) each have 2–5 competing implementations. This proposal fixes the target first, then derives the sequence — with bug-fix hardening for the confirmed high findings landing before any file moves.

---

## 1. Target architecture

**Rule restated: `core/` = mechanism, parameterized by interfaces. `domain/scheduling/` = policy. Nothing in `core/` names an appointment.**

```
core/
  agent/                      ONE agent harness (both loops collapse into it)
    loop.ts                   generic tool loop: iterations, ToolTurnGuard, caching seam,
                              stop conditions supplied by config — no tool names hardcoded
    registry.ts               ToolTable type: per tool ONE object {name, zodSchema, anthropicSchema,
                              handler, isPure, triggersCheckpoint, stagePolicy, isTerminal}
                              — kills the four hand-synced string sets (SIDE_EFFECT_TOOLS,
                              tools-for-stage lists, dispatch switch, schema files)
    dispatch.ts               generic pipeline: pure-bypass → guardHooks[] (domain-supplied:
                              human-control gate, tool ceiling) → idempotency → handler → mark
    idempotency.ts            the ONE fail-closed Redis module, parameterized by key prefix
                              (availability copy deleted)
    escalation.ts             the shared escalate(reason, bucket) block (turn breaker, error
                              breaker, iteration ceiling) — 6 copy-paste sites become 1
  email/                      TRANSPORT ONLY: gmail send/receive, MIME, tracking-code stamping,
                              thread-ID write-back (both direct AND queue paths), BullMQ queue,
                              polling primitives, message-dedup (moves from core/messaging)
  runner/                     ONE background-runner harness: PeriodicService + LockedPeriodicService
                              (fixed zombie-overlap semantics), atomic-sentinel-claim (owns
                              EPOCH_SENTINEL + cleanupStuckSentinels(fields, olderThan)),
                              sentinel-batch-runner
  effects/                    ONE durable-effect layer: tracker + harness + retry runner rebuilt as a
                              real outbox: register-in-tx option, named-executor registry (domain
                              registers executors at startup; retry replays the FULL unit incl.
                              sentinel confirm + lifecycle finalize), generation-scoped keys
                              MANDATORY (no 4-arg overload), supersede: registering generation G+1
                              abandons G's pending/failed rows for the same (scope, effectType)
  timezone/, messaging/       as today (prompt-section loses its SchedulingContext type — takes a
                              plain {userCountry, therapistCountry, ...} shape)

domain/scheduling/
  agent/                      booking agent: tool table (handlers move here FROM core/agent/tools/handlers),
                              prompts (system-prompt-builder), turn service (justin-time), post-reply
                              reconciler, guard hooks (human-control, terminal-status, ceiling)
  availability/               as today, minus its private idempotency/loop code (uses core/agent)
  lifecycle/                  as today — remains the ONLY status writer; gains: transition-side-effects
                              + appointment-notifications absorbed; effect registration moves INSIDE
                              the transition tx (payload rendered pre-commit or executor-id + args)
  inbound/                    the routing brain moved OUT of core/email/inbound: appointment matching,
                              weekly-mailing, nudge-reply, closure-auto-dismiss, unmatched-attempts.
                              The agent-processor DI registry dies — domain imports its own agent directly.
  followups/                  chase, post-booking, therapist-nudge, stale-check as declarative specs on
                              core/runner + core/effects; shared where-fragments (TERMINAL filter,
                              "actively negotiating" predicate) live here next to stage-groups
```

Concept ownership after restructure: **status writes** → lifecycle only (plus fix the one raw bypass at appointments.routes.ts:580). **Idempotency** → core/agent/idempotency + core/effects keys. **Periodic scaffolding** → core/runner (9 services subclass; zero hand-rolled interval+lock compositions). **Escalation** → core/agent/escalation. **Sentinels** → core/runner/atomic-sentinel-claim exclusively.

---

## 2. Migration phases (each one PR; hardening first)

**Phase 0 — Bug-fix batch, zero file moves (small, ship immediately).** Fixes confirmed findings that are pure defects: (a) three `"AppointmentRequest"` raw-SQL table names → `appointment_requests` (email-queue.service.ts:401, core/email/outbound/queue.ts:241, inbound/divergence-handling.ts:102); (b) dead compensation filter `send_user_email|send_therapist_email` → `send_email` (ai-conversation.service.ts:471, justin-time.service.ts:162); (c) code-level loop break on `skipReason === 'human_control'` + make flagForHumanReview not clobber an existing takeover record; (d) delete availability fail-open idempotency copy, use canonical module with prefix param (tool-executor.ts:63-99); (e) chase-email passes `transitionGeneration` to runPeriodicTrackedSideEffect; (f) send-gate updateMany predicate adds `status: { notIn: TERMINAL_STATUSES }` (send.ts:117) — closes the mid-turn cancel window; (g) total send+queue failure flags human review instead of returning success (send.ts:270); (h) startScheduling final-save failure returns failure so the outbox row is NOT marked completed (justin-time.service.ts:161-209); (i) stage-gating: allow mark_scheduling_complete in PRE_SLOT stages for direct-link bookings (tools-for-stage.ts:25). *Risk:* each is a live-behavior change, but each changes behavior a finding proved wrong. *Verify:* unit tests per fix; (a) needs a real-Postgres `$executeRaw` test (mock-DB tests can't catch table-name bugs — that's why these survived); existing lifecycle integration tests as regression net.

**Phase 1 — Effects kernel (`core/effects/`), retry correctness.** Move side-effect-{tracker,harness,retry}.service to core/effects; rebuild retry around a **named-executor registry**: registration stores `{executorId, payload, generation}`; domain modules (chase, followup, lifecycle notifications) register executors that run the *whole* unit — send → confirmSentinelClaim → checkpoint/transition — fixing the high finding at side-effect-retry.service.ts:354. Add `registerInTx(tx, ...)` and use it from lifecycle transitions (confirmed/cancelled/completed) so the durable row exists before commit — closes the crash window at confirmed.ts:330. Add generation-supersede abandonment (fixes stale-generation double-send). Migration detail: keep a legacy-executor shim that understands existing side_effect_logs rows (payload-only replay) until the table drains; version field on new rows. *Files:* ~12. *Risk:* highest of the plan — retry semantics under live traffic; mitigate with the legacy shim + a week of dual-format soak. *Verify:* new integration test: fail a chase send, run retry runner, assert sentinel confirmed + chaseSentAt set; fail feedback dispatch, assert feedback_requested transition happens on retry; existing followup/chase tests.

**Phase 2 — Turn serialization + state-save consolidation.** Add a per-appointment Redis turn lock (acquire in processEmailReply/startScheduling; concurrent turn waits or defers the message to the scanner). Delete checkpointBeforeSideEffects' version-adoption on ConcurrentModificationError (justin-time.service.ts:619-628) — with turns serialized, COMod is a real error again. Make processEmailReply return failure when the final save fails (so the message replays). Consolidate startScheduling's inline retry loop into storeConversationStateWithRetry (make `expectedUpdatedAt` optional). *Files:* ~4. *Risk:* medium — new lock on the hot path; TTL + renewal mirrors the existing message lock. *Verify:* new concurrency test (two simulated concurrent replies, assert both messages persisted); existing justin-time unit tests.

**Phase 3 — Runner kernel (`core/runner/`).** Move periodic-service, locked-periodic-service, locked-task-runner, atomic-sentinel-claim, sentinel-batch-runner. Fix zombie-overlap (locked-task-runner.ts:138): on timeout, do NOT release the lock or reset isRunning until the underlying promise settles; alert instead. Migrate the five hand-rolled services (therapist-nudge, missed-message-scanner, pending-email, slack-weekly-summary, work-report) + the bare Slack setInterval onto LockedPeriodicService; postBookingFollowup too (currently plain PeriodicService). Add `cleanupStuckSentinels` helper; replace every `new Date(0)` literal; rewrite chase-email's inline loop on sentinel-batch-runner. *Files:* ~15, mostly deletions. *Risk:* low-medium; behavior-preserving except the timeout fix (intentional). *Verify:* runner unit tests; assert each service's getStatus/trigger surface; staging soak watching tick logs.

**Phase 4 — Agent kernel (`core/agent/` proper).** Introduce ToolTable registry; collapse runToolLoop/runAvailabilityToolLoop into one configurable loop (config: checkpoint hook, terminal tools, guard hooks, escalation sink); extract escalation.ts; move schedulingTools definitions out of the loop module into domain/scheduling/agent/tools. Dispatch becomes generic (guard hooks injected by domain). This is where the loop finally *earns* its core/ placement — after inversion it imports no domain code. *Files:* ~20. *Risk:* medium — the loop is the hottest path; behavior-preserving by construction (registry derived from existing lists, asserted equal in tests). *Verify:* golden-transcript tests: replay recorded tool-use sequences through old and new loop, diff emitted messages/escalations; existing agent tests.

**Phase 5 — Boundary re-draw + enforcement.** Move core/agent/tools/handlers → domain/scheduling/agent/tools; core/email/inbound routing files → domain/scheduling/inbound (transport bits — lock-renewal, MIME, thread fetch — stay in core/email); delete agent-processor DI registry; retire email-processing.service facade (23 importers updated; oauth/ingest delegates move or get direct imports); fix core/timezone/prompt-section's SchedulingContext type. THEN add the ESLint boundary rule (`import/no-restricted-paths`; note: eslint config must be created — none exists despite the package.json lint script) and make it CI-blocking. Update core/README layout + lifecycle/README stale references + REFACTOR_PLAN. *Files:* ~45 (mostly import-path churn). *Risk:* low semantic, high textual; one commit per module move, `git mv` + mechanical import rewrite, no logic edits allowed in this PR. *Verify:* typecheck + full test suite + the new lint rule passing is itself the acceptance test.

**Phase 6 — Constants + polish (small).** TERMINAL_STATUSES at stale-check:326/:478 and admin-force:187/:201; named "actively negotiating" where-fragment (4 sites); shared normalizeAgentOutboundEmail (subject prefix + body normalization for both agents); route admin-force's enter-rescheduling through startReschedulingState; drop reconcileStatusAfterReply's redundant re-write (keep a count-0 warning); injection-detection signal gates something (rate-limit or forced review) or the dead branch is removed.

(Phase 3a/3b/3c of the existing plan — AppointmentConversation cutover — is orthogonal; continue it in parallel, unchanged.)

---

## 3. Explicit divergences from docs/REFACTOR_PLAN.md

1. **Reverses Phases 2b/2c placement.** The plan put the tool executor and inbound pipeline in `core/` because they came from god modules that "felt like infrastructure". Both fail all three kernel rules the plan itself depends on for the ATS lift (confirmed high boundary findings). Kernel-first says: the *mechanism* (loop, dispatch pipeline, idempotency, transport) is core; the *policy* (handlers, routing, prompts) is domain. Phase 5 moves them back.
2. **Lint rule stops being "later".** Plan deferred it to Phase 1c; Phase 1c shipped without it and no ESLint config exists at all. Here it is Phase 5's exit criterion — the restructure isn't done until the boundary is machine-enforced, because "enforced by code review" demonstrably failed (the reviewers' README omits the violating modules).
3. **Side-effects move promoted from "low-priority small PR" to Phase 1.** The plan calls transition-side-effects/notifications a cosmetic follow-up; three confirmed high/medium findings (dropped finalization, pre-registration crash window, stale-generation double-send) live exactly there. It is the single most defect-dense seam and goes first among structural changes.
4. **Two loops become one.** The plan's "sibling rather than generalisation" stance was defensible when written; the drift the findings document (6-site manual mirroring, opposite idempotency semantics, missing body normalization) shows the sibling strategy is now generating bugs. The registry inversion makes generalisation safe.
5. **PR size cap relaxed.** Plan caps at ~50 files with shims forbidden; I keep shim-free but accept Phase 5's ~45-file import churn as one PR — splitting it would either need forbidden shims or leave the tree in a mixed state where the lint rule can't land.
6. **Plan doc treated as living artifact**: Phase 1c section rewritten to "DONE" and stale sketches (lifecycle/README's deleted-file pointer) fixed in Phase 5, since stale-plan/stale-docs are themselves confirmed findings.

---

## 4. Honest costs and risks of this angle

- **Phase 1 is genuinely risky.** Changing retry semantics under live traffic, with in-flight side_effect_logs rows in the old format, is the kind of change the original plan's conservatism exists to avoid. The legacy-executor shim + row versioning is mandatory, and the soak week delays everything downstream.
- **Phase 0 changes live behavior nine ways at once.** Each is a proven bug, but the batch makes bisection harder if something regresses; if the team prefers, it splits into 2–3 PRs at the cost of leaving high-severity holes open longer.
- **The turn lock (Phase 2) trades throughput for correctness** — a slow therapist-reply turn now delays a concurrent user-reply turn on the same appointment. At ~100 appointments/day this is negligible, but it must be TTL-bounded or a wedged turn wedges the appointment.
- **Loop unification (Phase 4) risks subtle prompt/behavior drift** in the LLM path that tests can't fully capture; golden-transcript replay mitigates but doesn't eliminate it. This is the phase to abandon first if the cost/benefit sours — the escalation extraction alone captures most of the defect-prevention value.
- **~45-file import PRs are miserable to review**; the mitigation (git mv commits, zero-logic-edit rule, lint rule as proof) shifts review burden onto tooling, which requires reviewer trust.
- **Opportunity cost:** roughly 6 PRs / several weeks that the incremental plan would have spent shipping product-adjacent refactors; the payoff is concentrated in Phases 0–2 (defect fixes) and deferred in 3–6 (structure). If interrupted after Phase 2, the codebase is safer but *more* inconsistent than today (three-way old/plan/kernel seam) — the sequence is ordered so the highest-value phases are the ones most likely to complete.