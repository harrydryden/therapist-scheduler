# Architecture Consolidation Plan

This document captures the in-flight refactor staged across multiple
PRs. The first PR (this one) lays the kernel boundary and consolidates
the two lowest-risk concept fragmentations (timezone, message dedup).
Everything else is sequenced below with explicit migration patterns.

The driving forces are:

1. **Stability under live traffic.** The system runs single-instance
   with ~100 appointments/day. Every change must preserve behaviour
   under concurrent message processing, the AppointmentRequest FSM,
   and the 10+ background services. No destructive ops.
2. **ATS extension.** The product is being extended into an ATS in
   the same codebase. Generic infrastructure (email, agent loop, PDF
   ingestion, audit, timezone, dedup, tokens) goes into `core/`;
   scheduling-specific code stays in `domain/scheduling/`.
3. **Manageable PR review.** Each phase is one PR. No phase touches
   more than ~50 files. God-module splits and schema surgery each get
   their own PR.

Phases NOT in this PR are sketched in enough detail that a follow-up
agent (or human) can pick them up cleanly.

---

## Phase 1c — Availability consolidation (next PR)

### Current state

Eight files, 3,001 lines total:

| File | Lines | Role |
|---|---|---|
| `services/availability-agent.service.ts` | 821 | Availability-collection LLM agent |
| `services/availability-tool-executor.service.ts` | 703 | Tools the agent calls |
| `services/availability-formatter.service.ts` | 472 | Render windows for human-facing output |
| `services/agent-availability-windows-store.ts` | 333 | Window persistence to `Therapist.availability` JSON |
| `services/therapist-availability.service.ts` | 257 | Therapist-level availability queries |
| `services/availability-tools.ts` | 246 | Tool schemas (Zod) |
| `services/availability-day-parser.ts` | 90 | Day-of-week parsing |
| `services/availability-resolver.service.ts` | 79 | Mark-complete validation |

The recent commit history (`availability-final-consolidation`,
`availability-fabrication`, `availability reset script`) shows
ongoing churn. The fragmentation makes "where does availability for X
live?" a hunting exercise.

### Target layout

```
domain/scheduling/availability/
  agent/
    service.ts            ← availability-agent.service (LLM agent)
    tools.ts              ← availability-tools (Zod schemas)
    tool-executor.ts      ← availability-tool-executor
  windows/
    store.ts              ← agent-availability-windows-store
    therapist-store.ts    ← therapist-availability.service
    parser.ts             ← availability-day-parser
    formatter.ts          ← availability-formatter.service
  resolver.ts             ← availability-resolver.service
  index.ts                ← public surface
```

### Migration steps

1. Move files preserving exports; update all import paths in one
   commit. Zero semantic change.
2. Audit cross-references; collapse any duplicate helpers exposed
   by both `windows/store.ts` and `windows/therapist-store.ts`.
3. Single test pass — these modules already have decent unit-test
   coverage (`availability-day-parser.test.ts`,
   `availability-agent-prompt.test.ts`, etc.) and the integration
   tests under `__tests__/integration/` exercise the runtime path.

### Risk

Medium. The availability path is on the hot agent loop. The
behaviour-preserving file-move strategy keeps risk low; the post-move
audit for duplicate helpers is where semantic regressions could
sneak in.

---

## Phase 2 — God module decomposition (multi-PR)

Each god module is its own PR. Behaviour-preserving file split; same
exports re-routed through an `index.ts` barrel.

### Phase 2a — `appointment-lifecycle.service.ts` (1,972 lines) ✅ DONE

Landed in PR #237. The actual decomposition diverged from the original
sketch on closer inspection — the file had richer cohesion lines than
the bullets above suggested. Final layout:

```
domain/scheduling/lifecycle/
  service.ts              ← appointmentLifecycleService — object literal
                            binding the transition functions (the class
                            collapsed; no method used `this` state)
  tick.ts                 ← AppointmentLifecycleTickService
  types.ts                ← TransitionSource, *Params, TransitionResult
  status-order.ts         ← LIFECYCLE_STATUS_ORDER, progressionResetsFor,
                            computeBackwardSentinelResets
  update-fragments.ts     ← CLEAR_RESCHEDULING_STATE,
                            RESET_ALL_FOLLOWUP_SENTINELS
  audit.ts                ← addAuditMessage (SQL JSON append),
                            recordStatusChangeEvent
  terminal-tx.ts          ← runTerminalTransitionTx + types
  dispatch-helpers.ts     ← fireAndForget, notifyTransition,
                            catchUpSessionHeldEffects
  transitions/
    light.ts              ← applyLightTransition + contacted /
                            negotiating / session_held /
                            feedback_requested
    confirmed.ts          ← transitionToConfirmed
    completed.ts          ← transitionToCompleted
    cancelled.ts          ← transitionToCancelled
  admin-force.ts          ← adminForceUpdate
  closure-dismiss.ts      ← dismissClosureRecommendation
  update-status.ts        ← UPDATE_STATUS_DISPATCH + updateStatus
  index.ts                ← public barrel
```

Callers continue to import `appointmentLifecycleService` and call the
same method names — the object literal preserves the API exactly.

**Follow-up not yet done:** `transition-side-effects.service.ts`
(352 lines) and `appointment-notifications.service.ts` (583 lines)
remain in `services/`. They're called from the new module but not
yet moved into it. They're already focused single-concern files, so
the move is low-priority; tracked as a future small PR.

**Test rewrite note:** `lifecycle-feedback-source-gating.test.ts`
was rewritten to assert on `prisma.appointmentRequest.updateMany`'s
`where.status.in` instead of monkey-patching the private
`applyLightTransition` method. The new test exercises the real
transition path against a mocked DB — more robust and no longer
coupled to the implementation's class structure.

### Phase 2b — `email-message-processor.service.ts` (1,837 lines) ✅ DONE

Landed in PR #238. The original sketch had placeholders that didn't
map to the actual file (no "restore-state" or "invoke-agent" sub-
flows here — those live in justin-time.service). The realised
decomposition reflects the file's actual cohesion lines:

```
core/email/
├── inbound/
│   ├── process.ts                top-level orchestrator (the trimmed
│                                 processMessage — dropped from 720 to ~430
│                                 lines after extracting branches/helpers)
│   ├── availability-routing.ts   routeToAvailabilityAgent
│   ├── nudge-reply.ts            therapist-nudge reply detection
│                                 (threadId match + sender fallback) + Slack alert
│   ├── weekly-mailing.ts         isWeeklyMailingReply + processWeeklyMailingReply
│   ├── closure-auto-dismiss.ts   dismiss-on-incoming-reply branch
│   ├── divergence-handling.ts    thread-divergence check + retry/abandon
│   ├── unmatched-attempts.ts     DB-authoritative unmatched-attempt tracking
│   ├── processing-failures.ts    MessageProcessingFailure CRUD + read helpers
│   ├── lock-renewal.ts           Redis lock renewal manager
│   ├── agent-processor.ts        AgentProcessor interface + DI registry
│   └── index.ts
├── outbound/
│   ├── send.ts                   sendEmail via Gmail API
│   ├── queue.ts                  processPendingEmails — drain with backoff
│   └── index.ts
├── index.ts                      emailMessageProcessorService object literal
└── README.md
```

The `EmailMessageProcessorService` class collapsed into an object
literal — same Phase 2a pattern; none of the methods used `this`
state. Three callsites updated.

**Dedup migration done:** direct calls to `redis.eval(ATOMIC_LOCK_CHECK_SCRIPT, ...)`,
`prisma.processedGmailMessage.upsert(...)`, the Slack-alert dedup
`SET ... NX`, and the DB-fallback rollback now go through
`core/messaging/message-dedup`:
  - `acquireMessageLock` replaces the inline Lua + serializable-tx
  - `markMessageProcessed` replaces the inline ZSET + upsert
  - `isMessageProcessed` replaces the inline belt-and-braces DB
    re-check
  - `shouldEmitProcessingAlert` replaces `acquireAlertDedupLock`
  - `releaseDbLock` (new facade export) replaces the inline
    `processedGmailMessage.delete` in the failure path
  - `ProcessedContext` type extended to cover the four
    `availability-agent-*` variants + `therapist-nudge-reply` +
    `invitation-reply`

The unmatched-attempt path stays DB-authoritative locally
(`inbound/unmatched-attempts.ts`) — the facade's
`recordUnmatchedAttempt` is Redis-only with a different reliability
shape; aligning is a future PR.

### Phase 2c — `ai-tool-executor.service.ts` (1,789 lines) ✅ DONE

Landed in PR #239. The original sketch had a `registry.ts` for Zod
schemas, but the existing `schemas/tool-inputs.ts` already serves
that role — each handler imports its own schema directly from there.
Realised layout:

```
core/agent/tools/
├── dispatch.ts                 orchestrator (atomic gate + ceiling +
│                               idempotency + dispatch switch +
│                               post-success bookkeeping) +
│                               AIToolExecutorService class (thin)
├── idempotency.ts              hashToolCall, wasToolExecuted, markToolExecuted
├── email-normalization.ts      normalizeEmailBody
├── send.ts                     sendAppointmentEmail
│                               (per-appointment Gmail wrap with thread +
│                                tracking-code + atomic human-control
│                                + queue fallback)
├── handlers/
│   ├── resolve-local-time.ts            (pure, bypasses the gate)
│   ├── send-email.ts
│   ├── update-therapist-availability.ts
│   ├── mark-scheduling-complete.ts
│   ├── cancel-appointment.ts
│   ├── initiate-reschedule.ts
│   ├── human-control.ts                 (flag + recommend_cancel_match)
│   ├── issue-voucher-code.ts
│   ├── remember.ts
│   ├── record-availability-window.ts
│   ├── record-booking-link.ts
│   ├── record-user-timezone.ts
│   └── record-therapist-timezone.ts
├── index.ts
└── README.md
```

The class collapsed to a thin wrapper holding the traceId — its only
state. `flag_for_human_review` and `recommend_cancel_match` share a
file because they share the human-control-flip + audit + Slack
pattern. Each handler file 30–250 lines.

Two callsites updated: `services/justin-time.service.ts` and the
unit test.

### Phase 2d — `admin-appointments.routes.ts` (1,771 lines) ✅ DONE

Landed in PR #240. The original sketch had placeholders that didn't
match the actual endpoint set — there's no separate `transitions.ts`
or `comments.ts` endpoint; instead there are two PATCH endpoints
(dashboard vs appointments-page, with different control-flow), plus
several side-channel actions (send-message, feedback-email,
reprocess-thread, action-closure, ceiling release). Realised layout:

```
routes/admin/appointments/
├── index.ts                 adminAppointmentRoutes — top-level plugin
│                            that registers all sub-plugins under a
│                            single verifyWebhookSecret preHandler hook.
├── schemas.ts               Shared Zod schemas + buildLastMessagePreview
│                            + CEILING_TRIPPED_WHERE.
├── list-dashboard.ts        GET /api/admin/dashboard/appointments
├── detail.ts                GET /api/admin/dashboard/appointments/:id
├── list-all.ts              GET /api/admin/appointments/all
├── human-control.ts         take-control + release-control + ceiling
│                            (count + bulk-release)
├── delete.ts                DELETE /api/admin/dashboard/appointments/:id
├── patch-dashboard.ts       PATCH dashboard variant (requires human control)
├── patch-admin.ts           PATCH appointments-page variant (uses
│                            adminForceUpdate, no human-control gate)
├── send-message.ts          manual admin email
├── feedback-email.ts        feedback-form trigger + force-flag
├── reprocess-thread.ts      preview / safe / force-reprocess Gmail thread
├── action-closure.ts        cancel or dismiss a closure recommendation
├── dropdowns.ts             users + therapists dropdown data
└── README.md
```

Each endpoint file exports a Fastify plugin function; the top-level
`adminAppointmentRoutes` registers them in `index.ts`. The single
`verifyWebhookSecret` preHandler hook applies to all routes — no
individual handler can forget it. Each endpoint file is 70–200 lines.

No business logic moved — pure routing split. Two callsites updated:
`admin-dashboard.routes.ts` and the take-control unit test.

---

## Phase 3 — Data model surgery (rescoped after Phase 1+2 audit)

### Why the scope changed

The original Phase 3 spec proposed a 4-table split
(`AppointmentRequest` + `AppointmentConversation` +
`AppointmentBooking` + `AppointmentOps`), motivated primarily by the
"500KB conversationState blob accidentally loaded" problem. A
codebase audit at the start of Phase 3 found that **Phase 1 and
Phase 2 mitigated that problem in the application layer**:

- Every `findUnique` / `findMany` / `findFirst` on
  `AppointmentRequest` in production code uses `select`. There are
  zero accidental full-row loads.
- The dashboard list endpoint uses denormalized `messageCount` and
  `checkpointStage` columns plus a Postgres JSONB path expression
  for last-message preview — no blob load at list-time.
- The hot-path audit-message append uses
  `$executeRaw` with `jsonb_set` to mutate
  `conversation_state.messages` server-side without round-tripping
  the blob.

That leaves Phase 3's remaining motivation — **schema clarity** +
**future ATS adaptation** — as the only real driver. Against the
cost (233 Prisma callsites, ~80 dual-write paths, multi-week
verification, contract several weeks later), the booking/ops splits
are not currently justified. We narrowed the scope to the one piece
with concrete ongoing value: **extract `conversationState` + `memory`
into `AppointmentConversation`**.

### Phase 3a — `AppointmentConversation` (expand + dual-write + backfill) ✅ DONE

Landed in PR #241. The schema is expanded and every writer dual-
writes to the sibling table; reads still hit the legacy columns.

#### Target schema (current PR)

```
AppointmentRequest  ← unchanged
  ... 57 columns including conversationState (JSON) and memory (JSON)

AppointmentConversation  ← NEW (1:1 with AppointmentRequest)
  appointmentId (PK + FK ON DELETE CASCADE)
  conversationState  (JSON, nullable)
  memory             (JSON, nullable)
  createdAt, updatedAt
```

#### What was done

1. **Schema expand.** New `appointment_conversations` table with
   `appointment_id` as both PK and FK (1:1 enforced at the schema
   level). Cascade delete on appointment removal.
2. **Dual-write at 6 callsites.** Each write to
   `appointmentRequest.conversationState` or `.memory` is wrapped in
   a `$transaction` that also upserts the sibling row. Atomic — a
   partial-write divergence is impossible:
   - `ai-conversation.service.ts → storeConversationState` (two
     branches: with + without optimistic lock)
   - `ai-conversation.service.ts → applyCheckpointUpdate`
   - `domain/scheduling/lifecycle/audit.ts → addAuditMessage`
     (raw SQL with `jsonb_set`; dual-writes via two
     `$executeRaw` calls in a `$transaction`)
   - `agent-memory.service.ts → addNote`
   - `agent-memory.service.ts → addAvailabilityWindow`
   - `scripts/migrate-conversation-state.ts` (historical one-off
     script — dual-writes for safety in case anyone re-runs it)
3. **Backfill script.**
   `src/scripts/backfill-appointment-conversation.ts` runs idempotently:
   - Default mode: skip rows where the mirror row already exists
     (no overwrites of newer dual-writes with stale legacy data).
   - `--force-resync`: rebuild every mirror row from the legacy
     column (used for the cutover-day final reconcile).
   - `--verify`: read-only divergence check; exits non-zero on any
     missing or divergent row.
4. **No reads changed.** Production still reads `conversationState`
   and `memory` from `appointment_requests`. The sibling table sits
   alongside, populated.

#### Verification window

Before Phase 3b cutover, run for at least one full week:

```bash
npm run verify:appointment-conversation
```

Acceptance: 0 missing + 0 divergent + 0 errors across all active
appointments.

### Phase 3b — Cutover (follow-up PR)

When verification has been clean for ≥ 1 week:

1. Switch every read of `conversationState` / `memory` to the
   sibling table. ~10 callsites (mostly `ai-conversation.service`,
   `agent-memory.service`, the dashboard detail endpoint).
2. Dual-write continues unchanged — a one-line rollback is just
   flipping the read paths back.
3. Update the raw-SQL writers (`audit.ts`) and the dashboard
   list-preview raw-SQL reader (`routes/admin/appointments/list-dashboard.ts`)
   to target `appointment_conversations` for the read side and drop
   the legacy `appointment_requests.conversation_state` reference.

### Phase 3c — Contract (follow-up PR)

After ≥ 1 week of cutover proven in production:

1. Drop the legacy columns:
   ```sql
   ALTER TABLE appointment_requests
     DROP COLUMN conversation_state,
     DROP COLUMN memory;
   ```
2. Remove the now-dead dual-write branches from the 6 writers.
3. Remove the legacy fields from the `AppointmentRequest` Prisma
   model.

Contract is **irreversible** — once columns are dropped, there's no
fallback. The verification window in 3a + the production-soaking
period in 3b are how we earn the confidence to drop.

### What stays on `AppointmentRequest` (final)

After Phase 3c, `AppointmentRequest` is 2 columns lighter. **All
other fields stay** — the booking-time columns and operational
counters remain in place, per the audit findings.

### Why we are NOT splitting booking/ops fields

| Field group | Original motivation | Audit finding |
|---|---|---|
| Booking fields (`confirmedDateTime`, `voucherCode`, `feedbackForm*`, reschedule, meeting-link) | "Mostly null for non-confirmed rows" | Storage-only, near-zero cost. ~100 appointments/day. No memory or performance impact. |
| Ops counters (`chaseSentAt`, `closureRecommended*`, `conversationStall*`, `threadDiverg*`, `autoEscalatedAt`) | "Read by background services that don't need the rest" | Already read with `select`. Splitting adds join cost for marginal aesthetic benefit. |

If/when ATS extension actually drives a different shape for these
fields, the relevant tables can be added then with concrete use
cases to inform the design. Until then, a deferred split is the
correct call.

---

## Dedup callsite migration (cross-phase)

The facade `core/messaging/message-dedup` is in place. The six
existing direct-touch sites migrate one at a time, each in its own
small PR:

1. `email-message-processor.service.ts` (primary) — migrate the
   `processMessage` lock+check; remove direct
   `redis.eval(ATOMIC_LOCK_CHECK_SCRIPT, …)` and
   `prisma.processedGmailMessage.upsert(…)` calls. Gated by
   `__tests__/integration/lifecycle.integration.test.ts`.
2. `email-ingest.service.ts` (recovery) — switch
   `findMany({ id: { in: ids } })` to `filterUnprocessed`.
3. `missed-message-scanner.service.ts` — switch the scanner's
   cross-reference to `filterUnprocessed`.
4. `chase-email.service.ts` — switch the "permanently processed"
   check to `isMessageProcessed`.
5. `stale-check.service.ts` — keep direct `deleteMany` (the
   facade doesn't yet expose a "forget" verb; if needed, add it
   later).
6. `admin.routes.ts` — admin delete endpoint stays on direct
   `deleteMany` for now (intentional admin escape hatch).

After all six are migrated, the constants in `EMAIL_PROCESSING`
become internal to `core/messaging/`.

---

## Cross-cutting: kernel-boundary lint rule

Once `core/` is populated, add an ESLint rule banning:

- `core/**` files from importing `services/<scheduling-specific>.service`
- `core/**` files from importing `domain/**`
- `domain/**` files from importing `services/<other-domain>.service`

Implementation: an `eslint-plugin-local` rule or `import/no-restricted-paths`.
Add in the Phase 1c PR when the first scheduling-specific module
moves into `domain/`.

---

## Out of scope

- **Multi-instance readiness** (the original "Phase 5"). Deferred
  per current single-instance horizon.
- **Frontend page splits** (`AdminFormsPage.tsx` 1,272 lines, etc.).
  Independent of backend refactor; can be tackled separately.
- **Settings registry decomposition** (`config/setting-definitions.ts`
  1,115 lines). Independent; low-priority because the file is
  declarative and read-only at runtime.
