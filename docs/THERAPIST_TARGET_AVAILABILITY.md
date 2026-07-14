# Therapist Target-Appointment Availability & Multi-Session Email Routing

Status: **implemented** (this branch)
Author: engineering
Related: `docs/REFACTOR_PLAN.md`, `packages/backend/src/utils/thread-matcher.ts`,
`packages/backend/src/services/therapist-booking-status.service.ts`

## 1. Motivation

Two related problems with the "one trial session per therapist" model:

1. **We can't systematically onboard a therapist across several trial
   sessions.** Historically a therapist was frozen the moment they had a
   confirmed booking and re-opened only after it completed/cancelled, with
   no notion of "how many trial sessions must this therapist complete before
   they graduate." Onboarding a new counsellor across *N* different clients
   had to be babysat by hand (admin freeze/unfreeze).

2. **If a therapist is ever "forced open" to more than one concurrent
   client, an unstructured inbound reply can be routed to the wrong
   client's appointment.** The deterministic match paths (Gmail thread id,
   `In-Reply-To`/`References`, tracking code) are safe, but the legacy
   sender+subject fallback picks the *most recently updated* active
   appointment when several match — silently misattributing a therapist's
   email to a different client's thread. The existing cross-pollination
   guard only covers the *active-vs-recent-terminal* case, not
   *active-vs-active*.

The goal: **ad hoc allow a therapist to complete multiple appointments, and
systematically require new therapists to complete multiple appointments
(up to a per-therapist target) before they drop off the public finder** —
without ever misrouting a reply between two of their clients.

## 2. Target-appointment availability model

### 2.1 Definitions

- **Completed count** — the number of *distinct clients* with a `completed`
  appointment for the therapist. Repeat sessions with the same client count
  once. Distinctness is measured **case-insensitively** on email
  (`COUNT(DISTINCT lower(user_email))`) because the app stores emails
  un-normalized — counting raw would let two casings of one address graduate
  a therapist early. Only `status = 'completed'` counts; `session_held` /
  `feedback_requested` do not (the session may not have actually happened).
  The count is computed by a single service method
  (`therapistBookingStatusService.getCompletedClientCount(s)`) shared by the
  finder, the booking gate, and the admin table so they cannot diverge.
- **Target** — `Therapist.targetAppointments`, a per-therapist integer. The
  number of distinct completed clients the therapist must reach before they
  are considered "done" and drop off the public finder.
- **Active appointment** — any appointment in `ACTIVE_STATUSES`
  (`pending`, `contacted`, `negotiating`, `confirmed`, `session_held`,
  `feedback_requested`).
- **Manual freeze** — an admin-set override
  (`TherapistBookingStatus.manualFreezeAt`), toggled by the
  `/freeze` and `/unfreeze` admin endpoints. This is a **new** column,
  deliberately separate from the legacy `frozenAt` (see §6, cutover safety).

### 2.2 The rule

A therapist is **live on the user site** (shown in the finder *and*
accepting new booking requests) iff **all** of:

1. `active = true` (admin archive toggle), **and**
2. not manually frozen (`manualFreezeAt` is null), **and**
3. `completedDistinctClients < targetAppointments`, **and**
4. no active appointment currently exists (serial: one client at a time).

Continuation is always allowed: if the requesting client already has an
active appointment with the therapist, `canAcceptNewRequest` returns
available (so an in-flight negotiation isn't rejected by its own therapist
being "busy").

This single rule **replaces** the previous auto-freeze machinery
(`hasConfirmedBooking`, `uniqueRequestCount`,
`maxBookingRequestsPerTherapist`, and the `frozenAt`-on-first-request
behaviour). Availability is now derived directly from appointment state +
the target, so there is one source of truth and no counter to drift.
`TherapistBookingStatus` is retained **only** as the manual-override record
(`manualFreezeAt` = admin force-freeze). The write-side counter methods
(`recordNewRequest`, `markConfirmed`, `unmarkConfirmed`,
`recalculateUniqueRequestCount`) are reduced to no-ops so their existing
call sites (booking transaction, transition side-effects) keep working
without maintaining dead state.

### 2.3 Lifecycle walk-through (new therapist, target = 2)

1. Ingested → `targetAppointments = 2` (from config default), 0 completed,
   no active appt → **live**.
2. Client A books → therapist now has an active appt → **not live** (serial).
3. A's session completes → 1 distinct completed client, `1 < 2`, no active
   appt → **live again**.
4. Client B books → active appt → **not live**.
5. B completes → 2 distinct completed clients, `2 < 2` is false → **not
   live** (target reached; graduated off the finder).

An admin can "ad hoc" send a graduated therapist more clients by bumping
`targetAppointments` in the admin table.

### 2.3a Serial guard, double-booking, and stall recovery

- **Serial guard** keys on ACTIVE_STATUSES, so a therapist mid-appointment is
  hidden until it reaches a terminal state. The per-therapist booking-create
  duplicate guard also spans ACTIVE_STATUSES (not just pre-booking), so a
  client who already holds a confirmed/held/feedback appointment with a
  therapist cannot open a second concurrent thread with them; a genuine
  re-booking after a *completed* (terminal) session is still allowed.
- **Stall recovery**: because any active pre-booking hides the therapist, a
  ghosted `pending`/`contacted`/`negotiating` request would otherwise hide
  them forever (the old auto-unfreeze is retired). Recovery is now via
  `chaseEmailService.autoCancelStalledPreBooking` (gated by
  `chase.autoCancelStalledPreBooking`, default on): once a thread has been
  chased and its closure recommendation goes un-actioned past the closure
  window, the appointment is auto-cancelled (`source`/`cancelledBy` =
  `system`, atomic guards), which frees the therapist. Admins can prevent it
  by actioning/dismissing the closure recommendation or taking human control.

### 2.4 Rollout: existing vs new therapists

- New column `Therapist.targetAppointments` (`@default(2)`).
- Migration backfill (cutover decision): **archived therapists
  (`active = false`) → target 1; active therapists keep the column default of
  2** (the "new" target). Keying on `active` — not on the column value — is
  unambiguous and re-run-safe. This deliberately keeps day-one disruption
  small: an *active* therapist is only removed from the finder if they have
  already completed **2+** distinct clients (not ≥1), and archived therapists
  are hidden regardless.
- New therapists created after the release are seeded from the
  `general.defaultTargetAppointments` setting (default 2) at creation time
  (both the PDF-ingestion path and `getOrCreateTherapist`/ATS), so the value
  is snapshotted per therapist and later changing the global default does not
  retroactively move existing therapists.

## 3. Email routing hardening (active-vs-active)

Serial availability means a therapist normally has at most one active
client, so the deterministic match paths almost always resolve correctly.
But races (two clients booking a free therapist in the same window),
admin-created appointments, and reschedules can still produce two active
appointments for different clients. This is the "forced open" case.

The fix is in `findByLegacyMatch` (the sender+subject fallback, reached only
when an inbound has **no** deterministic marker):

- When several active candidates tie on therapist-name-in-subject, or on
  therapist-email, and those tied candidates span **more than one distinct
  client**, the match is genuinely ambiguous. We now **reject it (return
  `null` → manual review / admin queue)** instead of silently selecting the
  most-recently-updated row.
- If the tied candidates are all the **same** client (e.g. a reschedule that
  created a second row), most-recently-updated selection is retained — there
  is no misroute risk within a single client.

This generalises the existing active-vs-recent-terminal cross-pollination
guard to the active-vs-active case. Deterministic replies (thread id,
`In-Reply-To`, tracking code) are unaffected and still resolve to the exact
appointment, so well-formed therapist replies are never sent to manual
review.

Net effect: a therapist reply is only ever auto-attributed to a client's
thread when the attribution is unambiguous; otherwise a human decides.

**Accepted tradeoff (active-vs-recent-terminal).** A pre-existing guard also
drops a markerless reply to manual review when the sender has *any* terminal
appointment updated within the last 60 days — even when there is exactly one
active candidate. Serial multi-session makes "recently completed A + active B"
a common steady state, so this fires more often than before. We deliberately
**keep** the guard rather than auto-attribute to the single active candidate:
a markerless reply from a therapist who just finished with A is genuinely
ambiguous between A and B, and mis-attributing an A-related message into B's
live negotiation is a worse failure than a manual-review stall. The mitigation
is to keep replies deterministic (thread id / In-Reply-To / tracking code),
which bypasses the fallback entirely.

## 4. Interfaces changed

### Backend
- `prisma/schema.prisma` — `Therapist.targetAppointments`,
  `TherapistBookingStatus.manualFreezeAt`.
- migration `…_add_therapist_target_appointments` — add column + backfill
  archived→1 (active keep default 2).
- migration `…_add_manual_freeze_at` — add the admin-freeze column (NULL for
  all rows; see §5) + one-time clear of the retired `admin_alert_at` signal.
- `config/setting-definitions.ts` — `general.defaultTargetAppointments`,
  `chase.autoCancelStalledPreBooking`.
- `services/therapist-booking-status.service.ts` — new availability rule
  (case-insensitive completed count via `getCompletedClientCount(s)`);
  counter methods reduced to no-ops.
- `services/chase-email.service.ts` + `services/stale-check.service.ts` —
  `autoCancelStalledPreBooking` stall-recovery sweep.
- `utils/thread-matcher.ts` — active-vs-active ambiguity guard.
- `routes/therapists.routes.ts` — public finder uses the new rule.
- `routes/appointments.routes.ts` + `routes/ats-integration.routes.ts` —
  booking creation handles new reasons; per-therapist duplicate guard spans
  ACTIVE_STATUSES.
- `routes/admin-therapists.routes.ts` — list/detail return
  `completedAppointmentCount` (distinct, via the shared service method) +
  `targetAppointments` + `live` + `hasActiveAppointment`; PATCH accepts
  `targetAppointments`; freeze/unfreeze use `manualFreezeAt`.
- therapist creation (`pdf-ingestion`, `utils/unique-id`) seeds
  `targetAppointments` from config.

### Frontend
- `api/admin-therapists.ts` — types for the new fields + PATCH.
- `pages/AdminTherapistsPage.tsx` — "Completed" column (distinct completed),
  editable "Target" column, "Live" badge.

## 5. Cutover safety (live data)

This change ships against a live database, so it was designed to avoid
disrupting in-flight therapists and appointments:

- **In-flight appointment lifecycles are untouched.** The state machine and
  its transitions are unchanged. The counter methods reduced to no-ops
  (`markConfirmed`/`unmarkConfirmed`/`recalculateUniqueRequestCount`/
  `recordNewRequest`) only ever maintained availability *counters*; no
  transition logic depends on their return value, so confirmations,
  completions, cancellations, reschedules, and feedback collection all
  proceed exactly as before.

- **Legacy `frozenAt` is NOT reinterpreted.** In production, the retired
  auto-freeze set `frozenAt` on *every* booking request — it was never a
  reliable "admin froze this therapist" signal. Reading it as a manual
  freeze would have hidden every recently-booked therapist at cutover, and
  because `recalculateUniqueRequestCount` (which used to clear it) is now a
  no-op, they would have stayed hidden permanently. The manual-freeze signal
  therefore lives in a **new** column, `manualFreezeAt`, which starts NULL
  for all rows. At cutover nobody is spuriously frozen.

- **Busy therapists stay hidden via their appointment, not a stale freeze.**
  A therapist mid-appointment at cutover is excluded from the finder by the
  active-appointment clause. When that appointment completes, they become
  live again if still short of target — no lingering freeze traps them.

- **Trade-off (documented, accepted):** a therapist an admin had
  *deliberately* force-frozen in the seconds before deploy would come back
  as un-frozen (the new column is empty). Re-freeze via the admin UI. This
  is strictly better than the alternative of mass-hiding live therapists.

- **Ghosted pre-booking no longer strands a therapist.** The old auto-unfreeze
  is retired, so stall recovery is now `autoCancelStalledPreBooking`: an
  unresponsive pre-booking that has been chased and had its closure
  recommendation go un-actioned past the closure window is auto-cancelled,
  freeing the therapist. Without this, one ghosted request would hide a
  therapist from the finder indefinitely.

- **Intended behaviour change to call out (bounded by the cutover decision):**
  archived therapists are backfilled to target **1**; active therapists keep
  the default **2**. So an active therapist is removed from the finder at ship
  time only if they have already completed **2+** distinct clients — not ≥1.
  Completed counts are case-insensitive on email, so casing variants of one
  client don't inflate the total. To keep a specific therapist taking clients,
  bump their target in the admin Therapists table.

- **No destructive migrations.** Migrations are additive
  (`ADD COLUMN IF NOT EXISTS`); the `UPDATE`s are the archived-therapist target
  backfill and a one-time clear of the retired `admin_alert_at` alert signal.
  `TherapistBookingStatus` rows and other legacy columns are left intact.

## 6. Testing

- Matcher: active-vs-active distinct clients → ambiguous (null); active-vs-
  active same client → most-recent; deterministic paths unaffected.
- Availability: short-of-target + no active → live; target reached → not
  live; active appt → not live; manual freeze → not live; continuation
  allowed.
