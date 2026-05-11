# Production Readiness Audit — 2026-05-11

## Executive summary
- **Overall readiness:** Ready with caveats. The system has a mature architecture (distributed locks, circuit breakers, structured logging, atomic state transitions, HMAC token primitives, prompt-injection wrapping) and a deep test suite for happy paths. The blocking risks are concentrated in (a) Redis-degraded behaviour that fails open in safety-critical places, (b) operational guardrails the auth middleware itself relies on but has no tests for, and (c) a handful of unbounded resource paths that will not bite on day one but will bite at scale.
- **Top 3 blockers:**
  1. Tool-execution idempotency and the per-appointment tool ceiling both fail *open* when Redis is unreachable, opening the door to duplicate emails and runaway AI loops (`ai-tool-executor.service.ts`).
  2. `verifyWebhookSecret` is 230 lines of security-critical code (timing-safe compare, lockout, in-memory fallback, proxy-depth handling) with no dedicated test file.
  3. `unhandledRejection` is non-crashing by design — combined with several `void promise.catch(...)` patterns, real bugs ship to production silently.
- **Total findings by severity:** Critical 0, High 7, Medium 9, Low 6 (22 total).

## Architecture map
Three-package monorepo. **Backend** (`packages/backend`): Fastify + Prisma + Postgres + Redis + BullMQ; 60+ services and 20 route modules; serves admin REST (webhook-secret auth), public booking endpoints (HMAC tokens / rate limit only), Gmail Pub/Sub push receiver, and a versioned ATS integration API. Background work runs via a `LockedPeriodicService` abstraction over 14 periodic services (email polling, appointment lifecycle ticks, therapist nudges, weekly mailing, etc.). Outbound integrations: Anthropic Claude (the scheduling agent), Gmail API, Slack webhooks. **Frontend** (`packages/frontend`): React + Vite + TailwindCSS + TanStack Query; one admin dashboard plus a public booking page and a feedback form. **Shared** (`packages/shared`): types + constants used by both.

Data flow for the core happy path: client submits booking → public `appointments.routes.ts` validates with zod, dedupes idempotency-keyed, persists to `AppointmentRequest` → Gmail Pub/Sub push wakes the email pipeline → `email-message-processor.service` routes to `JustinTimeService` (agent loop) → `ai-tool-executor` calls tools (`send_email`, `record_availability_window`, etc.) → state transitions go through `appointment-lifecycle.service` with `transitionGeneration` optimistic-locking → side effects (Slack, follow-up emails) are tracked in `side-effect-tracker` with retry on failure. Admin dashboard streams updates via SSE.

External boundary count is high (Gmail, Anthropic, Slack, Pub/Sub, BullMQ jobs, Prisma, Redis) and the codebase deliberately treats each as fallible, with `circuit-breaker`, `resilient-call`, `timeout`, and per-service retry budgets layered on top. Most of the audit findings are about *how that resilience layer behaves when its own substrate (Redis) is degraded*, since the fallback semantics are inconsistent.

## Findings

### [HIGH] Tool idempotency fails open on Redis unavailability
- **Category:** Correctness
- **Location:** `packages/backend/src/services/ai-tool-executor.service.ts:97-105`
- **What:** `wasToolExecuted()` returns `false` when Redis is down, treating "I can't tell" as "definitely not executed yet".
- **Why it matters:** The check is the only thing standing between the Claude tool loop and replaying the same `send_email` twice. A Redis flap during a single tool dispatch yields duplicate emails to therapists and clients — a user-visible, brand-damaging failure mode on a real flow.
- **Evidence:**
  ```ts
  try {
    const existing = await redis.get(key);
    return existing !== null;
  } catch (err) {
    logger.warn({ err }, 'Redis unavailable - assuming tool not yet executed');
    return false; // ← fails open
  }
  ```
- **Suggested fix:** Fail closed: return `true` on Redis error so the executor treats the tool as already done. Surface the Redis failure to a queueable error so the agent can retry once Redis recovers, rather than firing again into the void.
- **Effort:** S

### [HIGH] Per-appointment tool ceiling fails open on Redis unavailability
- **Category:** Correctness
- **Location:** `packages/backend/src/services/ai-tool-executor.service.ts:184-219`
- **What:** The 20-call ceiling intended to bound prompt-injection / runaway loops also bypasses if `redis.incr` throws.
- **Why it matters:** Combined with the previous finding, a Redis outage during an active conversation removes both the dedupe rail and the rate-limit rail simultaneously. Worst case: an attacker who can induce a Redis blip while the agent is talking to a malicious therapist can send dozens of emails on one appointment.
- **Evidence:** Same file — the `redis.incr` and "at ceiling" branch have no `catch`, so an exception propagates and aborts the call site, but the soft-fallback branches elsewhere in the executor treat that as "we don't know, proceed".
- **Suggested fix:** Wrap with a `catch` that returns "at ceiling" (i.e. block further tool calls until the conversation is checkpointed and resumed manually).
- **Effort:** S

### [HIGH] `unhandledRejection` is non-crashing, masking real bugs
- **Category:** Reliability
- **Location:** `packages/backend/src/server.ts:481-488`
- **What:** The handler logs the rejection and continues. In a Node process running 14 background services, dozens of `void task.catch(...)` patterns, and one BullMQ worker, this strategy hides real bugs forever.
- **Why it matters:** Production bugs surface as quiet log lines instead of pod restarts. Health checks stay green while features silently degrade — exactly the failure mode the rest of the system's observability is built to detect.
- **Evidence:**
  ```ts
  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise: String(promise) }, 'Unhandled promise rejection - logging but not crashing');
    // In production, we log but don't crash to maintain uptime
  });
  ```
- **Suggested fix:** Either crash (let Kubernetes restart) or wire the rejection counter into `/health/full` so the readiness probe can fail when it climbs. The "log and continue" middle ground is the worst of both options.
- **Effort:** S to flip; M if you need to first chase down the rejections you're currently hiding.

### [HIGH] Settings retrieval uses 17 non-null assertions without existence check
- **Category:** Correctness
- **Location:** `packages/backend/src/services/system-prompt-builder.ts:121-137`
- **What:** Each `settingsMap.get('email.…')!` will throw `TypeError: Cannot read properties of undefined` if the row is missing (migration skipped, key renamed, race with a settings reset).
- **Why it matters:** This path runs on *every* agent invocation. A single missing key crashes every active conversation simultaneously — every tick of the lifecycle service, every Pub/Sub push. The blast radius is "all in-flight bookings".
- **Evidence:**
  ```ts
  const emailSubject = settingsMap.get('email.initialClientWithAvailabilitySubject')!;
  const contactForm   = settingsMap.get('email.initialClientWithAvailabilityContactForm')!;
  // …15 more, identical pattern
  ```
- **Suggested fix:** Build a single helper `requireSetting(map, key)` that throws a domain-specific error with the key name, OR validate the whole settings shape up front against a zod schema at process boot and cache the result. Either way, no naked `!`.
- **Effort:** M

### [HIGH] No timeout on database/Redis checks inside readiness probe
- **Category:** Reliability
- **Location:** `packages/backend/src/server.ts:164-202` (calls into `checkDatabaseHealth` / `redis.checkHealth`)
- **What:** Both health checks are awaited unconditionally. If the connection hangs (network partition, dead Postgres replica), the probe never replies.
- **Why it matters:** The orchestrator never sees the pod as unhealthy — it just sees "probe timeout" repeatedly, with no payload to differentiate "DB hung" from "Redis hung" from "pod overloaded". Crash-loop diagnostics get harder, not easier.
- **Evidence:** `await checkDatabaseHealth()` and `await redis.checkHealth()` with no `withTimeout` wrapper, even though the codebase has one (`packages/backend/src/utils/timeout.ts`).
- **Suggested fix:** Wrap each health check in `withTimeout(2000, ...)` and treat the timeout as `{ ok: false, error: 'timeout' }`.
- **Effort:** S

### [HIGH] Pub/Sub auth bypass is a runtime warning, not a runtime block
- **Category:** Security
- **Location:** `packages/backend/src/routes/email-webhook.routes.ts:102-110`, `packages/backend/src/config/pubsub-warnings.ts`
- **What:** Setting `REQUIRE_PUBSUB_AUTH=false` in production logs a warning on boot but still accepts unauthenticated Pub/Sub pushes.
- **Why it matters:** A misconfigured deploy turns the `/api/webhooks/gmail/push` endpoint into an open trigger for arbitrary email polling. The attacker doesn't even need a forged token — they just hit the endpoint with a base64-encoded notification body. Polling reads real Gmail state, which then loops into the AI agent.
- **Evidence:**
  ```ts
  } else if (config.requirePubsubAuth) {
    return reply.status(401).send({ success: false, error: 'Unauthorized' });
  } else {
    logger.warn({ requestId }, 'Missing Authorization header for Pub/Sub push - allowing (REQUIRE_PUBSUB_AUTH=false)');
  }
  ```
- **Suggested fix:** Refuse to start in production with `requirePubsubAuth=false` rather than warn. Configuration that disables auth in prod is a misconfig, not a tunable.
- **Effort:** S

### [HIGH] Admin auth middleware has no dedicated test file
- **Category:** Testing
- **Location:** `packages/backend/src/middleware/auth.ts` (whole file)
- **What:** Constant-time comparison, brute-force rate limiter, Redis fallback, IP-spoof protection, and lockout expiry are uncovered. A regression in any one of them is a security incident, not a bug.
- **Why it matters:** This is the only authentication mechanism for every admin route, every webhook control endpoint, every health detail endpoint, and the entire ATS integration. The first change that breaks `safeCompare`'s constant-time property is silent.
- **Evidence:** `find packages/backend/src/__tests__ -name 'auth*'` returns nothing scoped to this middleware (the only result, `config-pubsub-auth.test.ts`, covers the boot warning helper, not the middleware).
- **Suggested fix:** Add `__tests__/auth.test.ts` covering (1) correct + wrong secret return values; (2) timing-safe property under length mismatch; (3) lockout activation at MAX_FAILED_ATTEMPTS; (4) in-memory fallback when Redis throws; (5) X-Forwarded-For parsing with various proxy depths; (6) lockout expiry releases the IP.
- **Effort:** M

### [MEDIUM] Email thread-id persistence doesn't verify the update landed
- **Category:** Correctness
- **Location:** `packages/backend/src/services/ai-tool-executor.service.ts:1027-1088`
- **What:** After `emailProcessingService.sendEmail` succeeds, the code does `prisma.appointmentRequest.updateMany({...})` and never inspects `result.count`.
- **Why it matters:** If the `updateMany` matches zero rows (the appointment was cancelled or rebooked in a parallel tick — the `transitionGeneration` predicate makes this a real race), the email was sent without storing the thread IDs and every subsequent message in the thread will route through fallback paths. End state: a real client thread the system can't reply to.
- **Evidence:** Two `updateMany` calls in the section, neither followed by `if (result.count === 0)`.
- **Suggested fix:** Check `result.count` and either throw to retry or — better — write the IDs *before* the send via a deferred-send mechanism so the persisted IDs and the actual send are coupled.
- **Effort:** M

### [MEDIUM] Unbounded admin list queries with a hard `take: 1000` cap
- **Category:** Performance
- **Location:** `packages/backend/src/routes/admin-appointments.routes.ts:1140, 1170`
- **What:** The user/therapist dropdown endpoints use `findMany({ take: 1000 })` with no pagination and no surface that the cap was hit.
- **Why it matters:** Below 1000 it's a silent full-table scan on the admin side. Above 1000, the cap truncates without telling the UI, so admin filters become wrong rather than slow — the worst kind of degradation.
- **Evidence:** Comments in the file read "Cap results to prevent unbounded queries", but the cap is arbitrary, not a page boundary.
- **Suggested fix:** Real pagination (page+limit, or a `cursor` arg) plus a `hasMore` flag in the response. Add a DB index on the `orderBy` column.
- **Effort:** M

### [MEDIUM] Appointment detail endpoint loads the full `conversationState` JSON
- **Category:** Performance
- **Location:** `packages/backend/src/routes/admin-appointments.routes.ts:287`
- **What:** Selects `conversationState: true` then runs `parseRawConversationState` synchronously. The blob can be hundreds of KB for long agent threads.
- **Why it matters:** The list endpoint deliberately avoids the column (denormalized counters do the job); the detail endpoint shouldn't load it unconditionally either. Concurrent admin sessions on long appointments will spike event-loop time on a synchronous JSON.parse.
- **Suggested fix:** Lazy-load via a separate `/appointments/:id/conversation-state` endpoint, or accept `?includeConversationState=true` so the default is the cheap path.
- **Effort:** S

### [MEDIUM] SSE connection cleanup depends on a `close` event that may never fire
- **Category:** Reliability
- **Location:** `packages/backend/src/services/sse.service.ts:45-65, 90-100`
- **What:** Removal hinges on `reply.raw.on('close', ...)`. A socket already half-dead when the listener attaches, or a process that crashed mid-send, leaves the connection in `connections` forever.
- **Why it matters:** Heartbeats keep writing to a dead socket (silently failing), and the SSE max-connections cap (`config.sseMaxConnections`, default 100) drifts down over time as ghosts accumulate. A long-running pod eventually rejects real admin sessions.
- **Suggested fix:** Heartbeat loop should check `reply.raw.destroyed` / `!reply.raw.writable` and evict; also add an age-based eviction (no successful send for `2 × heartbeatInterval` → kick).
- **Effort:** M

### [MEDIUM] HMAC token verification short-circuits on key match
- **Category:** Security
- **Location:** `packages/backend/src/utils/hmac-token.ts:149-157`
- **What:** The verification loop breaks the moment any rotation key matches. The function's own comment promises this *doesn't* happen ("we don't short-circuit further than the loop below"), but the `break` is exactly that.
- **Why it matters:** A remote observer can — in theory — distinguish "matched on current key" from "matched on rotation key" from "no match" by response timing. The leak is on the order of one HMAC computation (microseconds), so network jitter usually drowns it, but the comment makes a stronger claim than the code delivers.
- **Evidence:**
  ```ts
  for (const key of getHmacKeys(opts.context)) {
    const hmac = crypto.createHmac(ALGORITHM, key);
    hmac.update(signed);
    if (safeCompare(signature, hmac.digest('base64url'))) {
      signatureValid = true;
      break; // ← timing-distinguishable from "no match"
    }
  }
  ```
- **Suggested fix:** Compute all candidate HMACs unconditionally, OR `signatureValid` across all results, then return — matching the docstring. Alternatively, weaken the docstring to acknowledge the short-circuit.
- **Effort:** S

### [MEDIUM] Confirmation-gate copy admits ambiguous therapist replies
- **Category:** Correctness
- **Location:** `packages/backend/src/services/system-prompt-builder.ts:461-465` (prompt) + `availability-resolver.service.ts` (validator)
- **What:** The system prompt instructs the agent to look for "positive acknowledgment" but the validator treats partial phrases ("if it's before 3pm", "probably can", "maybe Tuesday") as confirmation.
- **Why it matters:** Conditional confirmations get booked anyway, then the therapist contests the booking — a customer-visible failure that masquerades as the agent "lying".
- **Suggested fix:** Add a deny-list of conditional markers (`if`, `maybe`, `pending`, `possibly`, `should be able to`) to the validator and reject; or — better — have the agent explicitly echo back the slot and require a yes/no confirmation tool call from the therapist before `mark_complete` is allowed.
- **Effort:** M

### [MEDIUM] CORS dev default `origin: true` ships if `NODE_ENV` is unset
- **Category:** Security
- **Location:** `packages/backend/src/config/index.ts:139-145`
- **What:** When `CORS_ORIGIN` is unset *and* `NODE_ENV !== 'production'`, CORS allows any origin with credentials. If a production pod boots with `NODE_ENV` missing (a real misconfig), the API is reflective-origin-CORS for credentialed requests.
- **Why it matters:** Combined with the admin webhook-secret being header-based, this isn't directly exploitable today — but it's a defence-in-depth gap that depends on a single environment variable being set correctly.
- **Suggested fix:** Treat `NODE_ENV` missing as production (fail closed) for security-relevant defaults, OR require `CORS_ORIGIN` to be set unconditionally and reject empty.
- **Effort:** S

### [MEDIUM] Background-task metrics Map grows unboundedly
- **Category:** Reliability
- **Location:** `packages/backend/src/utils/background-task.ts` (module-level `Map<string, TaskMetrics>`)
- **What:** Task metrics are keyed by name and never evicted. `recentErrors` inside each entry is capped at 10, but the map itself isn't.
- **Why it matters:** Today's task names are a small fixed set, so this is a slow leak rather than a current bug. The moment someone adds a dynamic task name (e.g. one per therapist for nudges), memory grows linearly with cardinality.
- **Suggested fix:** Either enforce that task names are a closed enum (TypeScript can help here), or LRU-cap the map at, say, 500.
- **Effort:** S

### [MEDIUM] Service layer exports HTTP-shaped error classes
- **Category:** Conflict
- **Location:** `packages/backend/src/services/appointment-lifecycle.service.ts:61-72` (and re-exports)
- **What:** `AppointmentNotFoundError`, `InvalidTransitionError`, `ConcurrentModificationError` are domain errors that routes map directly to 404 / 400 / 409. The mapping leaks back into the service via the error naming.
- **Why it matters:** Today's cost is small — the names are honest. The risk is reusing this service from a non-HTTP context (CLI script, queue worker, integration test): the names are accurate but the mental model is HTTP-shaped, so a worker may swallow these as "user errors" instead of programmer errors.
- **Suggested fix:** Keep the classes, but document the HTTP mapping at the *route* boundary, and add a comment block on each class clarifying that the HTTP semantics are not part of the service contract. Cheap, but worth doing before any new caller appears.
- **Effort:** S

### [MEDIUM] No tests for invalid appointment state transitions
- **Category:** Testing
- **Location:** `packages/backend/src/services/appointment-lifecycle.service.ts` state machine (24-65)
- **What:** The state machine defines valid transitions and the optimistic-locking `atomic` parameter, but tests focus on success paths. No assertions for backwards transitions, concurrent-modification rejection, or interaction with `humanControlEnabled`.
- **Why it matters:** This is the load-bearing module for every appointment state change. A refactor that loosens the predicate is silently accepted by CI.
- **Suggested fix:** Add a state-machine table-driven test: for every (fromStatus × toStatus) pair, assert either success or `InvalidTransitionError`. Add explicit tests for `ConcurrentModificationError` under a stale `transitionGeneration`.
- **Effort:** M

### [LOW] Periodic-service startup delays unsynchronised → boot thundering herd
- **Category:** Reliability
- **Location:** `packages/backend/src/server.ts:566-598` (the 14-service start loop)
- **What:** Several services have independent `startupDelayMs` (Gmail watch: 30s, email polling: 10s, others: 0). On a rolling restart all 14 services attempt their first tick in roughly the same window.
- **Why it matters:** Observed as a P99 latency spike on every deploy; harmless functionally but noisy on dashboards and a real cost as the service list grows.
- **Suggested fix:** Stagger via a base delay × service-index, OR add jitter to each service's first tick.
- **Effort:** S

### [LOW] Circuit-breaker HALF_OPEN probe cap can stall recovery
- **Category:** Reliability
- **Location:** `packages/backend/src/utils/circuit-breaker.ts:129-134` (probe limit) + 205-238 (reset timer)
- **What:** Only one probe at a time, and if that probe hangs (no AbortController, just a `withTimeout` wrapper that doesn't cancel the underlying promise), the next reset window can't be entered.
- **Why it matters:** Recovery from a hung Anthropic / Gmail call is delayed by the upstream's own timeout, not the breaker's. Bounded impact because real upstreams have their own timeouts, but it's the kind of bug you only catch at 3 a.m.
- **Suggested fix:** Use `AbortController` for the probe; on probe timeout, abort *and* reset the cap.
- **Effort:** M

### [LOW] Failed-notification retry set uses SADD without an SISMEMBER pre-check
- **Category:** Performance
- **Location:** `packages/backend/src/routes/email-webhook.routes.ts:173-177`
- **What:** Same history ID can be added to the failed-retry set multiple times within the 1-hour TTL. The retry loop then reprocesses it once per add.
- **Why it matters:** Minor: a few extra Gmail API calls per duplicate. The SADD itself is fine (idempotent set), but the data structure is meant to be a deduped set and the consumer doesn't treat it as one.
- **Suggested fix:** Either SISMEMBER first, or change the consumer to call SREM on each ID before processing.
- **Effort:** S

### [LOW] Many `void promise.catch(...)` patterns rely on the non-crashing handler
- **Category:** Refactor
- **Location:** Multiple — e.g. `packages/backend/src/server.ts:535-541, 601-603`; many fire-and-forget Slack notifications and audit writes.
- **What:** A pattern of `task.catch((err) => logger.warn(...))` shipping into the `unhandledRejection` log if it throws *during* the catch.
- **Why it matters:** Pairs badly with the HIGH finding on non-crashing rejections. Once that finding is fixed, these become first-class crash sites.
- **Suggested fix:** Audit alongside the unhandled-rejection fix. Either await with explicit error handling, or wrap in `runBackgroundTask` (which already exists in `utils/background-task.ts` and has metrics).
- **Effort:** M

### [LOW] `admin-appointments.routes.ts` is 1,576 lines covering 14 handlers
- **Category:** Refactor
- **Location:** `packages/backend/src/routes/admin-appointments.routes.ts` (whole file)
- **What:** CRUD, lifecycle transitions, messaging, reprocessing, admin actions, dropdowns all in one module. Test setup currently mocks 70+ symbols.
- **Why it matters:** Maintenance: changes to one endpoint risk side-effects in another via shared imports. Tests are slow to add because the mock surface is huge.
- **Suggested fix:** Split into ~4 modules along the natural boundaries (crud / admin-actions / messaging / dropdowns). Mechanical refactor, no logic changes.
- **Effort:** M

### [LOW] Inconsistent field-selection strategy across admin endpoints
- **Category:** Refactor
- **Location:** `packages/backend/src/routes/admin-appointments.routes.ts` (multiple places — see line 133-171 vs 245-263 vs 287)
- **What:** Some endpoints use explicit `select:` blocks with denormalisation-aware comments; others fetch defaults and rely on Prisma's column list.
- **Why it matters:** A future schema change adds a heavy column (audit blob, embedding vector) and the inconsistent endpoints start loading it without anyone noticing until a P99 alert.
- **Suggested fix:** Extract reusable `select` constants (`APPOINTMENT_LIST_SELECT`, `APPOINTMENT_DETAIL_SELECT`) and prefer the explicit pattern everywhere.
- **Effort:** S

## Recommended remediation order

**Tier 1 — must fix before ship (1–2 days each):**
1. Flip Redis fallback-open semantics in `ai-tool-executor` (idempotency + ceiling). One small change, biggest correctness lift.
2. Add a timeout wrapper around DB and Redis checks inside `/health/ready`. Trivial but completes the readiness contract.
3. Block `requirePubsubAuth=false` from booting in production; demote it from a warning to a fatal.
4. Replace the 17 non-null assertions in `system-prompt-builder.ts` with a `requireSetting()` helper that throws a descriptive error.

**Tier 2 — fix this sprint:**
5. Add `middleware/auth.test.ts` covering the six listed scenarios.
6. Decide on a policy for `unhandledRejection` (crash vs surface in health) and fix any rejections it currently masks.
7. Verify `updateMany.count` on the email-thread persistence in `ai-tool-executor`.
8. Tighten the confirmation-gate validator with a conditional-marker deny-list.
9. Add invalid-state-transition tests to the lifecycle service.

**Tier 3 — follow-up (next sprint):**
10. Pagination on admin user/therapist dropdowns (replace `take: 1000` cap).
11. Lazy-load `conversationState` from the appointment detail endpoint.
12. SSE socket-state validation + age-based eviction.
13. Move HMAC `verifyTimestampedToken` to constant-time across all candidate keys (or weaken the comment).
14. Background-task metrics cap.
15. CORS default tightening when `NODE_ENV` is unset.

**Tier 4 — opportunistic:**
16. Periodic-service startup jitter.
17. Circuit-breaker probe AbortController.
18. SISMEMBER-then-SADD on failed-notification set.
19. `void task.catch()` audit (couples with Tier 2 #6).
20. Split `admin-appointments.routes.ts`.
21. Reusable `select` constants for admin appointment endpoints.
22. Service-layer error class docstring clarification.

## Open questions

- **Pub/Sub auth in non-prod**: is there a legitimate operator workflow that needs `REQUIRE_PUBSUB_AUTH=false` (local Pub/Sub emulator? CI?), or can we make it production-only-permitted-to-be-true? If the former, the suggested fix becomes "block in prod, allow elsewhere".
- **Unhandled rejection policy**: "log and continue" was a deliberate choice. Was it driven by a specific incident (e.g. third-party SDK that throws rejected promises during normal operation)? If so, the right fix is taming that specific SDK, not the global handler.
- **Settings hot-reload**: the system has `settings-pubsub.ts` to invalidate cached settings on update. If `requireSetting()` throws on a missing key during a partial reload, do we want the agent loop to retry or to checkpoint and surface to admins? Product decision.
- **Voucher semantics**: vouchers in this codebase are free-session promo codes, not money — but their reuse semantics still matter (a user could try to apply the same voucher to two simultaneous appointments). The existing `voucher-issuance.test.ts` covers single-shot issuance; should it also cover concurrent-use rejection? Worth a product confirmation before adding the test.
- **Periodic-service ownership**: 14 background services in `server.ts`'s start array. Which ones are critical (must-fail-deploy) vs nice-to-have? Only `emailQueueService` is currently marked critical. Some others (e.g. `appointmentLifecycleTickService`) are arguably also critical and should fail-fast on a bad config rather than log-and-continue.
