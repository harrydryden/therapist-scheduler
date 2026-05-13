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
    availability/        Availability extraction, windows, formatter
                         (currently spread across 8 services/availability-*).
    lifecycle/           Appointment state machine + side effects
                         (currently appointment-lifecycle.service.ts, 1972 lines).
    booking/             Voucher issuance, post-booking follow-up,
                         meeting-link checks.
    therapist/           Therapist booking-status, freeze sync,
                         nudge / onboarding conversations.
```

See `docs/REFACTOR_PLAN.md` for the staged migration plan.
