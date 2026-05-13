# `domain/scheduling/availability/`

The availability bounded context. Owns:

- **The data model**: `AvailabilityWindow`, the parser/dedup/eviction
  primitives, the FIFO append helper. Used by both the per-appointment
  Layer B memory (`services/agent-memory.service.ts`) and the
  per-therapist `Therapist.upcomingAvailability` store.
- **The persistence layer for therapist-side availability**:
  `Therapist.upcomingAvailability` (episodic windows) and the booking-
  side formatter that renders the recurring weekly schedule.
- **The availability-collection agent**: a separate LLM agent (parallel
  to the booking agent in `services/`) whose only job is to ask
  therapists for upcoming windows and persist them.
- **Confirmed-datetime validation**: the resolver the booking
  executor calls before marking scheduling complete.

## Layout

```
availability/
  agent/
    service.ts          AvailabilityAgentService + supersession +
                        prompt builder.
    tools.ts            Anthropic tool definitions + side-effect /
                        terminal-tool sets.
    tool-executor.ts    Tool dispatcher with idempotency + pre-flight.
  windows/
    store.ts            Pure (hashing, parsing, append, format).
                        Shared with services/agent-memory.service.ts.
    therapist-store.ts  DB I/O against Therapist.upcomingAvailability.
    parser.ts           Day-string → slots, persistence shape builder.
    formatter.ts        Recurring-schedule slot generation + grouping.
  resolver.ts           Confirmed-datetime semantic validation.
  index.ts              Public surface.
  README.md             You are here.
```

## What does NOT live here

- The booking agent (which uses these as a read source).
- The recurring weekly schedule on `Therapist.availability` is written
  by the booking agent's `update_therapist_availability` tool (in
  `services/ai-tool-executor.service.ts`); the parser + persistence
  shape that tool uses lives here at `windows/parser.ts`.
- The booking-side timezone resolution: that's in `core/timezone/`.

## Migration note

Previously these 8 files were spread across `services/` with names
like `availability-agent.service.ts`,
`agent-availability-windows-store.ts`, etc. They were moved together
in one behaviour-preserving PR (Phase 1c of the refactor; see
`docs/REFACTOR_PLAN.md`). External callsites import from the barrel
(`domain/scheduling/availability`); tests that pin a specific
submodule import the submodule path directly.
