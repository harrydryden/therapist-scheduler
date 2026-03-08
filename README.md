# Therapist Scheduler

AI-powered scheduling platform that coordinates therapy appointments between clients and therapists via email. A Claude AI agent autonomously handles the full appointment lifecycle — from initial contact through booking confirmation and feedback collection — while an admin dashboard provides real-time oversight and manual intervention controls.

## How It Works

1. **Client submits a booking request** via the public-facing form (name, email, preferred therapist)
2. **The AI agent contacts the therapist** by email, negotiates available slots, and relays options to the client
3. **Once a slot is selected**, the agent confirms the appointment with both parties
4. **Post-session**, the system sends feedback forms and tracks completion
5. **Admins monitor everything** via a real-time dashboard — they can take manual control of any conversation at any time

## Architecture

Monorepo with three packages:

- **`packages/backend`** — Fastify + TypeScript API server with Prisma ORM, Redis caching, Gmail API (email), Claude AI (scheduling agent), Notion (therapist database), Slack (notifications), and BullMQ (job queue)
- **`packages/frontend`** — React + Vite + TailwindCSS admin dashboard and public booking UI
- **`packages/shared`** — Shared TypeScript types, constants, and config used by both packages

### Key Integrations

| Service | Role |
|---------|------|
| **PostgreSQL** | Primary data store (appointments, users, audit logs) |
| **Redis** | Caching, distributed locking, rate limiting, email dedup |
| **Claude (Anthropic)** | AI agent that conducts email conversations |
| **Gmail API** | Sends/receives emails via Pub/Sub push + polling fallback |
| **Notion** | Read-only therapist database (availability, profiles) |
| **Slack** | Admin notifications and weekly summaries |
| **BullMQ** | Email send queue with retry and backoff |

## Prerequisites

- Node.js 18+
- PostgreSQL 15+
- Redis 7+
- Anthropic API key
- Google OAuth credentials (Gmail API)
- Notion integration token

## Quick Start

```bash
# Install all workspace dependencies
npm install

# Start infrastructure
docker-compose -f docker-compose.dev.yml up -d postgres redis

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Generate Prisma client and push schema
npm -w therapist-scheduler-backend run db:generate
npm -w therapist-scheduler-backend run db:push

# Start development servers
npm run dev:backend   # API server on :3000
npm run dev:frontend  # Vite dev server on :5173
```

## Scripts

```bash
npm run build           # Build shared -> backend -> frontend
npm run build:all       # Alias for build
npm run build:frontend  # Build shared -> frontend only
npm run dev:frontend    # Start frontend dev server
npm run dev:backend     # Start backend dev server
npm run test:all        # Run backend tests
npm run typecheck:all   # Type-check all packages
npm run lint:all        # Lint all packages
```

## Project Structure

```
therapist-scheduler/
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── services/      # Core business logic (AI agent, email, lifecycle, etc.)
│   │   │   ├── routes/        # REST API + webhook endpoints
│   │   │   ├── utils/         # Validators, parsers, circuit breakers, tracing
│   │   │   ├── middleware/    # JWT auth, request tracing
│   │   │   ├── config/       # Environment validation, therapist categories
│   │   │   ├── constants/    # Centralized magic numbers and settings
│   │   │   ├── types/        # Backend-internal TypeScript types
│   │   │   ├── __tests__/    # Jest test suite
│   │   │   └── server.ts     # Fastify setup + background service orchestration
│   │   └── prisma/           # Database schema + migrations
│   ├── frontend/
│   │   └── src/
│   │       ├── pages/        # Admin dashboard + public booking pages
│   │       ├── components/   # Reusable UI (detail panels, filters, pipeline)
│   │       ├── hooks/        # SSE, form persistence, booking form
│   │       ├── api/          # API client with React Query
│   │       ├── utils/        # Date formatting, validation, error reporting
│   │       └── config/       # API base URL, color mappings, categories
│   └── shared/
│       └── src/
│           ├── types/        # API contract types (AppointmentListItem, etc.)
│           ├── config/       # Therapist category definitions
│           └── constants/    # Appointment status enums
├── docs/                     # Architecture and operations documentation
├── docker-compose.yml        # Production deployment (PostgreSQL, Redis, app)
├── docker-compose.dev.yml    # Development with hot reload
├── Dockerfile                # Multi-stage build
└── .env.example              # Environment variable template
```

## Appointment Lifecycle

The appointment state machine is the core abstraction, managed atomically by `AppointmentLifecycleService`:

```
pending -> contacted -> negotiating -> confirmed -> session_held -> feedback_requested -> completed
                |            |              |
             cancelled    cancelled      cancelled   (any active state -> cancelled)
```

All transitions use optimistic locking (`updateMany` with status preconditions) to prevent race conditions.

## Background Services

Ten background services run on configurable intervals, coordinated via Redis distributed locks:

| Service | Purpose | Interval |
|---------|---------|----------|
| EmailQueueService | BullMQ email send queue with retry | Continuous |
| EmailPollingService | Fallback Gmail polling if Pub/Sub fails | 3 min |
| GmailWatchService | Renews Gmail push notification watches | 15 min |
| PendingEmailService | Retries failed email sends | 2 min |
| StaleCheckService | Flags 48h+ inactive conversations | 30 min |
| PostBookingFollowupService | Meeting link checks, feedback forms | 15 min |
| SideEffectRetryService | Retries failed Slack/Notion side effects | 5 min |
| WeeklyMailingListService | Sends weekly promotional mailing | Hourly |
| NotionSyncManager | Syncs therapist data, freezing, feedback to Notion | 5 min |
| SlackWeeklySummaryService | Monday 9am weekly summary to Slack | Hourly |

## Health Checks

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | None | Liveness probe — is the process running? |
| `GET /health/ready` | None | Readiness probe — database and Redis connectivity |
| `GET /health/circuits` | Admin | Circuit breaker states (Gmail, Slack, Notion, Claude) |
| `GET /health/tasks` | Admin | Background task success rates and errors |
| `GET /health/full` | Admin | Comprehensive diagnostic combining all checks |

## Production Deployment

```bash
docker-compose up -d
```

See `docs/PRODUCTION_DEPLOYMENT.md` for the full deployment and operations guide.

## Documentation

- [`docs/PRODUCTION_DEPLOYMENT.md`](docs/PRODUCTION_DEPLOYMENT.md) — Deployment, monitoring, and operations guide
- [`docs/ARCHITECTURE_RECOMMENDATIONS.md`](docs/ARCHITECTURE_RECOMMENDATIONS.md) — Scaling roadmap and architectural decisions
- [`docs/FORENSIC_CODE_REVIEW.md`](docs/FORENSIC_CODE_REVIEW.md) — Detailed code audit with findings and resolutions
- [`docs/MONOREPO_MIGRATION.md`](docs/MONOREPO_MIGRATION.md) — Historical record of the two-repo consolidation
