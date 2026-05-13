# `core/messaging/`

Generic message-handling primitives. Domain-agnostic — these modules
don't know what an `AppointmentRequest` is and could be lifted into
an ATS context as-is.

## `message-dedup.ts` — Single entry point for message deduplication

The system tracks "have we seen this Gmail message yet" through five
separate primitives that were added incrementally over time:

| Primitive | Purpose | TTL |
|---|---|---|
| Redis ZSET `gmail:processedMessages` | Fast-path "is it processed?" | 30 days |
| Redis lock `gmail:lock:message:<id>` | Per-message processing lock | 5 min |
| Redis key `gmail:unmatched:<id>` | Unmatched-attempt counter | 1 hour |
| Redis key `gmail:processingAlertDedup:<id>` | Slack-alert dedup | 1 hour |
| DB `ProcessedGmailMessage` | Authoritative "is it processed?" | ∞ (until stale-check sweep) |

These same primitives are touched from six different services
(`email-message-processor`, `email-ingest`, `missed-message-scanner`,
`chase-email`, `stale-check`, `admin.routes`). When the contract
changes — e.g. when we added the post-match `MAX_PROCESSING_FAILURES`
budget — keeping all six in lockstep is a tax.

`message-dedup.ts` is the single API surface that future callers
should use. It wraps the atomic Redis Lua script + DB fallback that
`email-message-processor.processMessage` already implements, so the
behaviour is preserved but the call site for the contract is now one
file.

### Migration policy

This PR introduces the facade WITHOUT migrating the existing
callsites. New code that needs to dedup messages MUST go through this
module. The existing callsites will be migrated in follow-up PRs,
one service at a time, with the lifecycle integration test
(`__tests__/integration/lifecycle.integration.test.ts`) as the gate.

See `docs/REFACTOR_PLAN.md` § "Dedup callsite migration" for the
sequencing.
