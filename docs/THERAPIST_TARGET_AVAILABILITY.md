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

- **Completed count** — the number of *distinct clients* (`user_email`) with
  a `completed` appointment for the therapist. Repeat sessions with the same
  client count once. Only `status = 'completed'` counts; `session_held` /
  `feedback_requested` do not (the session may not have actually happened).
- **Target** — `Therapist.targetAppointments`, a per-therapist integer. The
  number of distinct completed clients the therapist must reach before they
  are considered "done" and drop off the public finder.
- **Active appointment** — any appointment in `ACTIVE_STATUSES`
  (`pending`, `contacted`, `negotiating`, `confirmed`, `session_held`,
  `feedback_requested`).
- **Manual freeze** — an admin-set override
  (`TherapistBookingStatus.frozenAt`), toggled by the
  `/freeze` and `/unfreeze` admin endpoints.

### 2.2 The rule

A therapist is **live on the user site** (shown in the finder *and*
accepting new booking requests) iff **all** of:

1. `active = true` (admin archive toggle), **and**
2. not manually frozen (`frozenAt` is null), **and**
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
(`frozenAt` = admin force-freeze). The write-side counter methods
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

### 2.4 Rollout: existing vs new therapists

- New column `Therapist.targetAppointments` (`@default(2)`).
- Migration backfills **all rows present at migration time to 1** — existing
  counsellors keep the old "one trial" expectation.
- New therapists created after the release are seeded from the
  `general.defaultTargetAppointments` setting (default 2) at creation time,
  so the value is snapshotted per therapist and later changing the global
  default does not retroactively move existing therapists.

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

## 4. Interfaces changed

### Backend
- `prisma/schema.prisma` — `Therapist.targetAppointments`.
- migration `…_add_therapist_target_appointments` — add column + backfill 1.
- `config/setting-definitions.ts` — `general.defaultTargetAppointments`.
- `services/therapist-booking-status.service.ts` — new availability rule;
  counter methods reduced to no-ops.
- `utils/thread-matcher.ts` — active-vs-active ambiguity guard.
- `routes/therapists.routes.ts` — public finder uses the new rule.
- `routes/appointments.routes.ts` — booking creation handles new reasons.
- `routes/admin-therapists.routes.ts` — list returns
  `completedAppointmentCount` (distinct) + `targetAppointments` + `live`;
  PATCH accepts `targetAppointments`.
- therapist creation (`pdf-ingestion`, `utils/unique-id`) seeds
  `targetAppointments` from config.

### Frontend
- `api/admin-therapists.ts` — types for the new fields + PATCH.
- `pages/AdminTherapistsPage.tsx` — "Completed" column (distinct completed),
  editable "Target" column, "Live" badge.

## 5. Testing

- Matcher: active-vs-active distinct clients → ambiguous (null); active-vs-
  active same client → most-recent; deterministic paths unaffected.
- Availability: short-of-target + no active → live; target reached → not
  live; active appt → not live; manual freeze → not live; continuation
  allowed.
