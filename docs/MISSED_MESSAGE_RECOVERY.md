# Missed Message Recovery — Operations Guide

This document covers everything you need to know about the missed-message
scanner, processing failure tracking, and how to recover messages that the
agent failed to process.

## Background

Production briefly went into a state where the missed-message scanner was
silently failing for every message because of a missing Prisma migration
(`booking_method` column). The post-incident hardening introduced several
new mechanisms — this doc explains them and how to use them when something
goes wrong.

---

## How the system works

### The happy path

1. A user or therapist email arrives via Gmail push notification
2. `email-message-processor.processMessage()` matches it to an appointment
3. The AI agent processes the reply
4. The Gmail message ID is recorded in `processed_gmail_messages` (dedup)

### The recovery path (when push notifications fail)

Push notifications can be lost for many reasons (server restarts, Pub/Sub
outages, network blips). The **missed-message scanner** is the safety net:

1. Runs every hour (`MISSED_MESSAGE_SCANNER_INTERVALS.SCAN_INTERVAL_MS`)
2. Scans every active appointment thread
3. For each Gmail message not in `processed_gmail_messages`, calls
   `processMessage()` to recover it
4. Writes a heartbeat to Redis on every successful scan completion

### When recovery itself fails

`processMessage()` can fail for many reasons (Claude API outage, schema
drift, conversation state corruption, etc.). When it does:

1. The error is recorded in `message_processing_failures` (DB) with the
   error text and an attempt counter
2. A Slack alert fires on the **first** failure (deduped per-message for 1h)
   so you see the actual error immediately
3. The scanner re-discovers the message every hour and retries
4. After `MAX_PROCESSING_FAILURES` (3) attempts, the message is **abandoned**:
   marked as processed in the dedup table, marked `abandoned=true` in
   `message_processing_failures`, and a high-severity Slack alert fires
5. Abandoned messages stop blocking the scanner but require manual recovery

The retry budget exists because some failures are transient (rate limits,
optimistic-lock conflicts) and some are persistent (schema drift, broken
conversation state). The budget gives transient failures a chance to recover
on their own while breaking infinite loops on persistent failures.

---

## Diagnostic surfaces

### Admin "Scan Messages" preview

In the appointment detail panel, the **Scan Messages** button calls
`previewThreadMessages()` which lists every message in the thread with its
processing status. For unprocessed messages, the **last error text** is
shown inline (sourced from `message_processing_failures.last_error`). This
is the fastest way to see WHY a specific message is stuck.

### `/health/full`

Returns the scanner health under `checks.missedMessageScanner`:

```json
{
  "running": true,
  "intervalMinutes": 60,
  "consecutiveSkips": 0,
  "lastScanAt": "2026-04-07T11:30:00.000Z",
  "secondsSinceLastScan": 145,
  "healthy": true
}
```

`healthy` is `true` only if the scanner is running AND has completed a
scan within the last 2× scan interval (with a 5-minute floor). If
`healthy: false`, something is wrong — check process status, OAuth token,
and Redis connectivity.

### Slack alerts

| Alert title | Severity | When |
|---|---|---|
| `Message Processing Failed` | medium | First failure for a given message ID, deduped 1h |
| `Message Processing Abandoned` | high | After 3 consecutive failures — manual review required |
| `Missed Messages Recovered` | medium/high | Scanner successfully recovered ≥1 messages |
| `Missed Message Scanner Unhealthy` | high | 3 consecutive scan cycles skipped (OAuth, lock contention, etc) |
| `Closure Recommendation Auto-Dismissed` | medium | Reply arrived on a closure-recommended thread |

---

## Recovery playbook

### Symptom: Slack alert "Message Processing Failed" or "Abandoned"

The alert includes the actual error text in a code block. Common causes:

| Error | Cause | Fix |
|---|---|---|
| `column "X" does not exist` | Missing Prisma migration | Add migration; deploy; retry abandoned messages |
| `Conversation state not found` | Corrupted/missing `conversation_state` JSON | Inspect appointment, possibly reset state via admin tools |
| `request too large for model` | Thread context exceeds Claude context window | Truncate thread or summarise; one-off intervention |
| `Optimistic locking conflict` | Race between concurrent processors — usually transient | Should self-heal; if persistent, investigate concurrent triggers |
| `Anthropic API error` | Rate limit / outage | Wait and retry |

### Symptom: messages still showing as MISSED after a fix

When you fix the underlying issue (e.g. run a missing migration), abandoned
messages **do not auto-recover** — they're still marked as processed in the
dedup table. You need to explicitly retry them.

**Option A — Per-thread, via UI**: open the appointment, click **Scan
Messages**, then click **Recover N Messages**. This force-clears the dedup
records for the messages on that thread and triggers reprocessing.

**Option B — Bulk, via API**: use the admin retry endpoint to clear all
abandoned failures at once:

```bash
curl -X POST https://your-backend/api/admin/processing-failures/retry \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"all": true}'
```

This:
1. Finds every `message_processing_failures` row with `abandoned=true`
2. Deletes them from `processed_gmail_messages` (dedup)
3. Deletes them from `message_processing_failures` (counter resets)
4. Triggers an immediate scanner run
5. Returns a JSON summary

For a targeted retry of specific messages:

```bash
curl -X POST https://your-backend/api/admin/processing-failures/retry \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"messageIds": ["msg-id-1", "msg-id-2"]}'
```

To list current failures before retrying:

```bash
curl https://your-backend/api/admin/processing-failures?abandoned=true \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET"
```

### Symptom: scanner is unhealthy (Slack alert "Scanner Unhealthy")

The scanner has been skipping its work cycle. Common causes:

1. **OAuth token expired/invalid** — check `getTokenStatus()` via the admin
   endpoint. Re-auth via `POST /api/admin/gmail/setup-push`.
2. **Lock contention** — another instance holds the distributed lock.
   Should self-resolve once the other instance releases. If stuck, check
   Redis for `missed-message-scanner:processing-lock`.
3. **Process crashed/hung** — heartbeat stale. Restart the backend service.

### Symptom: closure recommendation reappears for a thread that just received a reply

The closure auto-dismiss should fire automatically when a reply matches an
appointment with a pending closure recommendation. Exception: it skips
auto-replies / out-of-office messages (gated on the email classifier's
`isAutoReply` flag) so a vacation responder doesn't undo a valid closure
signal.

If a real reply arrived but closure wasn't dismissed:
1. Check the email classifier output — it may be falsely tagging the email
   as an auto-reply
2. Check the audit log for the appointment for a `checkpoint_update` event
   with `action: closure_dismissed`
3. Use the admin "Dismiss" button manually as a fallback

---

## Schema drift prevention

The `booking_method` incident happened because a schema change shipped
without a corresponding migration. Two new mechanisms guard against
recurrence:

### 1. Integration test (`src/__tests__/integration/`)

Runs `prisma db push` against a real Postgres test database, then issues
`findUnique()` and `findMany()` with no-select clauses against every model.
Any column-level drift between `schema.prisma` and the Prisma client
surfaces as a runtime error.

Run locally:
```bash
TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/test_db" \
  npm run test:integration
```

Skipped automatically when `TEST_DATABASE_URL` is unset, so unit test runs
remain Postgres-free.

### 2. Schema drift CI guard (`scripts/check-schema-migration.js`)

Diffs the current branch against `origin/main` and fails if `schema.prisma`
was modified without a corresponding new migration file in the same diff.

Run locally:
```bash
npm run check:schema-migration
```

Wire into CI as a required check on every PR.

---

## Reference: Redis keys and DB tables

### Redis keys

| Key / prefix | Purpose | TTL |
|---|---|---|
| `gmail:processedMessages` | Dedup ZSET (legacy fast-path) | 30d |
| `gmail:lock:message:<id>` | Per-message processing lock | 5m |
| `gmail:processingFailure:<id>` | Cached failure attempt count | 7d |
| `gmail:processingAlertDedup:<id>` | First-failure Slack alert dedup | 1h |
| `gmail:unmatched:<id>` | Cached unmatched-attempt count | 1h |
| `missed-message-scanner:heartbeat` | Last successful scan timestamp | 24h |
| `missed-message-scanner:processing-lock` | Distributed scanner lock | 10m |

### Database tables

| Table | Purpose |
|---|---|
| `processed_gmail_messages` | Authoritative dedup record (id + processedAt) |
| `message_processing_failures` | Per-message failure tracking (attempts, lastError, abandoned) |
| `unmatched_email_attempts` | Per-message unmatched tracking |
| `appointment_audit_events` | Append-only audit log including `checkpoint_update` events for closure dismissal |

The DB is the source of truth for failure tracking — Redis is just a cache.
This is the lesson from the booking_method incident: a Redis-only counter
returned `1` forever when Redis was unavailable, so abandonment never
triggered and the scanner looped indefinitely.
