# `domain/scheduling/agent/`

Tool dispatch for the booking agent. Each tool Claude can call is a
single-purpose file under `handlers/`, with a thin orchestrator
(`dispatch.ts`) handling the cross-cutting concerns: human-control
gate, per-appointment ceiling, Redis idempotency, and audit emission.

Moved here from `core/agent/tools/` in Stage D2
(`docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md`): this module reads and
writes `AppointmentRequest`, drives the lifecycle FSM, and issues
vouchers — it's scheduling policy, not the domain-agnostic kernel
mechanism `core/README.md` reserves `core/` for. What genuinely is
generic mechanism (Redis tool-call idempotency, outbound-email
normalization) stayed behind in `core/agent/tools/`; this module
imports those two functions from there.

## Layout

```
domain/scheduling/agent/
├── dispatch.ts                 orchestrator + AIToolExecutorService class
├── send.ts                     sendAppointmentEmail (per-appointment Gmail wrap)
├── pure-tools.ts                PURE_TOOLS set (tools that bypass the gate)
├── tools-schema.ts             schedulingTools: the Claude tool schema block
│                                (passed to services/agent-tool-loop.ts)
├── handlers/
│   ├── resolve-local-time.ts           (pure, bypasses the gate)
│   ├── send-email.ts                   recipient validation + send wrapper
│   ├── update-therapist-availability.ts (writes recurring weekly schedule)
│   ├── mark-scheduling-complete.ts     confirm via lifecycle service
│   ├── cancel-appointment.ts           cancel via lifecycle service
│   ├── initiate-reschedule.ts          flag reschedule + clear datetime
│   ├── human-control.ts                flag_for_human_review + recommend_cancel_match
│   ├── issue-voucher-code.ts           voucher generation + persistence
│   ├── remember.ts                     agent-memory note write
│   ├── record-availability-window.ts   episodic window (user/therapist routing)
│   ├── record-booking-link.ts          therapist booking-link URL
│   ├── record-user-timezone.ts         User.timezone column
│   └── record-therapist-timezone.ts    Therapist.timezone column
├── index.ts
└── README.md                   you are here
```

`core/agent/tools/` still holds `idempotency.ts`
(`hashToolCall`/`wasToolExecuted`/`markToolExecuted`, fail-closed,
parameterized by key prefix) and `email-normalization.ts`
(`normalizeEmailBody`/`normalizeAgentOutboundEmail`) — both are used by
this module AND by the availability agent
(`domain/scheduling/availability/agent/tool-executor.ts`), and neither
one's types or behavior depend on scheduling concepts.

## The class collapsed (mostly)

`AIToolExecutorService` is preserved as a thin wrapper holding the
traceId — its only state. Methods delegate to free functions:

```ts
new AIToolExecutorService(traceId).executeToolCall(toolCall, context)
```

still works exactly as before. Behind the wrapper, the orchestrator
is the free function `executeToolCall(toolCall, context, traceId)`.
Two callsites use the class form (`justin-time.service` and the unit
test); new code can use the free function directly.

## Invariants preserved

1. **Pure tools bypass the gate.** `resolve_local_time` returns its
   computation regardless of human-control or idempotency state. The
   model needs the value to make decisions; gating would leave it
   blind.

2. **Atomic human-control gate.** `updateMany` with
   `humanControlEnabled: false` as a precondition. TOCTOU-safe — a
   human flipping control on between the agent's decision and the
   side effect produces `count: 0` and a `skipped` result.

3. **Per-appointment lifetime ceiling.** Peek-only at pre-flight;
   increment happens on success. Reaching `PER_APPOINTMENT_LIMIT`
   (~50) flags for human review.

4. **Redis idempotency (fail-closed).** Hash on
   (appointmentId, toolName, input). Fail-closed on Redis error —
   pauses tool activity until Redis recovers, scanner picks the
   conversation back up cleanly. Marking happens AFTER success so
   failed executions don't dedupe a real retry.

5. **Per-tool input validation.** Each handler validates with its
   own Zod schema and returns a structured `{success: false}` on
   bad input — the agent can re-prompt with corrected input rather
   than treating it as a hard failure.

6. **Security gates.**
   - `send_email`: recipient must be the user or therapist of this
     appointment.
   - `update_therapist_availability`: inbound must be from the
     therapist (the writeable target's owner).
   - `record_availability_window`: source='therapist' downgraded
     to 'user' (with a warn log) when inbound is not from the
     therapist.
   - `issue_voucher_code`: voucher email is forced to
     `context.userEmail` regardless of what the agent supplies.

## Migration notes

**Phase 2c:** this module was extracted from a single 1,789-line
`services/ai-tool-executor.service.ts`. Each tool that was a switch
branch inside `executeToolCall` is now its own handler file.

The previous file had several private class methods
(`sendEmail`, `markComplete`, `cancelAppointment`,
`flagForHumanReview`, `recommendCancelMatch`,
`updateTherapistAvailability`, `normalizeEmailBody`,
`resolveLocalTime`) that were called only from the dispatch switch.
Each became a free function: most live next to the tool's main
handler under `handlers/`, with the email-specific helpers originally
at the top level of the module since they're shared with potential
future handlers.

**Stage D2:** the whole module moved from `core/agent/tools/` to here
(`domain/scheduling/agent/`) — see the top of this file. Callsites
(`services/justin-time.service.ts`, `services/agent-turn-guard.ts`,
and the unit tests) were updated to import from
`domain/scheduling/agent` instead. `email-normalization.ts` and
`idempotency.ts` did NOT move; they're still `core/agent/tools/*` and
this module reaches back into `core/` for them (fine — only
`core/** → domain/**` is banned, not the reverse).
