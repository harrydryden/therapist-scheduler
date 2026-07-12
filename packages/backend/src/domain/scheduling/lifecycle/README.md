# `domain/scheduling/lifecycle/`

THE SINGLE SOURCE OF TRUTH for all appointment status transitions.

## State machine

```
pending → contacted → negotiating → confirmed → session_held → feedback_requested → completed
               ↑             ↑           ↑ (reschedule)
               └─────────────┘           │
                     ↑                   │
                     └───────────────────┘ (confirmed also accepts feedback_requested via admin)

Any active status → cancelled  (all except completed and cancelled)
```

Every transition is enforced atomically via status preconditions on the
`updateMany` / `update` `where` clause, so concurrent transitions on the
same row produce at most one successful write — the loser sees count=0
(or P2025) and either idempotent-skips or returns `atomicSkipped`.

## Layout

```
lifecycle/
├── service.ts              ← appointmentLifecycleService — object literal that
│                              binds the transition functions; preserves the
│                              public API every caller depends on
├── tick.ts                 ← AppointmentLifecycleTickService — periodic
│                              service that advances confirmed → session_held
│                              when the session datetime has passed
├── types.ts                ← TransitionSource, *Params, TransitionResult
├── status-order.ts         ← Lifecycle order + progressionResetsFor /
│                              computeBackwardSentinelResets
├── update-fragments.ts     ← CLEAR_RESCHEDULING_STATE, RESET_ALL_FOLLOWUP_SENTINELS
├── audit.ts                ← addAuditMessage (SQL JSON append),
│                              recordStatusChangeEvent
├── terminal-tx.ts          ← runTerminalTransitionTx — shared transactional
│                              skeleton for completed/cancelled
├── dispatch-helpers.ts     ← fireAndForget, notifyTransition,
│                              catchUpSessionHeldEffects
├── transitions/
│   ├── light.ts            ← applyLightTransition + contacted /
│   │                          negotiating / session_held / feedback_requested
│   ├── confirmed.ts        ← transitionToConfirmed (semantic-equality +
│   │                          reschedule + atomic options)
│   ├── completed.ts        ← transitionToCompleted (terminal)
│   └── cancelled.ts        ← transitionToCancelled (terminal + skipNotifications)
├── admin-force.ts          ← adminForceUpdate — the deliberate FSM bypass
├── closure-dismiss.ts      ← dismissClosureRecommendation (not a status
│                              transition — closure flags live alongside status)
├── update-status.ts        ← UPDATE_STATUS_DISPATCH + updateStatus (admin
│                              dashboard "set status to X" route)
├── index.ts                ← public barrel
└── README.md               ← you are here
```

## What does NOT live here

- **Side-effect dispatchers** — Slack / email notifications + therapist
  booking-status sync live in `services/transition-side-effects.service.ts`
  and `services/appointment-notifications.service.ts`. They're called
  from the transitions here, not implemented here. Folding them in is
  scoped as a future PR.
- **Specific tools that drive the FSM** — e.g. the agent's
  `mark_scheduling_complete` tool lives in
  `domain/scheduling/agent/handlers/mark-scheduling-complete.ts` and
  calls `transitionToConfirmed`.

## Invariants

1. **Atomicity.** Every transition uses status preconditions in the
   write. Concurrent transitions either serialize naturally (terminal,
   via SERIALIZABLE + FOR UPDATE) or return `atomicSkipped` (non-terminal,
   via P2025 fall-through after the precondition fails).

2. **Generation bump.** Every transition increments
   `transitionGeneration` atomically with the status flip. Side-effect
   idempotency keys are scoped by generation so a cancel → re-confirm
   doesn't dedupe against the prior generation's already-completed
   side-effect rows.

3. **Audit completeness.** Every successful transition writes an
   `appointment_audit_events` row with `eventType='status_change'`. The
   terminal transitions write it INSIDE the transaction (atomic);
   non-terminal ones write it just after the update (already-committed —
   a missing audit row never rolls back a real transition).

4. **Source / cancelledBy validation.** `transitionToCancelled`
   enforces the source ⇄ cancelledBy pairing table so audit + Slack
   narratives can never claim a combination that's incoherent.

5. **State-machine bypass requires explicit acknowledgement.**
   `adminForceUpdate` requires `bypassStateMachine: true` (literal type
   + runtime check) + a non-empty `reason` + a non-empty `adminId`.
   Status changes via this path emit a Slack alert at severity=high.

## Migration note

This module was extracted from a single 1,972-line
`services/appointment-lifecycle.service.ts` plus an 85-line sibling
`appointment-lifecycle-tick.service.ts` (Phase 2a of the refactor; see
`docs/REFACTOR_PLAN.md`). The `AppointmentLifecycleService` class
collapsed into an object literal binding because none of its methods
used `this` state — they only called each other. External callers'
APIs are preserved.
