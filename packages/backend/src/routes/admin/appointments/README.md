# `routes/admin/appointments/`

Admin appointment routes — CRUD + side-channel actions + dropdown
data. Replaces the monolithic `routes/admin-appointments.routes.ts`
(1,771 lines) with one file per endpoint group.

## Layout

```
routes/admin/appointments/
├── index.ts                 adminAppointmentRoutes — registers all
│                            sub-plugins under one preHandler hook.
├── schemas.ts               Shared Zod schemas + helpers
│                            (buildLastMessagePreview, CEILING_TRIPPED_WHERE).
├── list-dashboard.ts        GET /api/admin/dashboard/appointments
├── detail.ts                GET /api/admin/dashboard/appointments/:id
├── list-all.ts              GET /api/admin/appointments/all
├── human-control.ts         POST take-control + release-control;
│                            GET ceiling-tripped-count;
│                            POST release-ceiling-tripped
├── delete.ts                DELETE /api/admin/dashboard/appointments/:id
├── patch-dashboard.ts       PATCH /api/admin/dashboard/appointments/:id
│                            (requires human control)
├── patch-admin.ts           PATCH /api/admin/appointments/:id
│                            (no human-control requirement; uses adminForceUpdate)
├── send-message.ts          POST /:id/send-message
├── feedback-email.ts        POST /:id/send-feedback-email
├── reprocess-thread.ts      POST /:id/reprocess-thread (preview / safe / force)
├── action-closure.ts        POST /:id/action-closure (cancel / dismiss)
├── dropdowns.ts             GET users + GET therapists (for the appointments page)
└── README.md                you are here
```

Each endpoint file exports a Fastify plugin function (`async function
xRoute(fastify)`) that registers its own route(s). The top-level
`adminAppointmentRoutes` registers them all in `index.ts`.

## Two URL prefixes

The endpoint set serves two distinct frontends:

- `/api/admin/dashboard/appointments/...` — the admin dashboard widget
  (kanban-style pipeline view). PATCH requires human control; richer
  detail endpoint loads the conversationState blob.
- `/api/admin/appointments/...` — the admin appointments management
  page (full list with search; admin can edit without taking control;
  uses `adminForceUpdate` under the hood).

The split is historical. Both share the `verifyWebhookSecret`
preHandler and the same lifecycle service for state changes.

## Invariants preserved

1. **All routes are auth-gated** via the single `verifyWebhookSecret`
   preHandler in `index.ts`. No individual handler can forget it.

2. **Take-control is atomic.** `updateMany` with
   `humanControlEnabled: false` as a precondition — two simultaneous
   clicks can never both succeed. One wins, the other gets either
   the idempotent-success branch (same admin) or a 409 (different
   admin).

3. **State-change PATCH endpoints both go through the lifecycle
   service.** Dashboard PATCH routes through `updateStatus` (FSM-
   validated) for status changes and `adminForceUpdate` for date-only
   edits. Appointments-page PATCH always goes through
   `adminForceUpdate` (with explicit `bypassStateMachine: true` +
   `reason`).

4. **Both PATCH endpoints require a non-empty `reason`** when the
   request would mutate state. Audit trail consistency.

5. **`send-message` recipient validation** prevents the admin from
   sending to arbitrary addresses via this path — only the user or
   therapist of the appointment is allowed.

6. **`send-feedback-email` duplicate guard** rejects when
   `feedbackFormSentAt` is set unless `?force=true`.

7. **`delete` confirmed-guard** requires `forceDeleteConfirmed: true`
   for confirmed rows.

## Migration note (Phase 2d)

This module was extracted from a single 1,771-line
`routes/admin-appointments.routes.ts` (Phase 2d of the refactor; see
`docs/REFACTOR_PLAN.md`). The single `adminAppointmentRoutes` plugin
function is preserved at the same export name; two callsites
(`admin-dashboard.routes.ts` and the unit test) updated to the new
import path.

The endpoints, request/response shapes, status codes, rate limits,
and side effects are unchanged.
