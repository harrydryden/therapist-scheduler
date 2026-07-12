# `domain/scheduling/inbound/`

Inbound Gmail-message routing for the scheduling product. Moved from
`core/email/inbound/` in Stage D3
(`docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md`): this pipeline matches
inbound emails to appointments, routes to the booking/availability
agents, detects therapist-nudge and weekly-mailing replies, and
auto-dismisses closure recommendations — none of it survives
`core/README.md`'s "would be roughly correct in an ATS context" test.

## Layout

```
domain/scheduling/inbound/
├── process.ts                 top-level orchestrator (Gmail message → handled)
├── availability-routing.ts    route inbound to availability-collection agent
├── nudge-reply.ts             therapist-nudge reply detection (threadId + sender fallback)
├── weekly-mailing.ts          weekly promotional reply branch
├── closure-auto-dismiss.ts    dismiss stale closure recommendation on incoming reply
├── divergence-handling.ts     thread-divergence check + retry/abandon
├── unmatched-attempts.ts      DB-authoritative unmatched-attempt tracking
├── agent-processor.ts         AgentProcessor interface + DI registry
├── index.ts
└── README.md                  you are here
```

`process.ts` reaches back into `core/` for the genuinely generic
mechanism it needs: `core/messaging/message-dedup` (atomic lock + dedup
gate), `core/email/inbound/lock-renewal` (long-processing lock
renewal), and `core/email/inbound/processing-failures` (retry-budget
bookkeeping). That's the intended dependency direction — `domain/**` is
free to import `core/**`; only the reverse is banned.

## The agent-processor DI registry — deliberately NOT dissolved yet

The refactor plan's original wording for this stage says the DI
registry "dissolves — the domain can import its own agent directly."
That's not done here. The registry exists to break a circular import:
`process.ts` needs to call `JustinTimeService`, but `JustinTimeService`
transitively imports back into email-sending code that (before this
move) touched `core/email`'s barrel, which re-exported `process.ts`
itself — a cycle. Moving `process.ts` out of `core/email/inbound/`
removes the specific path that made that cycle real (the barrel no
longer touches this module's graph at all), so switching to a direct
`import { JustinTimeService } from '../../../services/justin-time.service'`
call is very likely safe. But `tsc` and Jest (which mocks the module
graph heavily) can't fully rule out a subtler CommonJS
require-ordering issue that would only surface at real server boot —
and this is the Gmail-webhook entry point, not a low-traffic path.
Verifying that needs an actual server-boot smoke test this sandbox
can't run with confidence. Left as a deliberate follow-up rather than
risked in a move PR.

## What did NOT move

`processing-failures.ts` (generic `MessageProcessingFailure` CRUD,
keyed only on `messageId` — no appointment fields) and
`lock-renewal.ts` (generic Redis lock-renewal manager) stayed in
`core/email/inbound/` — see that directory's README.
