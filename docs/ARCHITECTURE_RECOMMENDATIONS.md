# Therapist Scheduler — Architecture Evaluation & Recommendations

**Date:** 2026-02-16 (updated 2026-03-08)
**Purpose:** Scale infrastructure for ATS system processing hundreds of applications/month

---

## Executive Summary

The current architecture is well-designed for a **prototype/MVP stage** but has several bottlenecks that will become critical as you scale to hundreds of applications per month and build toward a full ATS system.

---

## Current Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CURRENT ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   [User Browser]                                                                 │
│        │                                                                         │
│        ▼                                                                         │
│   ┌─────────────────┐     /api/* proxy      ┌─────────────────────┐             │
│   │    VERCEL       │ ──────────────────────▶│     RAILWAY         │             │
│   │  (Frontend)     │                        │    (Backend)        │             │
│   │  React + Vite   │                        │   Fastify + TS      │             │
│   └─────────────────┘                        └──────────┬──────────┘             │
│                                                         │                        │
│                              ┌──────────────────────────┼──────────────────┐     │
│                              │                          │                  │     │
│                              ▼                          ▼                  ▼     │
│                    ┌─────────────────┐       ┌─────────────────┐  ┌────────────┐│
│                    │   POSTGRESQL    │       │     NOTION      │  │   REDIS    ││
│                    │   (Railway)     │       │  (Therapist DB) │  │ (Railway)  ││
│                    └─────────────────┘       └─────────────────┘  └────────────┘│
│                                                                                  │
│                    ┌─────────────────┐       ┌─────────────────┐  ┌────────────┐│
│                    │     GMAIL       │       │     CLAUDE      │  │   SLACK    ││
│                    │  (Pub/Sub)      │       │   (Anthropic)   │  │ (Webhooks) ││
│                    └─────────────────┘       └─────────────────┘  └────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Critical Issues for Scale

### 1. Notion as Primary Therapist Data Store

| Issue | Impact | Severity |
|-------|--------|----------|
| Notion API rate limits (3 req/sec) | Will throttle at ~100+ therapists | 🔴 Critical |
| No transactional integrity | Race conditions on concurrent updates | 🔴 Critical |
| 5-minute cache TTL | Stale data in high-traffic scenarios | 🟡 Medium |
| Manual sync loops (4 separate syncs) | Complex failure modes, data drift | 🟡 Medium |

### 2. Single Railway Instance

| Issue | Impact | Severity |
|-------|--------|----------|
| No horizontal scaling | Single point of failure | 🔴 Critical |
| All background jobs on same instance | Resource contention | 🔴 Critical |
| Long-running email polling blocks resources | Reduced throughput | 🟡 Medium |

### 3. No CI/CD Pipeline

| Issue | Impact | Severity |
|-------|--------|----------|
| Manual deployments | Slow shipping, human error | 🔴 Critical |
| No automated testing on deploy | Regressions reach production | 🔴 Critical |

> **Update (2026-03):** The codebase has been consolidated into a monorepo (see `MONOREPO_MIGRATION.md`), resolving the previous two-repo coordination overhead. CI/CD pipeline setup remains outstanding.

### 4. Authentication

| Issue | Impact | Severity |
|-------|--------|----------|
| Shared secret in frontend bundle | Security vulnerability | 🔴 Critical |
| No user sessions | Can't track admin actions properly | 🟡 Medium |

---

## Current Strengths (Keep These)

| Pattern | Why It Works |
|---------|--------------|
| `AppointmentLifecycleService` as single source of truth | Prevents state inconsistencies |
| `SideEffectLog` two-phase commit | Reliable retry for external calls |
| `AppointmentAuditEvent` append-only log | Full auditability |
| Circuit breakers on all external APIs | Graceful degradation |
| Redis fallback to PostgreSQL | Resilient caching |
| Zod validation at startup | Fail-fast configuration |
| Gmail push + polling fallback | Reliable email processing |

---

## Recommendations

### Phase 1: Immediate (Pre-Scale) - 1-2 weeks

#### 1.1 Set Up CI/CD with GitHub Actions

> **Status:** Not yet implemented.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck:all
      - run: npm run lint:all
      - run: npm run test:all
      - run: npm run build

  deploy-backend:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: railwayapp/railway-action@v1
        with:
          service: backend
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}

  deploy-frontend:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
```

**Why:** Automated testing + deployment = faster, safer shipping.

#### ~~1.2 Consolidate to Monorepo~~ DONE

Completed in March 2026. The codebase now uses npm workspaces with `packages/shared`, `packages/frontend`, and `packages/backend`. See `MONOREPO_MIGRATION.md` for details.

#### 1.3 Fix Admin Authentication

Replace shared secret with proper session-based auth:
- Add `/api/auth/login` endpoint
- Use HttpOnly cookies with JWT
- Add session table in PostgreSQL
- Remove `VITE_ADMIN_SECRET` from frontend bundle

---

### Phase 2: Data Architecture (2-4 weeks)

#### 2.1 Migrate Therapist Data from Notion to PostgreSQL

**Current:** Notion → (sync) → PostgreSQL (partial)
**Proposed:** PostgreSQL (primary) → (sync) → Notion (display/admin CMS)

```sql
-- New primary therapist table
CREATE TABLE therapists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notion_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bio TEXT,
  profile_image_url TEXT,
  availability JSONB, -- structured slots
  approach TEXT[],
  style TEXT[],
  areas_of_focus TEXT[],
  is_active BOOLEAN DEFAULT true,
  is_frozen BOOLEAN DEFAULT false,
  freeze_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Keep Notion as optional sync target for admin visibility
```

**Migration Strategy:**
1. Create new Prisma models
2. Write one-time migration script from Notion
3. Update services to read from PostgreSQL
4. Keep Notion sync as **write-only** for admin visibility
5. Remove Notion read dependencies

**Why:**
- PostgreSQL has no rate limits
- Transactional integrity
- Sub-millisecond reads vs 200ms+ Notion API
- Proper joins for ATS queries

#### 2.2 Expand Job Queue Usage (BullMQ)

> **Status:** Partially implemented. `EmailQueueService` already uses BullMQ for email sends with exponential backoff retries. Other background services (stale checks, Notion sync, email polling, followups) still use interval-based scheduling with distributed Redis locks.

Remaining work — migrate interval-based services to BullMQ repeatable jobs:

```typescript
// Example: migrate stale check from setInterval to BullMQ
await staleCheckQueue.add('check-stale', {}, {
  repeat: { every: 1800000 } // 30 min
});
```

**Why:**
- Unified retry/backoff across all background work
- Job prioritization and rate limiting
- Separate worker processes (enables Phase 3 service split)
- Dashboard for monitoring (Bull Board)
- Redis-backed persistence (jobs survive restarts)

---

### Phase 3: Infrastructure for Scale (1-2 months)

#### 3.1 Separate Background Workers

```
┌─────────────────────────────────────────────────────────────────┐
│                    PROPOSED ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   [Railway Service: API]           [Railway Service: Workers]   │
│   - HTTP endpoints only            - Email polling               │
│   - Stateless                       - Notion sync                │
│   - Horizontally scalable          - Follow-up scheduler         │
│   - Auto-scaling                   - Weekly mailing              │
│        │                                  │                      │
│        └──────────┬───────────────────────┘                      │
│                   │                                              │
│                   ▼                                              │
│           ┌─────────────┐                                        │
│           │   BullMQ    │                                        │
│           │   (Redis)   │                                        │
│           └─────────────┘                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Railway Configuration:**
- **api** service: `npm run start:api` (Fastify HTTP only)
- **worker** service: `npm run start:worker` (BullMQ workers)

#### 3.2 Add Database Connection Pooling

Use PgBouncer or Prisma Data Platform for connection pooling:

```
DATABASE_URL="postgresql://...?pgbouncer=true&connection_limit=10"
```

**Why:** PostgreSQL has a limited number of connections. With multiple services, you'll hit limits quickly.

#### 3.3 Observability Stack

| Tool | Purpose | Cost |
|------|---------|------|
| **Sentry** | Error tracking | Free tier |
| **Railway Metrics** | Basic APM | Included |
| **Axiom** | Log aggregation | Free tier generous |
| **Checkly** | Synthetic monitoring | Free tier |

Add to backend:
```typescript
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN });
```

---

### Phase 4: ATS-Ready Architecture (2-3 months)

For hundreds of applications per month, you'll need:

#### 4.1 Application Pipeline Model

```sql
CREATE TABLE applications (
  id UUID PRIMARY KEY,
  applicant_id UUID REFERENCES users(id),
  therapist_id UUID REFERENCES therapists(id),
  status application_status NOT NULL,
  source TEXT, -- 'website', 'referral', 'mailing'
  stage application_stage NOT NULL,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TYPE application_stage AS ENUM (
  'new',
  'screening',
  'scheduling',
  'interview_scheduled',
  'interview_complete',
  'offer_pending',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'withdrawn'
);

CREATE TABLE application_events (
  id UUID PRIMARY KEY,
  application_id UUID REFERENCES applications(id),
  event_type TEXT NOT NULL,
  actor_id UUID, -- user or system
  metadata JSONB,
  created_at TIMESTAMPTZ
);
```

#### 4.2 Multi-Tenant Considerations

If expanding beyond single organization:
- Add `organization_id` to core tables
- Row-level security in PostgreSQL
- Consider Supabase for managed auth + RLS

#### 4.3 Document Storage

Move from PDF text extraction to proper document storage:
- **Cloudflare R2** or **AWS S3** for CV/resume storage
- Store extracted text in PostgreSQL
- Keep original files for compliance

---

## Tool Evaluation Matrix

| Current Tool | Verdict | Recommendation |
|--------------|---------|----------------|
| **Vercel** (Frontend) | ✅ Keep | Excellent for React SPAs |
| **Railway** (Backend) | ✅ Keep | Good balance of simplicity/power |
| **Railway PostgreSQL** | ✅ Keep | Upgrade to Pro for larger DB |
| **Railway Redis** | ✅ Keep | Consider Upstash for serverless |
| **Notion** (Therapist DB) | ⚠️ Migrate | Move to PostgreSQL, keep as admin CMS |
| **Gmail API** | ✅ Keep | Works well with Pub/Sub |
| **Anthropic/Claude** | ✅ Keep | Best for agentic scheduling |
| **Slack Webhooks** | ✅ Keep | Simple and reliable |
| **No CI/CD** | 🔴 Add | GitHub Actions essential (monorepo now ready) |

---

## Recommended Roadmap

```
✅ Done:    Monorepo consolidation (packages/shared, frontend, backend)
✅ Done:    BullMQ email queue (EmailQueueService)
✅ Done:    Forensic code review — 25 issues found and resolved
Week 1-2:  CI/CD pipeline (GitHub Actions) + Admin auth fix
Week 3-4:  Sentry integration + expand BullMQ to all background services
Week 5-8:  PostgreSQL migration for therapists (Notion → read-only sync)
Week 9-12: Worker separation + ATS data model
```

---

## Cost Implications

| Service | Current | After Scale-Up |
|---------|---------|----------------|
| Railway | ~$20/mo | ~$50-100/mo (2 services) |
| Vercel | Free | Free (Pro if needed: $20/mo) |
| Notion | Free | Free (consider removing) |
| Anthropic | Usage-based | Same |
| Sentry | Free | Free tier |
| GitHub Actions | Free | Free |

**Total additional cost:** ~$30-80/month for significantly better infrastructure.

---

## Immediate Actions

1. **Create GitHub Actions workflow** for automated testing + deploy (monorepo scripts ready: `npm run test:all`, `npm run typecheck:all`, `npm run lint:all`, `npm run build`)
2. **Fix admin authentication** (remove secret from frontend bundle, migrate to httpOnly cookies)
3. **Set up Sentry** for error tracking
4. **Plan therapist data migration** from Notion → PostgreSQL
