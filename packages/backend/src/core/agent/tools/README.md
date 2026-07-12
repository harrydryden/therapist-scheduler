# `core/agent/tools/`

Generic tool-call mechanism shared by both agent loops (the booking
agent's dispatch in `domain/scheduling/agent/` and the availability
agent's dispatch in `domain/scheduling/availability/agent/`). This
directory used to also hold the booking agent's tool handlers,
dispatcher, and send wrapper — those moved to `domain/scheduling/agent/`
in Stage D2 (`docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md`) because they read
and write `AppointmentRequest`, drive the lifecycle FSM, and issue
vouchers: scheduling policy, not kernel mechanism.

## Layout

```
core/agent/tools/
├── idempotency.ts          hashToolCall, wasToolExecuted, markToolExecuted —
│                            Redis-backed, fail-closed, parameterized by an
│                            optional key prefix so both agents share one
│                            implementation without colliding on keys.
├── email-normalization.ts  normalizeEmailBody, normalizeAgentOutboundEmail —
│                            signature fixup + "Spill" subject prefix, shared
│                            by both agents' send paths.
└── README.md                you are here
```

Neither file's types or behavior depend on scheduling concepts
(`AppointmentRequest`, `Therapist`, conversation stages, …) — both would
be roughly correct in an ATS context with at most a rename, per
`core/README.md`'s test for what belongs in `core/`.
