# `core/email/`

Generic email-message handling — kernel infrastructure. Splits cleanly
into:

```
core/email/
├── inbound/
│   ├── process.ts                top-level orchestrator (Gmail message → handled)
│   ├── availability-routing.ts   route inbound to availability-collection agent
│   ├── nudge-reply.ts            therapist-nudge reply detection (threadId + sender fallback)
│   ├── weekly-mailing.ts         weekly promotional reply branch
│   ├── closure-auto-dismiss.ts   dismiss stale closure recommendation on incoming reply
│   ├── divergence-handling.ts    thread-divergence check + retry/abandon
│   ├── unmatched-attempts.ts     DB-authoritative unmatched-attempt tracking
│   ├── processing-failures.ts    MessageProcessingFailure CRUD + read helpers
│   ├── lock-renewal.ts           Redis lock renewal manager for long processing
│   ├── agent-processor.ts        AgentProcessor interface + DI registry
│   └── index.ts
├── outbound/
│   ├── send.ts                   sendEmail via Gmail API (threading preserved)
│   ├── queue.ts                  processPendingEmails — drain the queue with backoff
│   └── index.ts
├── index.ts                      emailMessageProcessorService object literal + exports
└── README.md                     you are here
```

## What does NOT live here

- The booking agent / availability agent themselves
  (`services/justin-time.service.ts`,
  `domain/scheduling/availability/agent/`). They're invoked from
  `inbound/process.ts` via the AgentProcessor DI interface, but their
  logic lives elsewhere.
- The dedup primitives — those moved to `core/messaging/message-dedup`
  in Phase 1b. `inbound/process.ts` calls the facade for
  `acquireMessageLock`, `markMessageProcessed`, `isMessageProcessed`,
  `shouldEmitProcessingAlert`, `releaseDbLock`.
- The thread divergence detector itself
  (`services/thread-divergence.service.ts`). Only the retry/abandon
  orchestration around it lives here in `divergence-handling.ts`.
- The MIME parser / email encoders (`utils/email-mime-parser.ts` and
  friends) — still in `utils/`, since they're consumed by both inbound
  and outbound.

## Public surface

The legacy `emailMessageProcessorService` singleton is preserved as an
object literal binding the standalone functions:

```ts
import { emailMessageProcessorService } from '../core/email';

emailMessageProcessorService.processMessage(...);
emailMessageProcessorService.sendEmail(...);
emailMessageProcessorService.processPendingEmails(...);
```

New code should prefer named imports:

```ts
import { processMessage, sendEmail } from '../core/email';
import { registerAgentProcessor } from '../core/email';
import { getLastProcessingErrors } from '../core/email';
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
`core/messaging/message-dedup`. The unmatched-attempt logic stays
local in `unmatched-attempts.ts` because it's DB-authoritative — the
facade's version is Redis-only with a different reliability shape;
aligning is a future PR.
