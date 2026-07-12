# `domain/` — Domain-Specific Code

Modules under `domain/` model bounded contexts that **do not** survive a
generic lift into another product. They are free to depend on `core/`,
but `core/` must never depend on them.

The directory is being populated incrementally as services migrate out
of the flat `services/` directory. Until that work completes, most
domain code still lives at `services/<file>.service.ts`.

## Planned layout

```
domain/
  scheduling/
    agent/               Booking agent's tool handlers, dispatch, and send
                         wrapper (moved from core/agent/tools/ in Stage D2 —
                         see docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md).
    inbound/             Inbound Gmail-message routing: appointment
                         matching, agent invocation, nudge/weekly-mailing/
                         closure branches (moved from core/email/inbound/
                         in Stage D3).
    availability/        Availability extraction, windows, formatter, and
                         its own agent/ (the availability-collection agent).
    lifecycle/           Appointment state machine + side effects
                         (currently appointment-lifecycle.service.ts, 1972 lines).
    booking/             Voucher issuance, post-booking follow-up,
                         meeting-link checks.
    therapist/           Therapist booking-status, freeze sync,
                         nudge / onboarding conversations.
```

See `docs/REFACTOR_PLAN.md` for the staged migration plan.
