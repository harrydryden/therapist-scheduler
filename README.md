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

- **`packages/backend`** — Fastify + TypeScript API server with Prisma ORM, Redis caching, Gmail API (email), Claude AI (scheduling agent), Slack (notifications), and BullMQ (job queue)
- **`packages/frontend`** — React + Vite + TailwindCSS admin dashboard and public booking UI
- **`packages/shared`** — Shared TypeScript types, constants, and config used by both packages

### Key Integrations

| Service | Role |
|---------|------|
| **PostgreSQL** | Primary data store (appointments, users, therapists, audit logs) |
| **Redis** | Caching, distributed locking, rate limiting, email dedup |
| **Claude (Anthropic)** | AI agent that conducts email conversations |
| **Gmail API** | Sends/receives emails via Pub/Sub push + polling fallback |
| **Slack** | Admin notifications and weekly summaries |
| **BullMQ** | Email send queue with retry and backoff |

## Prerequisites

- Node.js 18+
- PostgreSQL 15+
- Redis 7+
- Anthropic API key
- Google OAuth credentials (Gmail API)

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
| SideEffectRetryService | Retries failed Slack side effects | 5 min |
| WeeklyMailingListService | Sends weekly promotional mailing | Hourly |
| AppointmentLifecycleTickService | Transitions confirmed → session_held after the session time | 30 min |
| SlackWeeklySummaryService | Monday 9am weekly summary to Slack | Hourly |

## Health Checks

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | None | Liveness probe — is the process running? |
| `GET /health/ready` | None | Readiness probe — database and Redis connectivity |
| `GET /health/circuits` | Admin | Circuit breaker states (Gmail, Slack, Claude) |
| `GET /health/tasks` | Admin | Background task success rates and errors |
| `GET /health/full` | Admin | Comprehensive diagnostic combining all checks |

## Production Deployment

```bash
docker-compose up -d
```

See `docs/PRODUCTION_DEPLOYMENT.md` for the full deployment and operations guide.

### Production env-var safety matrix

A handful of environment variables are load-bearing in production and the
service either refuses to start or logs a loud `INSECURE CONFIG` banner
when they're misconfigured. Before deploying, audit your production env
against this table.

| Variable | Default | Required in prod | What goes wrong if misconfigured |
|----------|---------|------------------|----------------------------------|
| `NODE_ENV` | `development` | must be `production` | Production-mode safety checks (below) only fire when this is `production`. Forgetting it silently disables them. |
| `BACKEND_URL` | `http://localhost:3000` | required, non-localhost | Schema rejects localhost in prod. Unsubscribe links, voucher URLs, and feedback URLs all derive from this — wrong host means broken links. |
| `FRONTEND_URL` | `http://localhost:5173` | required, non-localhost | Same shape as above; signup invitation links 404 if wrong. |
| `CORS_ORIGIN` | unset | required (comma-separated origins) | Without this, CORS rejects every cross-origin request in prod (admin dashboard goes blank). |
| `REQUIRE_PUBSUB_AUTH` | `true` | leave unset (or explicitly `true`) | **Setting to `false` in prod triggers the recurring `INSECURE CONFIG` boot banner.** The Gmail push webhook then accepts unauthenticated POSTs — forged Pub/Sub notifications can drive bounce, cancel, and reschedule flows. Configure GCP Pub/Sub OIDC auth instead of using this override (see below). |
| `GOOGLE_PUBSUB_AUDIENCE` | unset | should be set to the audience configured on the GCP push subscription | When unset, the webhook still verifies the token came from a Google service account but **skips the audience claim check** — a token minted for any GCP push subscription pointing at this host would verify. Triggers an `INSECURE CONFIG` warning at boot. Set to your webhook URL (e.g. `https://<host>/api/webhooks/gmail/push`) or the custom audience string configured on the subscription. |
| `GOOGLE_PUBSUB_TOPIC` | unset | required for Gmail push | Without this, Gmail push isn't set up and inbound email falls back to the 3-minute backup poll path. Functional but slower and burns more Gmail API quota. Format: `projects/<project>/topics/<topic>`. |
| `JWT_SECRET` | unset | required | All HMAC-derived tokens (unsubscribe, voucher, feedback) sign with keys derived from this. Rotation: set the new value in `JWT_SECRET` and the old value(s) in `HMAC_KEYS_OLD` (comma-separated) so previously-issued tokens keep verifying. |
| `HMAC_KEYS_OLD` | unset | optional, used during rotation | Comma-separated previous `JWT_SECRET` values. Tokens signed with any listed key still verify. Drop entries once their tokens have aged past their validity window. |
| `WEBHOOK_SECRET` | unset | required | Validates inbound Notion / external webhooks. |
| `ANTHROPIC_API_KEY` | unset | required | The agent stops working without it. No banner — the failure is at first agent call. |
| `DATABASE_URL` | unset | required | Service won't start. |
| `REDIS_URL` | `redis://localhost:6379` | required, non-localhost in prod | Tool idempotency and lock primitives need Redis. Local default falls open with warnings. |

#### Pre-deploy checklist

Whenever a security-tightening change ships, check production env vars
for any overrides that opt into the previously-permissive behaviour
**before** deploying. The H5 incident (May 2026) was a deploy that
shipped a stricter Pub/Sub-auth check while production still had
`REQUIRE_PUBSUB_AUTH=false` set — the service crash-looped because the
new code refused to validate that combination. The lesson:

1. Read the security PR description for any **"production env vars to
   audit before deploy"** section.
2. Cross-check those against your live env-var dashboard.
3. If a tightening would refuse a current setting, fix the env var
   first, then deploy the code.

#### Configuring Pub/Sub OIDC auth (the canonical fix for `REQUIRE_PUBSUB_AUTH=false`)

The webhook expects each push to include an `Authorization: Bearer <oidc_jwt>`
header signed by a Google service account. Setup, in brief:

1. **Create a service account** in your GCP project — e.g.
   `pubsub-gmail-pusher@<project>.iam.gserviceaccount.com`. No
   project-level roles needed.
2. **Grant `roles/iam.serviceAccountTokenCreator`** to the Google-managed
   Pub/Sub service agent (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`)
   *on* the service account from step 1.
3. **Edit the push subscription** that delivers Gmail notifications to
   your webhook. Enable Authentication, set the service account from
   step 1, and set the audience to your webhook URL (or a stable custom
   string).
4. **Set `GOOGLE_PUBSUB_AUDIENCE`** on Railway/your env to match the
   audience from step 3.
5. **Unset `REQUIRE_PUBSUB_AUTH`** (default `true` re-engages auth
   enforcement). The boot banner stops on the next deploy.

Verify with `gcloud pubsub subscriptions describe <name>` — the output
should show `pushConfig.oidcToken.serviceAccountEmail` and
`pushConfig.oidcToken.audience`.

## Documentation

- [`docs/PRODUCTION_DEPLOYMENT.md`](docs/PRODUCTION_DEPLOYMENT.md) — Deployment, monitoring, and operations guide
- [`docs/ARCHITECTURE_RECOMMENDATIONS.md`](docs/ARCHITECTURE_RECOMMENDATIONS.md) — Scaling roadmap and architectural decisions
- [`docs/FORENSIC_CODE_REVIEW.md`](docs/FORENSIC_CODE_REVIEW.md) — Detailed code audit with findings and resolutions
- [`docs/MONOREPO_MIGRATION.md`](docs/MONOREPO_MIGRATION.md) — Historical record of the two-repo consolidation
