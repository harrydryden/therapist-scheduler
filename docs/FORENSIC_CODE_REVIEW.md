# Forensic Code Review — Therapist Scheduler

**Date:** 2026-03-06
**Scope:** Full codebase audit — backend services, frontend components, database schema, API routes, shared types
**Focus:** Bugs, race conditions, refactor opportunities, security, data integrity

---

## Executive Summary

The codebase is well-architected with many defensive patterns already in place (circuit breakers, optimistic locking, audit trails, graceful shutdown). However, several **critical bugs**, **race conditions**, and **refactor opportunities** remain. This review categorizes findings by severity and provides actionable recommendations.

**Critical/High:** 8 issues
**Medium:** 7 issues
**Low/Informational:** 6 issues

---

## CRITICAL — Must Fix

### 1. Email Bounce Handler: Non-Atomic Status Transition (Race Condition)

**File:** `packages/backend/src/services/email-bounce.service.ts:215-225`

**Bug:** The bounce handler updates appointment status to `cancelled` using a simple `prisma.appointmentRequest.update()` without a status precondition. Between the `findFirst()` and the `update()`, another process could transition the appointment to `confirmed`. The bounce handler would then overwrite a legitimate confirmation with `cancelled`.

**Impact:** A confirmed appointment could be silently cancelled if a bounce notification arrives late (e.g., delayed DSN for a previous failed attempt after a retry succeeded).

**Fix:** Use `updateMany` with a status precondition (same pattern used in `post-booking-followup.service.ts`):
```typescript
const result = await prisma.appointmentRequest.updateMany({
  where: {
    id: appointment.id,
    status: { notIn: ['confirmed', 'completed', 'cancelled'] },
  },
  data: { status: 'cancelled', notes: '...', isStale: false },
});
if (result.count === 0) {
  logger.warn('Bounce received but appointment already in terminal/confirmed state — skipping');
  return result;
}
```

Additionally, the `recalculateUniqueRequestCount()` call on line 233 is not wrapped in error handling. If it fails, the therapist remains frozen indefinitely.

---

### 2. Cleanup Sentinel Queries: 4 Separate UPDATE Queries (Refactor + Performance)

**File:** `packages/backend/src/services/post-booking-followup.service.ts:158-233`

**Issue:** `cleanupStuckSentinels()` runs 4 separate `updateMany` queries (one for each sentinel field: `meetingLinkCheckSentAt`, `feedbackFormSentAt`, `reminderSentAt`, `feedbackReminderSentAt`) every 15 minutes. These can be consolidated into a single query using Prisma's `OR` filter.

**Fix:** Combine into a single query:
```typescript
await prisma.appointmentRequest.updateMany({
  where: {
    updatedAt: { lt: twoMinutesAgo },
    OR: [
      { meetingLinkCheckSentAt: epochDate },
      { feedbackFormSentAt: epochDate },
      { reminderSentAt: epochDate },
      { feedbackReminderSentAt: epochDate },
    ],
  },
  data: {
    meetingLinkCheckSentAt: { set: null },  // Only resets if currently sentinel
    feedbackFormSentAt: { set: null },
    reminderSentAt: { set: null },
    feedbackReminderSentAt: { set: null },
  },
});
```

**Note:** Prisma `updateMany` sets all fields in `data` unconditionally, so the fix needs a raw query or 4 separate queries. However, these should at least run concurrently with `Promise.all()` instead of sequentially.

---

### 3. Inactive Therapist Check: Silent Error Swallowing

**File:** `packages/backend/src/services/therapist-booking-status.service.ts:579-585`

**Bug:** When `checkAndHandleInactiveTherapists()` fails, it returns `{ flaggedCount: -1, unfrozenCount: 0 }`. The caller in `stale-check.service.ts:522-536` only checks `if (flaggedCount > 0)` and `if (unfrozenCount > 0)`, so the `-1` error sentinel is **never detected**. Failed inactivity checks are silently ignored.

**Fix:** Either throw the error (so the caller's catch block handles it) or check for negative values:
```typescript
if (flaggedCount < 0) {
  logger.error({ checkId }, 'Inactive therapist check failed — review therapist-booking-status logs');
}
```

---

### 4. SSE Hook: Stale Closure on Admin Secret

**File:** `packages/frontend/src/hooks/useSSE.ts:27-100`

**Bug:** The `secret` variable is captured in the `connect()` closure but the `useEffect` dependency array only includes `[queryClient]`. If the admin re-authenticates (enters a new secret after a 401), the SSE connection won't reconnect with the new secret — it will keep using the stale one or remain disconnected.

**Fix:** Track the secret as a state variable or include it in the dependency array:
```typescript
const secret = getAdminSecret();
useEffect(() => {
  if (!secret) return;
  // ... connect logic
}, [queryClient, secret]);
```

---

## HIGH — Should Fix

### 5. Status Color Mappings: Duplicated and Divergent

**Files:**
- `packages/frontend/src/config/color-mappings.ts:8-24` — Central color definitions (Spill palette)
- `packages/frontend/src/pages/AdminAppointmentsPage.tsx:18-27` — Separate color definitions (standard Tailwind)

**Issue:** `AdminAppointmentsPage` defines its own `STATUS_COLORS` with **different values** from the central `color-mappings.ts`:
- Central: `negotiating: 'bg-spill-blue-200 text-spill-blue-900'`
- AdminAppointments: `negotiating: 'bg-purple-100 text-purple-800'`
- Central: `feedback_requested: 'bg-purple-100 text-purple-700'`
- AdminAppointments: `feedback_requested: 'bg-orange-100 text-orange-800'`

**Impact:** Inconsistent visual language across admin dashboard and admin appointments pages. Users see different colors for the same status.

**Fix:** Import from `color-mappings.ts`:
```typescript
import { STATUS_BADGE_COLORS, getStatusColor } from '../config/color-mappings';
```

---

### 6. AppointmentDetailPanel: SSE Updates Override Active Edits

**File:** `packages/frontend/src/components/AppointmentDetailPanel.tsx:61-66`

**Bug:** When `appointmentDetail` updates (e.g., via SSE real-time push), the `useEffect` unconditionally resets the edit form state:
```typescript
useEffect(() => {
  if (appointmentDetail) {
    setEditStatus(appointmentDetail.status);
    setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
  }
}, [appointmentDetail]);
```

If an admin is actively editing and an SSE event triggers an invalidation, their in-progress edits are silently overwritten.

**Fix:** Only sync when the edit panel is not open:
```typescript
useEffect(() => {
  if (appointmentDetail && !showEditPanel) {
    setEditStatus(appointmentDetail.status);
    setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
  }
}, [appointmentDetail, showEditPanel]);
```

---

### 7. History ID Persistence: Fire-and-Forget with No Retry

**File:** `packages/backend/src/services/email-processing.service.ts:502-519`

**Issue:** The Gmail history ID is written to Redis (primary) and database (fallback) but the database write is fire-and-forget. If both Redis restarts AND the database write failed, the history ID checkpoint is lost, causing all recent emails to be reprocessed.

**Mitigation:** The individual message dedup (processedGmailMessage) prevents actual duplicate processing, but it causes unnecessary load. Consider adding a simple retry (1 attempt) for the database write.

---

### 8. Serializable Transactions Under Contention

**File:** `packages/backend/src/services/therapist-booking-status.service.ts:170-181`

**Issue:** Uses `Serializable` isolation level for booking status updates. Under high concurrency (multiple users booking the same therapist simultaneously), serialization failures can cascade. The retry logic (3 retries with 50-500ms backoff) helps but under sustained load, all retries could exhaust.

**Recommendation:** Consider `RepeatableRead` with explicit row-level locking (`SELECT ... FOR UPDATE`) as an alternative that provides the same guarantees with less contention.

---

## MEDIUM — Improve When Possible

### 9. `formatDateTime` Utility: Duplicated Across Pages

**File:** `packages/frontend/src/pages/AdminAppointmentsPage.tsx:67-82`

A local `formatDateTime` function is defined here. Similar date formatting exists in multiple places. Should be extracted to a shared utility.

---

### 10. Boolean Setting Logic Confusion

**File:** `packages/backend/src/services/stale-check.service.ts:686-690`

```typescript
const autoCompleteFeedback = await getSettingValue<boolean>('chase.autoCompleteFeedback');
if (!autoCompleteFeedback) {
  logger.debug({ checkId }, 'Feedback auto-completion disabled - skipping');
}
const feedbackCompleted = autoCompleteFeedback ? await this.autoCompleteFeedbackDeadEnds(checkId) : 0;
```

The debug log fires when the value is `false`, `null`, or `undefined`, but doesn't `return` or `continue` — it falls through to the ternary which also handles the falsy case. The debug log is misleading because it says "skipping" but doesn't actually skip the subsequent code; the ternary just returns 0. Not a bug, but confusing control flow.

**Fix:** Remove the separate `if` block and rely solely on the ternary, or add `return` to the if block.

---

### 11. Schema: Redundant Indexes

**File:** `packages/backend/prisma/schema.prisma`

- `@@index([status])` (line 176) is a prefix of `@@index([status, lastActivityAt])` (line 182), `@@index([status, isStale])` (line 183), `@@index([status, confirmedDateTimeParsed])` (line 187), `@@index([status, reminderSentAt, confirmedDateTimeParsed])` (line 190), and `@@index([status, chaseSentAt])` (line 194). The standalone `status` index is redundant since PostgreSQL can use the leftmost prefix of any compound index for single-column queries.

- `@@index([confirmedAt])` (line 184) — only used for dashboard stats. Verify query patterns justify a standalone index.

**Impact:** Each redundant index adds write amplification on every INSERT/UPDATE.

---

### 12. SSE Secret in Query String

**File:** `packages/frontend/src/hooks/useSSE.ts:36`

```typescript
const url = `${API_BASE}/admin/dashboard/events?secret=${encodeURIComponent(secret)}`;
```

The admin secret is passed as a URL query parameter. This means it appears in:
- Server access logs
- Browser history
- Network monitoring tools
- Proxy logs

This is an accepted risk (noted in the codebase), but worth documenting that the planned migration to httpOnly cookies should also address SSE auth.

---

### 13. Prisma Schema: `User` and `Therapist` Relations Are Optional

**File:** `packages/backend/prisma/schema.prisma:70-73`

```prisma
userId      String? @map("user_id")
therapistId String? @map("therapist_id")
user        User?      @relation(fields: [userId], references: [id])
therapist   Therapist? @relation(fields: [therapistId], references: [id])
```

These are optional, meaning appointments can exist without proper User/Therapist records. This was likely intentional (appointments created before User/Therapist entities existed), but creates data integrity gaps. Orphaned appointments can't be traced to users.

---

### 14. Frontend: No Email Validation on Booking Form

**File:** `packages/frontend/src/components/BookingForm.tsx`

The booking form relies solely on HTML5 `type="email"` validation. No programmatic email format validation exists. Server-side validation catches invalid emails, but the UX would benefit from immediate client-side feedback.

---

### 15. `ApiError.details` Type Too Permissive

**File:** `packages/frontend/src/api/client.ts:35-40`

```typescript
details?: {
  maxAllowed?: number;
  activeCount?: number;
  activeTherapists?: string[];
  [key: string]: unknown;  // Index signature allows anything
};
```

The `[key: string]: unknown` index signature defeats TypeScript's type checking. Known error detail shapes should be modeled as a discriminated union.

---

## LOW — Nice to Have

### 16. Type Divergence: Backend `AppointmentListItem` vs Shared

The backend `types/index.ts:86-101` defines `AppointmentListItem` with `Date` types for `confirmedAt`, `createdAt`, `updatedAt`. The shared package defines the same interface with `string` types. This is by design (backend uses Date internally, serializes to string for API), but creates a naming collision. The backend type shadows the shared type name.

### 17. `ProcessedGmailMessage` Table Bloat

Database fallback lock records in `processedGmailMessage` are never deleted on success (line 1339-1352). They accumulate for 30 days until the retention service cleans them. Under Redis outages, this table could grow significantly.

### 18. Notion Availability Cache: 60s TTL

**File:** `packages/backend/src/services/notion.service.ts:56`

Availability is cached for 60 seconds. A therapist who removes availability in Notion could still receive bookings for up to 60 seconds. The booking validation layer should provide an additional check.

### 19. Virtual List Overscan

**File:** `packages/frontend/src/components/TherapistGroupList.tsx:385`

`overscanCount={5}` with ~120px row heights renders ~35 extra items beyond viewport. Could be reduced to 2-3 for better performance on low-end devices.

### 20. Missing `onDelete` Cascade for `WeeklyMailingInquiry`

**File:** `packages/backend/prisma/schema.prisma:328-343`

`WeeklyMailingInquiry` has no cascade delete rules and no foreign key relations. Orphaned records will accumulate over time. Should have a retention/cleanup mechanism.

### 21. `TherapistBookingStatus.frozenUntil` — Legacy Field

**File:** `packages/backend/prisma/schema.prisma:245`

Marked as "Legacy field, kept for compatibility" but still has an index on it (`@@index([frozenUntil])`). If it's truly unused, the index is pure write overhead.

---

## Refactoring Opportunities

### R1. Consolidate Status/Stage Mappings

Status labels, colors, and stage labels are defined in multiple places:
- `color-mappings.ts` — canonical
- `AdminAppointmentsPage.tsx` — local override
- `AdminDashboardPage.tsx` — inline references

**Action:** Delete local mappings, import from `color-mappings.ts` everywhere.

### R2. Extract Date Formatting Utility

`formatDateTime`, `toDatetimeLocalValue`, and similar functions are defined locally in `AdminAppointmentsPage.tsx`. These should be in a shared utility file.

### R3. Batch Sentinel Cleanup with `Promise.all`

The 4 sequential `updateMany` calls in `cleanupStuckSentinels` should run concurrently since they have no dependencies.

### R4. Background Service Lifecycle Pattern

Multiple background services (`PostBookingFollowupService`, `StaleCheckService`, `EmailPollingService`, etc.) implement the same start/stop/interval pattern. Consider a base class or factory function to reduce boilerplate.

---

## What's Working Well

- **Circuit breakers** on Gmail, Slack, Notion, and Claude API calls
- **Atomic status transitions** in `appointment-lifecycle.service.ts` using `updateMany` with preconditions
- **Timing-safe auth comparison** to prevent timing attacks
- **Brute force protection** with Redis-backed rate limiting
- **Request tracing** via AsyncLocalStorage for end-to-end correlation
- **Graceful shutdown** with proper service cleanup ordering
- **Optimistic UI updates** with rollback in React Query mutations
- **Side effect tracking** with two-phase commit pattern for reliability
- **Audit trail** via append-only `AppointmentAuditEvent` model
- **SSE real-time updates** with exponential backoff reconnection
- **Code splitting** with React.lazy for admin pages
- **Comprehensive error boundaries** in frontend

---

## Recommended Priority Order

1. **Fix #1** — Email bounce race condition (data corruption risk)
2. **Fix #3** — Silent error swallowing in inactive therapist check (ops blindness)
3. **Fix #4** — SSE stale closure (admin UX broken after re-auth)
4. **Fix #5** — Status color divergence (visual inconsistency)
5. **Fix #6** — Edit panel override by SSE updates (data loss during editing)
6. **Fix #2** — Sentinel cleanup performance (4 queries → concurrent)
7. **Fix #7** — History ID persistence resilience
8. **Fix #10** — Boolean logic confusion in stale check
