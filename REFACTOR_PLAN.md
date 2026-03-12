# Therapist Scheduler — Refactor & Integration Readiness Evaluation

> Prepared 2026-03-12 — Final development stage assessment
> Codebase: 178 source files, ~58,500 lines across 3 packages (backend, frontend, shared)

---

## Executive Summary

The therapist-scheduler is a well-featured application with strong foundations (Fastify, Prisma, React Query, typed shared package, circuit breakers, audit trails). However, organic growth has created **significant bloat in the service and utility layers**, **fragmented API routes**, and **a frontend that is tightly coupled to its own infrastructure**. Before this becomes a module of the larger ATS application, the following consolidation work is necessary.

**Key metrics:**
- 4 backend services exceed 1,300 lines (largest: 2,751)
- 6 email-related services with overlapping responsibilities
- 21 route files (12 admin-prefixed) with inconsistent response patterns
- 943-line monolithic frontend API client
- ~2,800 lines of service-complexity code misplaced in `utils/`
- ~200 lines of deprecated functions still present
- Type definitions duplicated between `shared` and `backend`

---

## 1. SERVICE LAYER — Critical Consolidation Needed

### 1.1 God-Object Services

| Service | Lines | Problem |
|---------|-------|---------|
| `email-processing.service.ts` | 2,751 | OAuth management, Gmail API, push notifications, email polling fallback, message locking, MIME parsing, bounce delegation, thread divergence, weekly mailing routing, cleanup Lua scripts — all in one file |
| `justin-time.service.ts` | 2,362 | AI conversation management, email reply orchestration, availability checking, slot formatting, confirmation parsing, tool execution, side effects, conversation trimming, error recovery, escalation logic |
| `stale-check.service.ts` | 1,345 | Therapist booking monitoring, chase email decisions, data retention cleanup, stale detection, auto-unfreeze, email sending, inactivity thresholds, admin flagging |
| `appointment-lifecycle.service.ts` | 1,963 | 7-state machine, 4-5 email notification types, Slack orchestration, therapist booking updates, Notion sync triggers, audit trail, conversation state updates |

**Recommended decomposition:**

**email-processing.service.ts → 3 files:**
- `email-ingest.service.ts` — Receive, parse, route incoming email (Gmail push + polling)
- `email-oauth.service.ts` — Token management, Gmail client initialization
- `email-message-processor.service.ts` — Lock acquisition, deduplication, thread routing

**justin-time.service.ts → 3 files:**
- `ai-conversation.service.ts` — Claude API interaction, conversation state, history trimming
- `ai-tool-executor.service.ts` — Tool execution (booking_session, request_availability), side effects
- `availability-resolver.service.ts` — Slot extraction, confirmation parsing, availability formatting

**stale-check.service.ts → 2 files:**
- `stale-detection.service.ts` — Detection logic, inactivity thresholds, admin flagging
- `chase-email.service.ts` — Chase decision logic, auto-unfreeze, chase email sending

**appointment-lifecycle.service.ts — keep as single file but extract:**
- Move email template selection to a dedicated `appointment-notifications.service.ts`
- Keep state machine + audit trail as core lifecycle

### 1.2 Email Service Fragmentation (6 services → 4)

| Current Service | Lines | Action |
|----------------|-------|--------|
| `email-processing.service.ts` | 2,751 | Split as above into ingest/oauth/processor |
| `email-queue.service.ts` | 478 | Keep — BullMQ send queue is well-scoped |
| `email-polling.service.ts` | 181 | Merge into `email-ingest.service.ts` as fallback strategy |
| `pending-email.service.ts` | 208 | **Remove** — dual send mechanism (DB queue) is redundant with BullMQ |
| `email-bounce.service.ts` | 340 | Keep — standalone concern, well-scoped |
| `gmail-watch.service.ts` | 191 | Merge into `email-oauth.service.ts` — both manage Gmail API lifecycle |

**Result:** 6 services → 4 services (ingest, queue, bounce, oauth), eliminating dual-queue and merging related lifecycle concerns.

### 1.3 Notification Fragmentation (3 services → 2)

| Current Service | Lines | Action |
|----------------|-------|--------|
| `slack-notification.service.ts` | 927 | Keep — rename to `notification-dispatcher.service.ts`, add unified entry point |
| `admin-notification.service.ts` | 433 | Keep — dashboard aggregation is a distinct concern |
| `slack-weekly-summary.service.ts` | 181 | Merge into notification-dispatcher — it's just a scheduled Slack message |

### 1.4 Circular Dependency Chain

```
email-processing ←→ justin-time ←→ appointment-lifecycle ←→ email-processing
```

Currently resolved with lazy imports. After the decomposition above, the cycle breaks naturally:
- `email-ingest` → `ai-conversation` → `appointment-lifecycle` → `email-queue` (no cycle)

### 1.5 Scattered Responsibilities

| Concern | Currently in N services | Consolidation target |
|---------|------------------------|---------------------|
| Email template selection | 4 (lifecycle, followup, stale-check, justin-time) | Single `email-template-resolver.ts` utility |
| Therapist freeze/unfreeze | 4 (booking-status, lifecycle, stale-check, bounce) | All trigger through `therapist-booking-status.service.ts` (already exists, just enforce as single entry point) |
| Conversation health assessment | 4 (stale-check, admin-notification, weekly-summary, lifecycle) | Single source of truth in `conversation-health.service.ts` |

---

## 2. UTILS LAYER — Misplaced Services & Duplication

### 2.1 Utils That Are Services (move to `services/`)

| Current util | Lines | Why it's a service |
|-------------|-------|-------------------|
| `redis.ts` | 923 | Full Redis connection lifecycle, health state machine, backpressure management, stale-while-revalidate caching |
| `email-classifier.ts` | 635 | AI/NLP classification with 9+ intent types, sentiment analysis, business logic |
| `thread-divergence.ts` | 616 | 7 divergence detection algorithms, database writes, Slack notifications |
| `conversation-checkpoint.ts` | 470 | 10+ stage state machine, transition validation, metrics calculation |
| `tracking-code.ts` | 407 | Database queries/updates, backfill operations, serializable transactions |
| `availability-formatter.ts` | 395 | Concrete slot generation, date arithmetic, timezone handling |

**Total: ~3,446 lines of service logic in the wrong directory.**

**Action:** Move to `services/` with appropriate naming. Split `redis.ts` into:
- `services/cache.service.ts` — High-level caching (get/set/stale-while-revalidate)
- `utils/redis-client.ts` — Connection management, low-level primitives

### 2.2 Overlapping Date Utilities (3 files → 1)

| File | Purpose | Overlap |
|------|---------|---------|
| `date-parser.ts` | Natural language → Date | Timezone logic |
| `date-formatting.ts` | Format constants, `formatTime12` | Duplicate `formatTime12`/`formatTime12Compact` (identical implementations) |
| `email-date-formatter.ts` | Dates for emails | Duplicates timezone logic from `date-parser.ts` |

**Action:** Consolidate into single `utils/date.ts` with sections for parsing, formatting, and email-specific formatting. Also absorb date arithmetic from `availability-formatter.ts`.

### 2.3 Overlapping Sanitizers (2 files → 1)

| File | Issue |
|------|-------|
| `content-sanitizer.ts` | Prompt injection detection, Unicode normalization |
| `input-sanitizer.ts` | 5 DEPRECATED functions, imports `INJECTION_PATTERNS` from content-sanitizer |

**Action:** Remove all deprecated functions from `input-sanitizer.ts` (~200 lines). Merge remaining non-deprecated functions into `content-sanitizer.ts`. Remove `escapeHtml()` duplicate (also defined privately in `email-templates.ts`).

### 2.4 Resilience Utilities (5 files — well-structured, minor cleanup)

| File | Status |
|------|--------|
| `circuit-breaker.ts` | Keep |
| `resilient-call.ts` | Keep — properly wraps circuit-breaker |
| `timeout.ts` | Keep |
| `redis-locks.ts` | Keep — low-level lock primitives |
| `locked-task-runner.ts` | Keep — high-level abstraction over redis-locks |

These are well-layered. Only action: ensure all services use `LockedTaskRunner` instead of manual lock management (email-processing still uses raw `renewLock()`/`releaseLock()`).

---

## 3. ROUTE LAYER — Fragmented Admin API

### 3.1 Current State: 21 Route Files

**Admin routes (12 files):**
```
admin.routes.ts              (aggregator)
admin-appointments.routes.ts  (1,554 lines)
admin-appointment-create.routes.ts
admin-dashboard.routes.ts
admin-data.routes.ts
admin-forms.routes.ts
admin-knowledge.routes.ts
admin-queue-review.routes.ts
admin-settings.routes.ts     (771 lines)
admin-stats.routes.ts
admin-sse.routes.ts
admin-therapists.routes.ts
```

**Other routes (9 files):**
```
appointments.routes.ts       (public booking)
therapists.routes.ts         (public therapist listing)
ats-integration.routes.ts    (1,137 lines — versioned ATS API)
feedback-form.routes.ts
email.routes.ts
email-webhook.routes.ts
webhooks.routes.ts
ingestion.routes.ts
unsubscribe.routes.ts
```

### 3.2 Consolidation Plan

**Merge small admin routes into logical groups:**

| New File | Merges | Rationale |
|----------|--------|-----------|
| `admin-appointments.routes.ts` | + `admin-appointment-create.routes.ts` + `admin-queue-review.routes.ts` | All appointment CRUD and review |
| `admin-content.routes.ts` | `admin-knowledge.routes.ts` + `admin-forms.routes.ts` | Both are content management |
| `admin-monitoring.routes.ts` | `admin-stats.routes.ts` + `admin-sse.routes.ts` + `admin-dashboard.routes.ts` | All dashboard/monitoring endpoints |
| `admin-config.routes.ts` | `admin-settings.routes.ts` + `admin-therapists.routes.ts` + `admin-data.routes.ts` | All configuration/data management |

**Result:** 12 admin route files → 4 admin route files + aggregator

**Merge webhook routes:**

| New File | Merges | Rationale |
|----------|--------|-----------|
| `webhooks.routes.ts` | + `email-webhook.routes.ts` + `email.routes.ts` | All inbound webhook processing |

**Result:** 21 total route files → 12 route files

### 3.3 Response Format Inconsistencies

`admin-data.routes.ts` and `admin-knowledge.routes.ts` use `reply.status().send()` directly instead of the shared `sendSuccess()`/`sendError()` helper from `utils/response.ts`. Standardize all routes to use the helper.

### 3.4 ATS Integration Route — Already Well-Structured

`ats-integration.routes.ts` (1,137 lines) is versioned (`/api/v1/ats/*`), has cursor-based pagination, idempotency support, and proper auth. This is the model for how the scheduler should expose its API when consumed as a module. **No changes needed.**

---

## 4. TYPE & CONSTANT DUPLICATION

### 4.1 Duplicated Type Definitions

| Type | Shared Package | Backend Duplicate | Action |
|------|---------------|-------------------|--------|
| `HealthStatus` | `shared/types/index.ts:115` | `conversation-health.service.ts:22` | Remove backend duplicate, import from shared |
| `ConversationStage` | `shared/types/index.ts:102-113` | `conversation-checkpoint.ts:15-26` | Remove backend duplicate, import from shared |
| `KnowledgeEntry` | `shared/types/index.ts:238-247` | `backend/types/index.ts:146-155` | Acceptable — backend uses `Date` objects internally vs `string` in API contract |

### 4.2 Unused Exports

| Export | Package | Action |
|--------|---------|--------|
| `POST_BOOKING_STATUSES` | shared/constants | Remove if unused across all packages |
| `TERMINAL_STATUSES` | shared/constants | Remove if unused across all packages |

### 4.3 Therapist Categories Config

Currently in all 3 packages. The layering is actually **correct**: shared defines base data, backend adds validation helpers, frontend adds UI styling. **No changes needed.**

---

## 5. FRONTEND — Module Integration Readiness

### 5.1 API Client Bloat (943 lines → split by domain)

Current: Single `api/client.ts` with 30+ endpoint functions, repetitive error handling, and mixed domain concerns.

**Split into:**
```
api/core.ts          — fetchApi, fetchAdminApi, error classes, auth, retry logic
api/appointments.ts  — appointment CRUD, controls, reprocessing
api/therapists.ts    — therapist listing, detail
api/knowledge.ts     — knowledge base CRUD
api/settings.ts      — settings management
api/forms.ts         — feedback form config, submissions
api/ingestion.ts     — therapist ingestion
```

### 5.2 Large Page Components

| Page | Lines | Action |
|------|-------|--------|
| `AdminFormsPage.tsx` | 1,282 | Extract form builder UI, submissions table, and stats into sub-components |
| `AdminIngestionPage.tsx` | 1,047 | Extract CV upload, extraction preview, category overrides into sub-components |
| `AdminAppointmentsPage.tsx` | 926 | Extract create form and inline edit components |

**Target:** No page component > 600 lines.

### 5.3 Duplicated Page Patterns — Extract Shared Hooks

Pattern found in 3+ admin pages:
- Edit/save/cancel state management
- Delete confirmation modal
- Mutation + query invalidation boilerplate

**Extract:**
- `useEditableItem<T>()` — edit state, save, cancel
- `useDeleteConfirmation<T>()` — modal state + confirm handler

### 5.4 Module Integration Blockers

| Blocker | Impact | Fix |
|---------|--------|-----|
| `AdminLayout` manages auth (sessionStorage secret) | Cannot embed admin pages without full auth infrastructure | Extract auth to a context provider; make `AdminLayout` optional wrapper |
| Hardcoded `/admin` route prefix in `App.tsx` | Cannot mount at different path | Accept `basePath` prop, use relative routing |
| SSE hook assumes `/admin/dashboard/events` | Breaks if mounted at different prefix | Make SSE endpoint configurable |
| `window.dispatchEvent('admin-auth-failed')` | Global event coupling | Replace with auth context callback |

### 5.5 Positive Integration Points

- All admin pages already lazy-loaded (good for code splitting)
- React Query provides clean server state management
- `BookingForm` and `TherapistCard` are self-contained and reusable
- Environment-based API_BASE is already configurable

---

## 6. DATABASE & INFRASTRUCTURE — Solid Foundation

### 6.1 Schema (14 models, 32+ indexes)

The Prisma schema is well-designed with:
- Rich appointment lifecycle tracking (7 states, audit trail, thread divergence)
- Proper cascade deletes (PendingEmail, AuditEvent, SideEffectLog)
- Denormalized columns for performance (messageCount, checkpointStage avoid loading 500KB+ conversationState)
- Idempotency keys for duplicate prevention

**No schema changes needed for refactor.** The schema is integration-ready via the existing ATS endpoints.

### 6.2 No Repository Layer

Prisma is used directly in routes and services (102 occurrences across 14 route files). This is acceptable for the current scale but means:
- Query logic is scattered (same appointment queries appear in admin-appointments, admin-stats, admin-data)
- For ATS module integration, the existing `ats-integration.routes.ts` already serves as the data access boundary

**Recommendation:** Don't add a repository layer now — it would be over-engineering. The ATS routes already provide the integration API. When this becomes a module, the ATS routes become the module's public API.

### 6.3 Auth — Single Webhook Secret

Current auth is a shared webhook secret, not multi-tenant. For ATS integration:
- The existing webhook secret pattern works for service-to-service auth
- For multi-tenant support (if needed later), add JWT with org claims
- Brute-force protection is already solid (timing-safe compare, rate limiting, IP extraction)

### 6.4 Config — Well-Validated

Zod-validated config at startup with proper defaults and environment-specific behavior. **No changes needed.**

---

## 7. PRIORITIZED REFACTOR PLAN

### Phase 1 — Quick Wins (Low risk, high impact)
1. Remove deprecated functions from `input-sanitizer.ts` (~200 lines)
2. Consolidate date utilities into single `utils/date.ts`
3. Remove duplicate type definitions (HealthStatus, ConversationStage) — import from shared
4. Standardize response format in `admin-data.routes.ts` and `admin-knowledge.routes.ts`
5. Remove unused constant exports (POST_BOOKING_STATUSES, TERMINAL_STATUSES if confirmed unused)

### Phase 2 — Service Decomposition (Medium risk, high impact)
6. Split `email-processing.service.ts` into ingest/oauth/processor
7. Split `justin-time.service.ts` into conversation/tool-executor/availability
8. Split `stale-check.service.ts` into detection/chase
9. Extract `appointment-notifications.service.ts` from lifecycle
10. Merge `pending-email.service.ts` into email-queue (eliminate dual-queue)
11. Merge `gmail-watch.service.ts` into email-oauth
12. Merge `slack-weekly-summary.service.ts` into notification-dispatcher

### Phase 3 — Structural Reorganization (Medium risk, medium impact)
13. Move 6 service-complexity utils to `services/` directory
14. Split `redis.ts` into cache.service.ts + redis-client.ts
15. Consolidate admin route files (12 → 4 + aggregator)
16. Merge webhook route files (3 → 1)

### Phase 4 — Frontend Module Readiness (Low risk, medium impact)
17. Split `api/client.ts` into domain-specific modules
18. Extract shared admin hooks (useEditableItem, useDeleteConfirmation)
19. Decompose large page components (AdminFormsPage, AdminIngestionPage, AdminAppointmentsPage)
20. Extract auth to context provider, make AdminLayout optional
21. Accept configurable basePath for routing

---

## 8. ESTIMATED IMPACT

| Metric | Before | After |
|--------|--------|-------|
| Largest service file | 2,751 lines | ~900 lines |
| Backend service files | 32 | 36 (more, but each focused) |
| Utils misplaced as services | 6 files / 3,446 lines | 0 |
| Route files | 21 | 12 |
| Deprecated code | ~200 lines | 0 |
| Duplicated types | 2 definitions | 0 |
| Frontend API client | 1 file / 943 lines | 7 files / ~150 lines each |
| Circular dependency chains | 1 (3-service cycle) | 0 |
| Largest page component | 1,282 lines | ~600 lines |

**No functionality loss. No performance degradation. The ATS integration API (`/api/v1/ats/*`) remains the module's public contract — already well-designed with versioning, pagination, and idempotency.**
