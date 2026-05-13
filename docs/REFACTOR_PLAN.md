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

### Phase 2a — `appointment-lifecycle.service.ts` (1,972 lines)

Target: `domain/scheduling/lifecycle/`

```
domain/scheduling/lifecycle/
  transitions.ts          ← preconditioned updateMany writes
  side-effects.ts         ← Slack / email / sync orchestration
  denormalizers.ts        ← messageCount, lastActivityAt, etc.
  audit.ts                ← AppointmentAuditEvent emission
  tick.ts                 ← AppointmentLifecycleTickService
  index.ts                ← public surface (preserves
                            `appointmentLifecycleService` export)
```

**Critical invariant:** every status transition continues to use
`updateMany` with status preconditions. The integration test
`__tests__/integration/lifecycle.integration.test.ts` is the gate.

**Approach:**
1. Add `index.ts` re-exporting from current monolith. No callers
   change.
2. Move atomic transition fns to `transitions.ts`. Monolith re-
   exports.
3. Move side-effect orchestration to `side-effects.ts`. Continue
   re-exports.
4. Move audit + denormalizer code. Continue re-exports.
5. Delete monolith; promote `index.ts` to canonical.

**Risk:** High. This is the FSM source-of-truth. Each step gets its
own commit; tests run on every commit.

### Phase 2b — `email-message-processor.service.ts` (1,837 lines)

Target: `core/email/inbound/` (kernel — generic email-message handling)

```
core/email/inbound/
  classify.ts             ← email-classifier.service (existing)
  match.ts                ← thread/recipient matching, hands off to dedup
  restore-state.ts        ← conversation-state restoration
  invoke-agent.ts         ← thin shim into the agent loop
  process.ts              ← top-level orchestrator (~150 lines)
  lock-renewal.ts         ← createLockRenewal helper
  index.ts
```

**Dedup migration:** all of this module's direct Redis/Prisma dedup
calls must move to `core/messaging/message-dedup`. This is the
single biggest payoff of the dedup facade.

### Phase 2c — `ai-tool-executor.service.ts` (1,789 lines)

Target: `core/agent/tools/` + per-tool handlers.

```
core/agent/tools/
  registry.ts             ← Zod schemas keyed by tool name
  dispatch.ts             ← validate + invoke
  idempotency.ts          ← Redis-backed idempotency
  email-normalization.ts  ← outbound-email rewriting
  handlers/
    record-availability.ts
    record-booking-link.ts
    mark-scheduling-complete.ts
    resolve-local-time.ts
    record-user-timezone.ts
    record-therapist-timezone.ts
    remember.ts
    ...
```

One handler per tool. Each handler stays under ~150 lines.

### Phase 2d — `admin-appointments.routes.ts` (1,771 lines)

Target: `routes/admin/appointments/`

```
routes/admin/appointments/
  list.ts                 ← GET /
  detail.ts               ← GET /:id
  transitions.ts          ← POST /:id/transition
  human-control.ts        ← take-control, release-control
  comments.ts             ← admin comments
  index.ts                ← register all under /admin/appointments
```

Each subfile is ~200–400 lines. No business logic moves — only
routing.

---

## Phase 3 — Data model surgery (single PR, expand-only)

`AppointmentRequest` has 56 columns including a 500KB JSON blob and
many mostly-null booking-time fields. Split into four tables, applied
via the **expand → dual-write → backfill → cutover → contract**
pattern. The expand + dual-write + backfill go in one PR; the
cutover and contract happen in follow-ups after production validation.

### Target schema

```
AppointmentRequest         ← FSM + identity (~25 columns)
  id, userId, therapistId, status, transitionGeneration,
  trackingCode, idempotencyKey, gmailThreadId, therapistGmailThreadId,
  humanControl*, createdAt, updatedAt, lastActivityAt, isStale,
  lastToolExecutedAt/Failed/FailureReason

AppointmentConversation    ← was: conversationState JSON + memory
  id (= appointmentRequestId), conversationState (JSON),
  memory (JSON), checkpointStage

AppointmentBooking         ← was: booking-time columns
  id (= appointmentRequestId), confirmedAt, confirmedDateTime,
  voucherCode, bookingMethod, feedbackForm*, meeting-link checks,
  reschedule fields

AppointmentOps             ← was: operational counters
  id (= appointmentRequestId), reminderSentAt, autoEscalatedAt,
  chaseSentAt*, closureRecommendedAt*, conversation-stall flags
```

### Migration sequence (one PR)

1. **Schema expand.** Prisma migration adds the three new tables with
   foreign-key cascades. No existing data is touched.

2. **Dual-write helpers.** Introduce
   `services/appointment-write.service.ts` that wraps every
   `prisma.appointmentRequest.update` callsite. The helper writes to
   both the new tables AND the legacy columns. **Every existing
   update site is migrated to the helper in this PR.** This is
   the bulk of the work — ~80 callsites.

3. **Backfill script.**
   `src/scripts/backfill-appointment-split-tables.ts` runs idempotently
   over the full table, copying `conversationState`, memory, and
   booking/ops columns into the new tables for every row. Resumable
   via `--start-id`; reports progress.

4. **Read-path stays on legacy columns.** This PR does NOT change
   reads. Production keeps reading from `AppointmentRequest`. The new
   tables sit alongside, populated.

5. **Verification window.** After deploy, ops checks that the new
   tables match the legacy columns for every active appointment for
   at least one full business cycle (one week).

6. **(Follow-up PR.) Read-path cutover.** Switch all reads to the
   new tables. Dual-writes continue.

7. **(Follow-up PR.) Contraction.** Drop the legacy columns from
   `AppointmentRequest`. This is reversible (the column data still
   exists in `AppointmentConversation` etc.) but irreversible w.r.t.
   the column drop itself.

### Why this sequence

Live data + single instance means we cannot tolerate any window
where reads see inconsistent state. Dual-write + backfill gives us a
full verification period before cutover; the cutover itself is a
read switch with no migration; contraction is decoupled from
behaviour change.

### Risk

High. Mitigations:

- Backfill is idempotent (UPSERT semantics on the new tables).
- A `SELECT count(*)` check between legacy and new columns runs on
  every deploy of the verification phase.
- Read-path cutover is gated behind a settings flag
  (`USE_SPLIT_APPOINTMENT_TABLES`) that can be flipped via
  `SystemSetting` without redeploy.
- Contraction is a separate PR, weeks after cutover.

### What stays on `AppointmentRequest`

Anything queried by the kanban / lifecycle / stale-check hot paths.
The `JSON` blob and mostly-null booking columns are the bloat;
identity, status, timestamps, and indexes stay.

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
