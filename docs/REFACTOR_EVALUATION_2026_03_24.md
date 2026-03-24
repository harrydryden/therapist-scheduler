# Refactor & Refinement Evaluation

**Date:** 2026-03-24
**Scope:** Full codebase — backend services, utils, frontend, shared package, architecture

---

## Executive Summary

The codebase is mature and well-architected with strong patterns (circuit breakers, audit trails, idempotency, optimistic locking). Previous reviews addressed critical bugs and race conditions. This evaluation focuses on **structural refactoring** and **refinement opportunities** that would improve maintainability, reduce cognitive load, and make the system easier to extend.

**High Priority:** 5 items (structural decomposition, DRY violations)
**Medium Priority:** 6 items (consistency, configuration, error handling)
**Low Priority:** 4 items (cleanup, minor improvements)

---

## HIGH PRIORITY

### 1. Duplicate Zod Validation Schemas Between Services

**Files:**
- `packages/backend/src/services/justin-time.service.ts` (lines 43-69)
- `packages/backend/src/services/ai-tool-executor.service.ts` (lines 40-66)

**Problem:** Five identical Zod schemas are defined in both files:
- `sendEmailInputSchema`
- `updateAvailabilityInputSchema`
- `markCompleteInputSchema`
- `cancelAppointmentInputSchema`
- `recommendCancelMatchInputSchema`

Additionally, `initiateRescheduleInputSchema` exists only in `justin-time.service.ts` and `issueVoucherCodeInputSchema` only in `ai-tool-executor.service.ts`, suggesting an incomplete extraction.

**Recommendation:** Create `packages/backend/src/schemas/tool-inputs.ts` exporting all tool input schemas from a single location. Both services import from there.

**Effort:** Small (< 1 hour)

---

### 2. God Service: `justin-time.service.ts` (1,921 lines)

**File:** `packages/backend/src/services/justin-time.service.ts`

**Problem:** Despite prior extractions (`system-prompt-builder.ts`, `agent-tool-loop.ts`, `ai-conversation.service.ts`, `ai-tool-executor.service.ts`), this file remains the largest in the codebase. It still owns:
- Conversation orchestration and state management
- Response processing and message routing
- Scheduling context building
- Tool execution result handling and checkpoint updates
- Admin message handling

**Recommendation:** Continue the decomposition that was already started:
1. Extract **scheduling context building** into a dedicated `scheduling-context.service.ts`
2. Extract **response processing** (handling tool results, updating checkpoints) into the existing `ai-conversation.service.ts`
3. Keep `justin-time.service.ts` as a thin orchestrator that delegates to focused modules

**Effort:** Medium (half day)

---

### 3. God Service: `email-message-processor.service.ts` (1,840 lines)

**File:** `packages/backend/src/services/email-message-processor.service.ts`

**Problem:** This file handles message locking (Lua scripts), MIME parsing, thread matching, deduplication, Gmail API interaction, and message routing — all in one place. It also contains a circular dependency workaround (`require()` for lazy import of justin-time.service).

**Recommendation:**
1. Extract **Lua scripts and atomic Redis operations** into `packages/backend/src/utils/redis-scripts.ts`
2. Extract **thread matching logic** (tracking code extraction, subject matching, sender matching) into a `thread-matcher.ts` utility
3. The existing `thread-fetching.service.ts` (514 lines) already handles some thread concerns — evaluate merging thread-related logic there

**Effort:** Medium (half day)

---

### 4. God Service: `appointment-lifecycle.service.ts` (1,656 lines)

**File:** `packages/backend/src/services/appointment-lifecycle.service.ts`

**Problem:** This is the single source of truth for status transitions — a good architectural choice. However, it also orchestrates all side effects: email notifications, Slack notifications, audit logging, Notion syncing, therapist status updates, and SSE broadcasting.

**Recommendation:** The notification dispatch was partially extracted to `appointment-notifications.service.ts` (574 lines). Continue by:
1. Adopting an **event-driven pattern**: have transitions emit events, with listeners handling side effects
2. Or more pragmatically: extract remaining side effects (Notion sync, therapist status updates, SSE broadcast) into a `transition-side-effects.service.ts`

**Effort:** Medium-Large (1 day)

---

### 5. Route File Bloat: `admin-appointments.routes.ts` (1,564 lines)

**File:** `packages/backend/src/routes/admin-appointments.routes.ts`

**Problem:** This single route file contains 15+ endpoint handlers with inline query building, response formatting, and business logic. Two Zod schemas at the top (`listAllAppointmentsSchema` and `listAppointmentsSchema`) have overlapping fields, suggesting the list endpoint evolved without consolidation.

**Recommendation:**
1. Split into focused route modules: `admin-appointment-list.routes.ts`, `admin-appointment-lifecycle.routes.ts`, `admin-appointment-detail.routes.ts`
2. Extract shared query building (where clause construction, pagination) into a `query-builder.ts` utility
3. Consolidate the two overlapping list schemas into one

**Effort:** Medium (half day)

---

## MEDIUM PRIORITY

### 6. Circular Dependency Chain

**Files:**
- `email-message-processor.service.ts` → uses `require()` lazy import for justin-time
- `ai-tool-executor.service.ts` → uses `await import()` for ai-conversation
- `email-queue.service.ts` → uses `await import()` for email-processing

**Problem:** Three separate circular dependency workarounds exist, each using a different pattern (CommonJS `require()`, dynamic `await import()`, type-only imports). This indicates an architectural coupling issue in the service layer.

**Recommendation:** Introduce a **mediator/event bus** pattern:
- `appointment-events.ts` — typed event emitter
- Services publish events instead of calling each other directly
- This eliminates the circular chain: `justin-time → appointment-lifecycle → email-processing → justin-time`

**Effort:** Medium-Large (1 day, but high payoff for future maintainability)

---

### 7. Hardcoded Constants Scattered Across Files

**Locations:**
- `packages/backend/src/utils/redis.ts:18-29` — `BACKPRESSURE_CONFIG` thresholds
- `packages/backend/src/services/post-booking-followup.service.ts:35-42` — `BATCH_SIZE`, `MAX_PARSE_ATTEMPTS`, timing constants
- `packages/backend/src/services/email-message-processor.service.ts:41-48` — `PROCESSED_MESSAGE_TTL_DAYS`, `MAX_UNMATCHED_ATTEMPTS`
- `packages/backend/src/services/stale-check.service.ts:14-17` — `CHECK_INTERVAL_MS`, `RETENTION_CHECK_INTERVAL_MS`
- `packages/backend/src/services/slack-notification.service.ts:33-48` — dedup TTLs, circuit breaker config

**Problem:** The codebase has a well-structured `constants.ts` file, but many services define their own local constants at the top of the file. While some locality is fine, timing/threshold values that an operator might want to tune should be centralized.

**Recommendation:** Move operational constants (intervals, thresholds, TTLs, batch sizes) into `constants.ts` under descriptive namespaces. Keep truly private implementation details local.

**Effort:** Small (2-3 hours)

---

### 8. Inconsistent Error Class Hierarchy

**Problem:** The codebase has multiple error class patterns:
- **Backend custom errors:** `AppointmentNotFoundError`, `InvalidTransitionError`, `ConcurrentModificationError` (in `appointment-lifecycle.service.ts`)
- **Frontend errors:** `ApiError`, `AuthError` (in `api/core.ts`)
- **Generic errors:** Many services throw plain `Error` objects

There's no base application error class, no error code enum, and no consistent serialization.

**Recommendation:** Create `packages/backend/src/errors/` with:
- `AppError` base class with `code`, `statusCode`, `isOperational` fields
- Domain-specific subclasses inheriting from it
- A Fastify error handler that serializes `AppError` instances consistently

**Effort:** Medium (half day)

---

### 9. `redis.ts` Utility File (923 lines)

**File:** `packages/backend/src/utils/redis.ts`

**Problem:** This file contains the Redis client, CacheManager class, health tracking, backpressure logic, and queue utilities — all in one file. It's the largest utility file.

**Recommendation:** Split into:
- `redis-client.ts` — connection setup and health tracking
- `cache-manager.ts` — CacheManager class with stampede protection
- Move backpressure config to constants

**Effort:** Small (1-2 hours)

---

### 10. `settings.service.ts` (1,149 lines) — Configuration as Data

**File:** `packages/backend/src/services/settings.service.ts`

**Problem:** This file defines every setting's metadata (label, description, type, min/max, default) inline as a giant `SETTING_DEFINITIONS` object, then implements 3-tier caching (memory → Redis → Postgres). The definitions alone are ~600 lines.

**Recommendation:** Extract `SETTING_DEFINITIONS` into a separate `packages/backend/src/config/setting-definitions.ts` file. Keep the caching and retrieval logic in the service.

**Effort:** Small (1 hour)

---

### 11. Frontend `TherapistCard.tsx` (480 lines) — Component Decomposition

**File:** `packages/frontend/src/components/TherapistCard.tsx`

**Problem:** A single component file containing:
- `CategoryBadge` sub-component
- `GeneralBadge` sub-component
- `CategorySection` sub-component
- `TherapistCard` main component
- Day ordering/abbreviation constants
- Complex availability formatting logic

**Recommendation:**
1. Extract badge components into `components/badges/`
2. Move day constants and availability formatting into `utils/availability.ts`
3. Keep `TherapistCard` focused on layout and composition

**Effort:** Small (1-2 hours)

---

## LOW PRIORITY

### 12. Wildcard Imports

**Files:**
- `packages/backend/src/services/email-oauth.service.ts` — `import * as fs`, `import * as path`
- `packages/backend/src/utils/date-parser.ts` — `import * as chrono`
- `packages/backend/src/utils/gmail-auth.ts` — `import * as fs`, `import * as path`

**Recommendation:** Replace with named imports (`import { readFile } from 'fs/promises'`, etc.) for tree-shaking and clarity.

**Effort:** Trivial

---

### 13. `email-classifier.ts` (717 lines) — Heavy Regex Configuration

**File:** `packages/backend/src/utils/email-classifier.ts`

**Problem:** Large regex pattern arrays for intent and sentiment classification. These work but are difficult to maintain and test individually.

**Recommendation:** Consider moving patterns to a JSON/YAML config file, or at minimum add a test suite that validates each pattern against example inputs. No code change needed if current patterns are stable.

**Effort:** Small (if adding tests)

---

### 14. Debug Logging in Production Code

**Files:**
- `packages/backend/src/services/justin-time.service.ts` — 105+ `logger.debug()` calls
- `packages/backend/src/services/ai-tool-executor.service.ts` — line 528 comment: `"// DEBUG: Log the raw and normalized body"`

**Recommendation:** Audit debug log statements for:
- Remove any that were only useful during initial development
- Ensure structured logging (object first arg) is used consistently
- Remove `// DEBUG:` comments that indicate temporary logging

**Effort:** Small (1-2 hours)

---

### 15. Test Coverage Gaps

**Current state:** 10+ test files covering utils and edge cases (email encoding, validation, templates, tokens, queue reliability).

**Gaps identified:**
- No tests for `appointment-lifecycle.service.ts` (the most critical service)
- No tests for `justin-time.service.ts` (the AI orchestrator)
- No integration tests for the status transition state machine
- No tests for `post-booking-followup.service.ts`

**Recommendation:** Prioritize integration tests for the appointment lifecycle state machine and the AI conversation flow. These are the highest-risk code paths.

**Effort:** Large (ongoing)

---

## Architecture Observations (No Action Needed)

These are patterns that are working well and should be preserved:

1. **PeriodicService base class** (`utils/periodic-service.ts`) — Clean abstraction for recurring background tasks
2. **LockedTaskRunner** (`utils/locked-task-runner.ts`) — Distributed lock pattern for multi-instance safety
3. **Circuit breaker registry** (`utils/circuit-breaker.ts`) — Proper resilience for external APIs
4. **Side effect tracking** (`services/side-effect-tracker.service.ts`) — Two-phase commit pattern
5. **Conversation checkpoint/facts** — Clean state management for AI conversations
6. **3-tier settings cache** — Well-designed caching strategy with proper invalidation
7. **Atomic status transitions** via Prisma `updateMany` with status preconditions

---

## Recommended Execution Order

| Phase | Items | Impact | Risk |
|-------|-------|--------|------|
| 1 | #1 (schemas), #7 (constants), #10 (settings), #12 (imports) | Quick wins, reduce duplication | Very Low |
| 2 | #5 (route split), #9 (redis split), #11 (TherapistCard) | Reduce file sizes | Low |
| 3 | #2, #3, #4 (service decomposition) | Major maintainability improvement | Medium |
| 4 | #6 (event bus), #8 (error hierarchy) | Architectural improvement | Medium |
| 5 | #15 (tests) | Safety net for all other refactors | None |
