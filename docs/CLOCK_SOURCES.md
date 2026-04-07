# Clock-Source Convention

This is a brief reference for how the codebase handles timestamps. The
issue surfaced during the post-incident hardening review (Phase 10):
the codebase has three implicit clock sources that are mostly fine for
single-instance deployments but could produce subtle off-by-minutes
bugs in a multi-instance setup.

## TL;DR

**Use the application clock (`new Date()`) for everything.** Single
instance, NTP-synced, no drift to worry about. The only time the DB
clock is acceptable is for `@default(now())` on insert columns where
the application doesn't compute the timestamp.

## The three clock sources

### 1. Application clock — `new Date()` / `Date.now()`

Used by:
- All lifecycle service writes (`lastActivityAt`, `confirmedAt`, etc.)
- `stale-check` thresholds (`Date.now() - X * MS`)
- Scanner heartbeats
- `closureRecommendedAt`
- `chaseSentAt`
- All `lastFailedAt` / `firstFailedAt` on `MessageProcessingFailure`

This is the dominant source. **Default to this.**

### 2. Database clock — `@default(now())` in Prisma schema, `NOW()` in raw SQL

Used by:
- `createdAt` defaults on every model
- `processedAt` default on `ProcessedGmailMessage`
- The atomic SQL audit-message append in `addAuditMessage` (uses `NOW()`)

This is acceptable when the application doesn't compute the value
itself — Prisma defaults are fine because they're inserted at row
creation time and never compared against application timestamps.

The risk is when an application timestamp gets compared against a
DB-generated timestamp in a query. We don't currently do this.

### 3. Gmail header dates — `new Date(messageHeaders.date)`

Used by:
- `parseEmailMessage` to extract the email's claimed send time

These are sender-controlled and should never be used for authoritative
ordering or timeout decisions. They're used for display only.

## Why this only matters at scale

At single-instance deployment with NTP-synced server clocks, all three
sources agree to within a few milliseconds. The convention exists for
the day someone runs a second instance or the day someone runs a
maintenance script from a workstation that hasn't synced its clock.

In particular, `stale-check` computes:

```ts
const threshold = new Date(Date.now() - chaseAfterHours * 60 * 60 * 1000);
const candidates = await prisma.appointmentRequest.findMany({
  where: { lastActivityAt: { lt: threshold } },
});
```

`threshold` is computed on the app clock. `lastActivityAt` was written
by the app clock too. They're consistent. But if a future query mixed
`Date.now()` with a DB-generated timestamp, you'd get drift on the
order of the clock skew between the app instance and Postgres.

## Rules of thumb

- **Writing a timestamp** → `new Date()` from the application
- **Reading a timestamp for comparison** → assume it was written by the
  application clock; use `new Date()` to compute the comparison value
- **Default-on-insert timestamps** → fine to use `@default(now())` in
  Prisma; just don't compare them against app-clock values in the same
  query without thinking about skew
- **Email header dates** → display only, never authoritative
- **Cron schedules** → server time is fine; document the timezone
  expectation explicitly (`general.timezone` setting handles this)

## Future scaling note

If we ever run multiple backend instances behind a load balancer:
- Verify all instances run NTP (chrony or systemd-timesyncd)
- Consider switching `stale-check` thresholds to DB-generated via
  `prisma.$queryRaw` so all instances see the same threshold
- Audit any place that compares an `app-clock` value against a
  `DB-clock` value (search for `@default(now())` columns in WHERE
  clauses)

For now (single instance, ~100 appointments/day), the current setup
is correct and no action is needed.
