# `core/email/`

Generic email-message handling — kernel infrastructure. Splits cleanly
into:

```
core/email/
├── inbound/
│   ├── processing-failures.ts    MessageProcessingFailure CRUD + read helpers
│   ├── lock-renewal.ts           Redis lock renewal manager for long processing
│   └── index.ts
├── outbound/
│   ├── send.ts                   sendEmail via Gmail API (threading preserved)
│   ├── queue.ts                  processPendingEmails — drain the queue with backoff
│   └── index.ts
├── index.ts                      emailMessageProcessorService object literal + exports
└── README.md                     you are here
```

Stage D3 (see `docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md`) moved everything
else that used to live under `inbound/` — `process.ts` (the orchestrator),
`availability-routing.ts`, `nudge-reply.ts`, `weekly-mailing.ts`,
`closure-auto-dismiss.ts`, `divergence-handling.ts`,
`unmatched-attempts.ts`, and `agent-processor.ts` — to
`domain/scheduling/inbound/`. All of it read/wrote `AppointmentRequest`,
routed to the booking/availability agents, or was typed on scheduling
concepts (finding #5): scheduling policy, not kernel mechanism. What's
left here is generic per-message bookkeeping (failure tracking, lock
renewal) that `domain/scheduling/inbound/process.ts` imports back from
`core/` — domain depending on core is the intended direction.

## What does NOT live here

- The booking agent / availability agent themselves
  (`services/justin-time.service.ts`,
  `domain/scheduling/availability/agent/`), nor the inbound routing that
  invokes them (`domain/scheduling/inbound/`, see above).
- The dedup primitives — those moved to `core/messaging/message-dedup`
  in Phase 1b. `domain/scheduling/inbound/process.ts` calls the facade
  for `acquireMessageLock`, `markMessageProcessed`, `isMessageProcessed`,
  `shouldEmitProcessingAlert`, `releaseDbLock`.
- The thread divergence detector itself
  (`services/thread-divergence.service.ts`). Only the retry/abandon
  orchestration around it lives in `domain/scheduling/inbound/divergence-handling.ts`.
- The MIME parser / email encoders (`utils/email-mime-parser.ts` and
  friends) — still in `utils/`, since they're consumed by both inbound
  and outbound.

## Public surface

The legacy `emailMessageProcessorService` singleton is preserved as an
object literal binding the standalone functions (outbound only —
`processMessage` moved to `domain/scheduling/inbound/`, see above):

```ts
import { emailMessageProcessorService } from '../core/email';

emailMessageProcessorService.sendEmail(...);
emailMessageProcessorService.processPendingEmails(...);
```

New code should prefer named imports:

```ts
import { sendEmail } from '../core/email';
import { getLastProcessingErrors } from '../core/email';
import { processMessage, registerAgentProcessor } from '../domain/scheduling/inbound';
```

## Invariants preserved

1. **Atomic lock + dedup gate.** Uses `core/messaging/message-dedup`'s
   `acquireMessageLock` which wraps the Lua-script lock acquisition
   and the serializable-transaction DB fallback. Semantics unchanged.

2. **Belt-and-braces DB re-check.** After a Redis-path acquire, we
   still re-check the DB for `processedGmailMessage` — catches the
   case where Redis was flushed but the authoritative row still exists.

3. **Lock renewal during long processing.** Thread fetches + Claude
   calls can each take 30+ seconds; the renewal manager extends the
   5-min TTL every 60s. If renewal fails (another worker took the
   lock), `isLockValid()` flips false and the `finally` block skips
   the release.

4. **DB-fallback lock cleanup on failure.** When Redis was unavailable
   and processing fails, `releaseDbLock` removes the placeholder
   `processedGmailMessage` row so the scanner can retry.

5. **First-failure visibility + abandonment.**
   `shouldEmitProcessingAlert` (facade-backed dedup) gates the first
   Slack alert per (messageId, 1-hour window); `MAX_PROCESSING_FAILURES`
   bounds the retry budget; abandonment fires a high-severity Slack
   alert and marks the message permanently processed.

6. **ConcurrentModificationError is benign.** Doesn't count as a real
   failure — returns false so the scanner retries on the next pass.

## Migration note (Phase 2b)

The previous monolithic `services/email-message-processor.service.ts`
(1,837 lines) split here. The `EmailMessageProcessorService` class
collapsed into an object literal — none of its methods used `this`
state, just like the lifecycle service in Phase 2a.

The dedup migration happened in the same PR: direct calls to
`redis.eval(ATOMIC_LOCK_CHECK_SCRIPT, ...)` and
`prisma.processedGmailMessage.upsert(...)` are now routed through
`core/messaging/message-dedup`. The unmatched-attempt logic (now in
`domain/scheduling/inbound/unmatched-attempts.ts`, moved there in Stage
D3) stays DB-authoritative rather than using the facade's Redis-only
version, which has a different reliability shape; aligning the two is
still a future PR.
