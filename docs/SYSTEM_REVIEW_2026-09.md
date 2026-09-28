# System Review — September 2026

> **What this is.** A whole-system review of the Therapist Scheduler run on
> 28 September 2026 against `main` at `cb4f3ad`. Eight parallel audits
> (security; lifecycle & concurrency; agent harness; inbound email; data
> model & deploy; frontend & UX; operations; conflicts & drift) read the
> code end to end, reproduced the important claims against the real
> modules (and, where it mattered, a throwaway PostgreSQL 16), and fed
> verified fixes into PR #318. This document records what was fixed and,
> more importantly, the **high-impact opportunities that remain**, ranked
> so the team can plan the next few cycles.
>
> Every item names the file(s) so it can be picked up cold. Severity is
> the reviewer's judgement of real-world impact, not theoretical risk.

## Contents

1. [Headline findings](#1-headline-findings)
2. [Fixed in PR #318](#2-fixed-in-pr-318)
3. [High-impact opportunities (ranked)](#3-high-impact-opportunities-ranked)
4. [Opportunities by area](#4-opportunities-by-area)
5. [Refactors worth doing](#5-refactors-worth-doing)
6. [Conflicts to resolve (two sources of truth)](#6-conflicts-to-resolve)
7. [Docs drift](#7-docs-drift)
8. [CI: what to run](#8-ci-what-to-run)
9. [What is done well](#9-what-is-done-well)

---

## 1. Headline findings

Three systemic defects were hiding behind a green test suite. All three
were confirmed independently by more than one audit and are fixed in
PR #318:

1. **The agent forgot its place every turn.** `parseConversationState`
   used a zod object that only declared `systemPrompt` and `messages`, so
   `checkpoint`, `facts` and `responseTracking` were stripped on every
   load. Each reply turn started at `initial_contact`, the denormalised
   `checkpointStage` column was reset by the mid-turn save, facts never
   accumulated, and chases were aimed at the wrong party. The code even
   carried a comment admitting the schema "strips it on the way out".
2. **The agent's end-of-turn save lost to its own tool writes.**
   Conversation state used `updatedAt` as its optimistic-lock version, but
   the dispatch gate (`updateMany` setting `lastToolExecutedAt`), the
   outbound thread stamps and every lifecycle transition bump
   `@updatedAt`. The final save matched zero rows on almost every
   tool-using turn, threw `ConcurrentModificationError` (deliberately not
   retried), and wrote a `[COMPENSATION …]` note. Reproduced at the SQL
   level against Postgres.
3. **Conversation state was stored double-encoded.** `JSON.stringify`
   output was written into a `Json` column, so `jsonb_typeof` was
   `string`. Every lifecycle audit note (`jsonb_set` on a scalar → SQL
   error 22023) was silently dropped and two migrations' backfills were
   no-ops.

Beyond those, the review found that several "fail-closed" guards
actually failed open (the Redis wrapper swallowed errors), that inbound
email could be forged or misread in ways that cancel live appointments,
and that the admin dashboard had five buttons that never worked.

---

## 2. Fixed in PR #318

_See the PR description for the authoritative list and the per-commit
detail. Summary by theme:_

**Conversation-state integrity** — parser preserves checkpoint/facts/
response-tracking; trim preserves them; a dedicated `conversationVersion`
column replaces `updatedAt` as the CAS version (migration included);
state is stored as a JSON object with an idempotent normalisation of
existing rows; unknown senders are classified as `unknown` rather than
`therapist`; handlers no longer report a lost transition race as
success.

**Security** — weekly-mailing replies pinned to the verified sender and
raw email headers guarded against CR/LF injection; forged display-name
senders parsed correctly; `record_booking_link` / `record_therapist_timezone`
require a therapist sender and http(s) URLs; brute-force limiter and tool
idempotency genuinely fail closed; admin secret and one-click tokens no
longer written to request logs; SSE route under the limiter; CSV
formula-injection neutralised; byte-safe constant-time compare; readiness
probe stops echoing driver errors; production container no longer serves
backend compiled JS; public signup cannot re-subscribe an opted-out
address.

**Inbound email** — nested MIME parts (attachments, signature logos) are
read; delay notices and ordinary replies are no longer treated as
bounces; post-session appointments are never auto-cancelled by a bounce;
same-therapist rebooks no longer trip the divergence block; old messages
are not replayed after dedup expiry; bulk failure retry clears Redis;
availability-agent failures retry instead of misrouting; `stripHtml`
no longer quadratic.

**Lifecycle / outbox** — a side effect that succeeded is never re-run
because its completion mark failed; the cancelled Slack alert is not sent
twice; single release-control resets the tool ceiling; the session_held
tick cannot promote a mid-reschedule row; WAL recovery cannot drop an
email on a DB error.

**Operations** — trust-proxy wired so per-IP limits are per client;
graceful shutdown ends SSE streams first and force-exits at 30s; agent
processor registered before the port opens; Redis command latency
bounded; weekly mailing fails safe when its send-once guard is
unreadable; retention honours the admin settings; inquiry retention
matches the real status; compose file validates.

**Frontend** — lint config restored (`lint:all` works); bodyless admin
POSTs (reset setting, Slack test, reset circuit, send mailing, generate
report) no longer 400; bad voucher links no longer crash the public site;
closure "cancel" has a confirm + toast; feedback prefill works and a
failed submit keeps the answers; post-Notion therapists selectable when
creating appointments; delete errors visible; bulk invite capped
client-side; "Book now" only opens the external calendar after the
request succeeds; undefined Tailwind classes fixed; login verifies the
secret and shows lockout state.

**Tests** — the time-bombed "keeps Sunday slots" test fixed at the root
(slot generation anchored on `referenceDate`); regression tests added
for every fix above.

---

## 3. High-impact opportunities (ranked)

Effort: **S** = hours, **M** = a day or two, **L** = a week+.

| # | Opportunity | Why it matters | Where | Effort |
|---|---|---|---|---|
| 1 | **Persist the weekly-mailing "last sent" marker in Postgres, with a per-user `lastWeeklyMailingAt`.** | The only send-once guard is a Redis key. PR #318 makes an unreadable guard fail safe, but a lost/evicted key still re-blasts every subscriber once. The mailing shares the transactional Gmail mailbox, so a repeat blast can exhaust the daily send cap and stall agent replies. | `services/weekly-mailing-list.service.ts` | S |
| 2 | **Stop counting infrastructure errors against the 3-strike abandon budget.** | `CircuitBreakerError`, 429s after retries, 5xx and timeouts all count. Push at t=0 plus polls at ~3 and ~6 min abandon a message during a 10-minute Anthropic blip, one Slack alert per email, each needing manual retry. Classify infra errors as "defer without counting" (or time-based backoff). Also move the circuit breaker around each attempt, not the whole sleep loop: a single 429 probe holds the breaker half-open for up to ~111 minutes. | `domain/scheduling/inbound/process.ts`, `utils/resilient-call.ts`, `utils/circuit-breaker.ts` | M |
| 3 | **Verify email ownership before a booking creates side effects.** | A booking needs no proof of ownership; one fake booking per therapist marks every therapist `in_session` and empties the public directory, and each one emails a therapist and starts a paid Claude turn. Options: magic-link confirmation before the agent starts, or require a voucher that was emailed to the address. | `routes/appointments.routes.ts`, `services/therapist-booking-status.service.ts` | M |
| 4 | **Make retention safe for graduated therapists.** | Therapist availability is computed live from `COUNT(DISTINCT user_email) WHERE status='completed'`. Retention hard-deletes `completed` rows after 365 days and admin delete only guards `confirmed`, so a graduated therapist silently reappears on the finder. Persist a per-therapist completed-client count (or graduation timestamp) and read that; require force + reason to delete any post-booking row; write a tombstone audit row that isn't cascaded. | `services/stale-check.service.ts`, `routes/admin/appointments/delete.ts`, `services/therapist-booking-status.service.ts` | M |
| 5 | **Replace `baseline.sh` with plain `prisma migrate deploy` and check in a replayable `0_init` migration.** | Verified: a fresh DB and a `db push` DB both crash-loop on boot, and the fallback marks unapplied migrations as applied on *any* failure (including a transient connection error). The migration history also cannot describe the real schema (dead enum migration; FK, unique tracking code and index names created by no migration). One idempotent reconcile migration after `\d` in prod fixes the drift. | `prisma/baseline.sh`, `prisma/migrations/*`, `scripts/docker-entrypoint.sh` | M |
| 6 | **Short-lived SSE ticket instead of `?secret=`.** | The dashboard still passes the admin secret in a URL (now redacted from logs, and limited). Mint a 60-second single-use ticket from an authenticated POST and open the EventSource with it; then rotate `WEBHOOK_SECRET`. Longer term: real admin sessions (httpOnly cookie) and a separate ATS credential — one shared secret currently covers dashboard, ATS and admin email sending, and `adminId` is self-asserted. | `routes/admin-monitoring.routes.ts`, `frontend/src/hooks/useSSE.ts`, `middleware/auth.ts` | M / L |
| 7 | **Paginate Gmail `history.list`, and never let watch renewal move the checkpoint backwards.** | No `pageToken` anywhere: anything past the first 100 history records is skipped (our own sent mail counts, so a mailing blast exceeds it). Watch renewal on every boot resets the checkpoint to the mailbox's current position. The 3-minute poll only looks at 20 messages, and UNREAD is only cleared after a successful agent turn, so the fallbacks don't cover the gap. | `services/gmail-watch.service.ts`, `services/email-ingest.service.ts`, `services/email-polling.service.ts` | M |
| 8 | **Atomic claim (`pending → sending`) for outbound email.** | The BullMQ worker and the DB poller both consume the same `pending_emails` rows with "check status → send", on nearly identical backoff schedules; the Redis send-guard is set only after Gmail returns. Duplicate sends are possible under retry. | `services/email-queue.service.ts`, `core/email/outbound/queue.ts` | M |
| 9 | **Alert when an outbound email is abandoned, and when a circuit breaker opens.** | A permanently failed email only appends a note; the stall-alert path skips it and the flag is cleared within the hour. During an `invalid_grant` outage every reply is silently abandoned. Breaker OPEN (Claude, Gmail) and watch-renewal failures are logged, never alerted. | `services/email-queue.service.ts`, `core/email/outbound/queue.ts`, `utils/circuit-breaker.ts`, `services/gmail-watch.service.ts` | S |
| 10 | **Bound the conversation blob and add prompt caching to the booking loop.** | Each inbound stores a full copy of the Gmail thread; the size cap isn't checked below 100 messages and the 500 KB read limit is below the trim limit, so a long thread eventually fails every turn with "Conversation state not found". Input tokens grow steeply; the availability loop uses prompt caching, the booking loop does not. Add a daily token budget with an alert; set SDK `maxRetries: 0` (stacked retries currently allow ~24 HTTP attempts per call). | `services/ai-conversation.service.ts`, `services/agent-tool-loop.ts`, `services/justin-time.service.ts` | M |
| 11 | **Dashboard tiles and lists should be server-filtered.** | The dashboard fetches one page of 100 rows sorted by `updatedAt` and filters tiles in the browser. Paused/red appointments stop getting updates, sink below row 100 and vanish from the exact tiles an admin needs. Add multi-status / `humanControl` / `health` filters and take counts from `/stats`. | `frontend/src/pages/AdminDashboardPage.tsx`, `routes/admin/appointments/list-dashboard.ts`, `schemas.ts` | M |
| 12 | **Cut over Phase 3b (`AppointmentConversation`) or drop the mirror.** | Dual-write has run since May; nothing reads the new table, every turn writes ~500 KB twice, and two remediation scripts skip the mirror. Decide, then delete the dead half. | `docs/REFACTOR_PLAN.md`, `services/ai-conversation.service.ts`, `src/scripts/*` | M |
| 13 | **One-click unsubscribe headers and a POST unsubscribe.** | Bulk mail carries no `List-Unsubscribe` / `List-Unsubscribe-Post` headers (Gmail/Yahoo bulk-sender requirements), and the unsubscribe link mutates on GET, so link scanners can unsubscribe users. | `core/email/outbound/send.ts`, `services/weekly-mailing-list.service.ts`, `routes/unsubscribe.routes.ts` | S |
| 14 | **Pin Node 22 and add a CI workflow.** | Node 18 (EOL April 2025) in the Dockerfile; `.npmrc if-present=true` makes a missing CI script pass silently; no `.github` at all. See §8. | `Dockerfile`, `package.json`, `.npmrc`, `.github/workflows` | S |
| 15 | **Turn serialisation on by default.** | `agent.turnSerialization` is off. Two quick replies run parallel turns; the losing save is discarded while the message is still marked processed. | `config/setting-definitions.ts` | S |

---

## 4. Opportunities by area

### 4.1 Security

- **Prompt-injection surface.** The client's name, email bodies and PDF
  text go into prompts with delimiter wrapping but no escaping of the
  delimiters themselves, and injection detection only logs. Escape the
  wrapper tokens inside untrusted text; consider a hard block above a
  confidence threshold. (`system-prompt-builder.ts`, `utils/prompt-safety`)
- **Markdown link `href`s in outbound mail are not escaped** (HTML
  injection into our own emails). (`utils/email-html-body.ts`)
- **`dispatch.ts` logs full outbound email bodies** and several paths log
  URLs containing tokens. Redaction covers only one nesting level. Add a
  `redact` list to the pino root logger and truncate bodies. (`domain/scheduling/agent/dispatch.ts`, `utils/logger.ts`)
- **Public `/api/signup` never proves ownership** and overwrites name and
  country (which drives the timezone shown in every email), resets voucher
  strikes, and sends a welcome email with no per-address cap. Add a
  confirmation step or at least rate-limit per address. (`routes/signup.routes.ts`)
- **Pub/Sub token check accepts any Google service-account token** when
  `GOOGLE_PUBSUB_AUDIENCE` is unset; on the gap path a forged
  notification's `historyId` becomes the checkpoint. Make the audience
  mandatory in production. (`routes/email-webhook.routes.ts`, `config/pubsub-warnings.ts`)
- **PDF upload trusts the declared content type; `pdf-parse` 1.x has no
  timeout.** (`routes/ingestion.routes.ts`, `services/pdf-ingestion.service.ts`)
- **Duplicate-check message on booking reveals whether an email already
  has an appointment with a therapist.** Return a generic message. (`routes/appointments.routes.ts`)
- **The Vercel-relayed path shares one client IP.** Public forms call `/api`
  through Vercel's rewrite, so with `TRUSTED_PROXY_DEPTH=1` all form traffic
  keys on Vercel egress IPs. Set the depth to match the real chain, or point
  the public forms directly at the API host. (`vercel.json`, `server.ts`)

### 4.2 Agent harness

- **Check `stop_reason`.** The loop never inspects it; `max_tokens` is 1024
  with extended thinking on by default, so a truncated tool call may run
  and a refusal or empty reply counts as a natural finish. (`agent-tool-loop.ts`)
- **Handlers that report success when nothing happened**: a failed email
  send, a skipped confirmation, an availability update that parsed no
  slots. Audit every handler's `success` semantics. (`domain/scheduling/agent/handlers/*`)
- **Per-call idempotency has no per-turn scope and a 1-hour TTL**, so a
  legitimately repeated call in a later turn (a second chase with identical
  arguments) can be skipped. Include a turn id in the hash. (`core/agent/tools/idempotency.ts`)
- **A Claude failure mid-turn replays the whole turn**, which can resend an
  email; one broken conversation can open the shared circuit breaker for
  every agent. (`services/justin-time.service.ts`, `utils/resilient-call.ts`)
- **`mark_scheduling_complete` prefers the freeform date over the
  structured one** when both are supplied, and reads it as UK time. Prefer
  the structured form. (`handlers/mark-scheduling-complete.ts`)
- **Repeat human-review alerts are deduped for 24 h**, so a re-pause on the
  same appointment is silent. (`services/admin-notification.service.ts`)
- **Escalation UX**: when a guard trips, the client/therapist receives
  nothing. Consider an automatic "a colleague will follow up" holding
  reply. (`services/agent-tool-loop.ts`)

### 4.3 Inbound email

- **Redis-down fallback marks messages processed before processing** and
  only unmarks on the generic error path (unmatched-within-budget,
  divergence retry, optimistic-lock conflict, paused, crash). Use a
  separate lease-style lock. (`core/messaging/message-dedup.ts`, `domain/scheduling/inbound/process.ts`)
- **Paused (human-control) messages are reprocessed every 3 minutes** for
  days, repeating the audit event and Slack alert each time. Track
  deferred ids so the poll skips them. (`process.ts`, `justin-time.service.ts`)
- **Queued-send fallback drops the tracking code and never stores the
  thread id**, so the therapist's reply to a queued first email is
  unmatched. (`domain/scheduling/agent/send.ts`, `core/email/outbound/queue.ts`)
- **Scanner reports healthy when every Gmail fetch fails** (errors are
  swallowed as `return 0`). Rethrow non-404s and treat >50% failures as a
  skipped scan. (`services/email-ingest.service.ts`, `services/missed-message-scanner.service.ts`)
- **No timeout on the thread-fetching Gmail client or on
  `getAccessToken()`**; one hang stops the backup poller until restart.
  (`services/thread-fetching.service.ts`, `services/email-oauth.service.ts`)
- **Out-of-office / auto-submitted replies still get a full agent turn.**
  Gate them the way `invitation-reply.service.ts` does. (`process.ts`)
- **Long threads keep the oldest messages, not the newest**, and quoted
  text is never stripped. (`services/thread-fetching.service.ts`)
- **The scheduler's own address comes from three places** (`EMAIL.FROM_ADDRESS`,
  the Gmail profile, undocumented `GMAIL_USER`); outbound mail sets no
  `From:` header. Consolidate. (`constants.ts`, `services/email-oauth.service.ts`)
- **Non-UTF-8 parts are decoded as UTF-8** (charset is read from
  `mimeType`, not the part's Content-Type header). (`utils/email-mime-parser.ts`)

### 4.4 Lifecycle & outbox

- **Retry runner replays stale transition emails** (a "confirmed for Tue
  3pm" retried after a reschedule). Store the generation on the row and
  supersede without sending. (`services/side-effect-retry.service.ts`)
- **Admin force-update doesn't reset follow-up sentinels** for date-only
  edits or for `cancelled → anything`, so a revived booking may never get
  its reminder or feedback form. (`domain/scheduling/lifecycle/admin-force.ts`, `status-order.ts`)
- **Only one chase per party is ever sent** — the chase effect has no
  scope generation, so a second chase hits the completed first row and is
  skipped; `chaseSentAt` cycles null/epoch forever and closure is never
  recommended. (`services/chase-email.service.ts`)
- **Feedback dispatch is not retry-safe**: if the transition throws after
  the emails are sent, retry resends both and the row stays in
  `session_held`. (`services/periodic-effect-finalizers.ts`)
- **`markCompleted`/`markFailed` have no ownership check**; re-claimed
  `running` rows never increment attempts; the retry query's
  `ORDER BY last_attempt ASC` starves never-attempted rows (NULLs last).
  (`services/side-effect-tracker.service.ts`)
- **`cleanupOldEffects` is never called**, so `side_effect_logs` grows
  without bound — but the unique `idempotency_key` is the dedup guard, so
  wire it carefully (completed rows only, older than the longest scope).

### 4.5 Data model & deploy

- **Missing indexes**: `(therapist_handle, status)` for the completed-client
  count on every finder request; `lower(user_email)` expression index (or
  citext) for the case-insensitive lookups that currently `ILIKE`;
  `(tracking_code text_pattern_ops)` for code allocation. Drop the
  redundant duplicates of unique columns and single-column prefixes of
  composites.
- **Normalise emails on write** (`users.email @unique` is case-sensitive;
  the active-pair partial unique too).
- **Therapist identity is split** across `therapist_handle` (no FK),
  `therapist_id` (nullable FK), `TherapistBookingStatus.id` (handle, no FK)
  and denormalised name/email per appointment.
- **No right-to-erasure path** (`user.delete` appears nowhere).
- **Image hygiene**: no `.dockerignore` (host `node_modules`, `.vite`,
  `.env*` are copied into the build), devDeps shipped, `dist/__tests__`
  shipped, `HEALTHCHECK` uses `localhost` (may resolve to `::1`).
- **`scripts/e2e-test.ts` defaults to the production API** and creates real
  bookings. Require the URL and refuse prod.
- **docker-compose** publishes Postgres/Redis on host ports with default
  passwords and doesn't wire `DATABASE_URL` to its own Postgres.

### 4.6 Frontend & UX

- Booking confirmation should echo the email address and set expectations
  ("you'll hear from Justin Time by email within…"); show typo suggestions
  the backend already returns; take "up to 2 active requests" from the
  `general.maxActiveThreadsPerUser` setting.
- Confirm dialogs for revoke invitation, force freeze/unfreeze, archive
  therapist and "Resume agent".
- Give admins a human-readable identity (`getAdminId()` is a random
  per-tab id shown in "Taken by" and the audit trail, and causes 409s
  between one person's tabs).
- Persist filters in the URL; search by tracking code; show the timezone
  next to availability on cards.
- The drawer shows a 240-character snippet and raw thread ids; show the
  conversation or a Gmail link. Emit `appointment:activity` from the SSE
  service so an admin in human control sees new messages (`sse.service.ts:147` has no callers).
- Public POSTs silently sleep on 429 for up to 60 s; show "please wait".
- Signup subscribes users to weekly emails without saying so, and the
  success copy sends them to a directory that demands a voucher they only
  get by email. Add a privacy link and an explicit opt-in.
- `react-markdown` is ~36 KB gz of the public entry chunk for an
  admin-written intro; lazy-load it. `dompurify` is unused.
- Accessibility: ~55 labels without `htmlFor`; colour-only health status;
  no focus trap/restore in drawers; `<tr onClick>` rows not keyboard
  reachable; toast live region mounts with its message.
- Dedicated `robots`/`noindex` for `/admin` and `/feedback`; per-route
  titles; consistent support address.

### 4.7 Operations

- **Slack retry queue freezes while the breaker is OPEN** and drops items
  after three flat attempts; no second alert channel. Drain through
  `execute()`, use exponential attempts, RPUSH/LTRIM persistence, email
  fallback for critical alerts. (`services/slack-notification.service.ts`)
- **Settings**: `boolean` settings accept the string `"false"` (stored as a
  truthy JSON string), numbers accept numeric strings, string settings
  accept `""` (every subject/body template, `agent.fromName`,
  `general.timezone` unchecked as IANA). On a DB blip `getSettingValue`
  returns the *default*, so kill switches can flip back on. Cache the last
  known good value. (`routes/admin-settings.routes.ts`, `services/settings.service.ts`)
- **Dead settings** (edits do nothing): `postBooking.meetingLinkCheckDelayHours`,
  `postBooking.meetingLinkCheckMinBeforeHours`, `postBooking.feedbackFormDelayHours`,
  `agent.maxMessages`, `agent.trimToMessages`, `agent.maxRetries`,
  `general.maxBookingRequestsPerTherapist`. Wire or remove.
- **Boot thundering herd**: stale-check, post-booking, weekly-mailing,
  slack-summary and work-report all fire at t=0 of every restart alongside
  WAL recovery and the Pub/Sub backlog. Add jittered `startupDelayMs`.
- **Webhook concurrency is unbounded** — a Pub/Sub burst starts many
  concurrent Claude turns. Put a small p-limit in front. (`routes/email-webhook.routes.ts`)
- **`/health/full` never returns 503** and needs admin auth, so uptime
  monitors can't use it; `unhandledRejectionCount` is monotonic so it stays
  degraded after one rejection. Add a token-protected probe with a window.
- **Stale-lock cleanup at boot matches no real key** and only deletes
  TTL-less keys; delete it or fix the patterns (`*:processing-lock`, `lock:*`).
- **`PeriodicService.stop()` doesn't wait for a running tick**, and
  fire-and-forget webhook processing is never drained on shutdown.

---

## 5. Refactors worth doing

1. **One email-address normaliser.** Two different `normalizeEmail`
   exports plus ~29 inline `toLowerCase().trim()` copies. Pick
   `utils/email-equals` as canonical, normalise on write, and add an
   eslint rule banning inline copies.
2. **One wall-clock ↔ UTC helper** (two implementations) and one
   HTML-escape (three copies). `core/timezone/*` is the canonical home.
3. **Kernel boundary lint rule** (REFACTOR_PLAN "cross-cutting") so
   `domain/` cannot import `services/` — the review found the boundary
   holds today, so lock it in before it erodes.
4. **Split `ats-integration.routes.ts` (1,189 lines, untested)** and
   `post-booking-followup.service.ts` (1,032 lines) along the seams the
   REFACTOR_PLAN used for Phase 2 — these are the largest modules with no
   tests.
5. **Delete dead code**: the unused checkpoint-recovery API, 16 unconsumed
   config fields, three unused `@fastify/*` dependencies, deprecated Gmail
   routes, `cleanupStaleLocks`, and the remaining Notion shims once the
   `notionId` column is renamed for good.
6. **Consolidate therapist availability** (three sources of truth — see
   §6) behind one read path (`Therapist.availability` live, snapshot for
   audit only).

---

## 6. Conflicts to resolve

Places where two parts of the system disagree about the same fact.

| Fact | Side A | Side B | Resolution |
|---|---|---|---|
| Therapist availability | `AppointmentRequest.therapistAvailability` snapshot at creation (prompt renders from it) | `Therapist.availability` written by `update_therapist_availability` and admin PATCH; `memory.availabilityWindows` a third copy | Read `Therapist.availability` live each turn, as `upcomingAvailability` already is |
| Booking lead time | slot display hard-codes 4 h (`formatter.ts` `MIN_BOOKING_LEAD_HOURS`) | validation uses the admin setting | Read the setting in the formatter |
| Voucher expiry | admin issues with a custom expiry | booking validates against the global setting | Validate against the voucher's own expiry |
| Feedback `maxWords` | frontend form editor | admin save strips it (`admin-content.routes.ts`) | Persist it |
| Country codes | 2 of 4 write paths validate | others accept anything; unknown → London | One validator in `shared/constants/countries.ts` used by all four |
| Platform timezone | `config.timezone` | `general.timezone` setting | hard-coded `Europe/London` in several places | One accessor |
| Scheduler address | `EMAIL.FROM_ADDRESS` | Gmail profile | `GMAIL_USER` (undocumented) | One env var, set `From:` on outbound |
| ATS therapist categories | free text accepted | admin enforces the enum | Enforce the shared enum in the ATS route |
| Status badge colours | `confirmed` = `completed`; `contacted` = `feedback_requested` | — | Distinct colours in `frontend/src/config/color-mappings.ts` |
| Chase batch cap | removed in `8d64fc3` | runbook still describes one | Restore a cap or update the runbook |
| Dedup retention | DB rows 7 days | Redis 30 days; scanner unbounded (fixed in #318) | Keep the fixed rule documented in one place |
| `SINGLE_INSTANCE_MODE` default | code: false | compose: true; `.env.example`: "false (default)"; PRODUCTION_DEPLOYMENT: true | Pick one and document it |

---

## 7. Docs drift

- **README**: "Ten background services" (14 run, plus the Slack queue
  interval and SSE heartbeat); lifecycle diagram incomplete; project
  structure omits `core/` and `domain/`; health-endpoint auth described as
  Bearer JWT in PRODUCTION_DEPLOYMENT but is `x-webhook-secret`.
- **`.env.example`**: ~20 env vars the code reads are missing
  (`TRUSTED_PROXY_DEPTH`, `GOOGLE_PUBSUB_*`, `GMAIL_USER`, `TIMEZONE`,
  `FRONTEND_DIST_DIR`, …).
- **RUNBOOK §3.2/§5.2**: light transitions "return `atomicSkipped`" — they
  throw `InvalidTransitionError`. §3.5: completed effects are "cleaned up
  after 30 days" — `cleanupOldEffects` has no caller. §5.1: "a full Redis
  flush is safe" — it was not (fixed in #318). §6.3: idempotency "fails
  closed" — it failed open (fixed). §6.6: retention settings — they were
  ignored (fixed); inquiries were never deleted (fixed).
- **PRODUCTION_DEPLOYMENT**: "force-exits after 30s" — didn't exist (now
  does); Claude breaker "30s / 5" — code is 60s / 3; "Redis loss degrades
  to Postgres" — false for the mailing/summary guards; three Dockerfile
  stages — there are two; migration steps stale.
- **SCHEMA_MIGRATIONS**: "two checks run in CI" — there is no CI;
  `prisma migrate dev` cannot work because the history can't be replayed.
- **MISSED_MESSAGE_RECOVERY**: refers to `email-message-processor` (now
  `domain/scheduling/inbound/process.ts`); Option B bulk retry did nothing
  (fixed); "re-auth via setup-push" only re-registers the watch.
- **CLOCK_SOURCES**: "we don't compare app and DB clocks" is false.
- **AGENT_HARNESS_LIFECYCLE_REVIEW §3a**: `.eslintrc.js` still allowlists
  `core/timezone/prompt-section.ts`; the bare Slack `setInterval` was never
  moved into a service.
- Code comments now false: `constants.ts:257` ("older than 7 days won't
  be reprocessed"), `availability-routing.ts` ("leaving for retry"),
  `delete.ts` header (describes retired counters), `schema.prisma` status
  comment vs the dead enum migration, `SideEffectLog` status list (omits
  `running`).

---

## 8. CI: what to run

There is no `.github` directory. A single workflow on push/PR should run,
in order:

1. `npm ci` (Node 22)
2. `npm -w @therapist-scheduler/shared run build`
3. `npm -w therapist-scheduler-backend run typecheck` — extend the tsconfig
   `include` to `scripts/**` so remediation scripts are checked
4. `npm -w therapist-scheduler-backend run lint`
5. `npm -w therapist-scheduling-frontend run typecheck`
6. `npm -w therapist-scheduling-frontend run lint` (works again after #318)
7. `npm -w therapist-scheduler-backend run test` (add `--detectOpenHandles`
   once the 22 import-time handles — `redis-client.ts:44`,
   `settings-pubsub.ts:82`, `sse.service.ts:197` — are unref'd)
8. `npm -w therapist-scheduling-frontend run test` (currently not in
   root `test:all`)
9. `test:integration` against a Postgres service, seeded by migrations
   (after opportunity #5)
10. `check:schema-migration` plus
    `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code`
11. `prisma validate` and `prisma format --check`
12. `docker compose config` and a `docker build`

Also remove `if-present=true` from `.npmrc` so a missing script fails.

---

## 9. What is done well

- The lifecycle module really is the single writer of `status`: terminal
  transitions use serializable isolation with a row lock and commit audit
  and intent rows in the same transaction; `transitionToConfirmed` puts
  every precondition in the WHERE and captures the post-update generation
  atomically.
- The side-effect outbox has a unique idempotency key, a DB CHECK for
  exactly one scope, an atomic claim with lease recovery, and replays a
  stored payload so settings drift can't change an already-sent email.
- The inbound message lock is an owner-checked Lua script with renewal,
  and retry budgets live in the DB with Slack alerts on first failure and
  on abandonment.
- The booking agent's recipient gate, purpose-scoped HMAC tokens with key
  rotation, hashed invitation tokens, the atomic human-control gate and
  the per-appointment tool ceiling are all sound.
- Parameterised SQL only; no SSRF; no `dangerouslySetInnerHTML`; markdown
  renders only admin content without `rehype-raw`.
- Health probes are split sensibly and time-bounded; the Docker
  healthcheck is DB-free; readiness treats Redis as optional.
- Recent migrations are additive and idempotent with careful cutover
  reasoning; remediation scripts default to dry-run.
- The frontend's London-time picker round-trip is DST-correct and tested;
  admin pages are lazy-loaded; virtualisation is correct; polling pauses in
  background tabs; optimistic take/release control rolls back correctly.
