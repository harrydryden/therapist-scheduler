# Production Deployment Guide

## Deployment Scale

This guide covers production deployment for the Therapist Scheduler platform. The current architecture supports:
- 2-3 concurrent appointment negotiations
- 10+ background services running on a single instance
- 10-50 admin dashboard users
- Hundreds of appointments per month

## Pre-Deployment Checklist

### Runtime

Node.js 22 (the Docker image uses `node:22-alpine`; `engines` requires
`>=22`). PostgreSQL 15+ and Redis 7+.

### Required Environment Variables

```bash
# Core
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Database (PostgreSQL 15+)
DATABASE_URL=postgresql://user:password@host:5432/therapist_scheduling

# Redis (7+)
REDIS_URL=redis://host:6379

# Authentication
JWT_SECRET=<cryptographically-secure-random-string-32+-chars>
JWT_EXPIRES_IN=24h

# AI Agent (Anthropic Claude)
ANTHROPIC_API_KEY=sk-ant-your-key

# Gmail API
# Google OAuth credentials configured via service account or OAuth2
GOOGLE_PUBSUB_TOPIC=projects/your-project/topics/gmail-notifications
GOOGLE_PUBSUB_AUDIENCE=your-audience-url

# Webhooks
WEBHOOK_SECRET=your-webhook-secret
```

### Optional Environment Variables

```bash
# Rate Limiting
RATE_LIMIT_MAX=200              # Max requests per window (global)
RATE_LIMIT_WINDOW=60000         # Window duration in ms

# SSE (real-time dashboard updates)
SSE_MAX_CONNECTIONS=100
MAX_CONNECTIONS_PER_USER=3
MAX_TOTAL_CONNECTIONS=50
CONNECTION_TIMEOUT=300000       # 5 minutes

# Performance Monitoring
PERFORMANCE_MONITORING=true
SLOW_QUERY_THRESHOLD=1000      # Log queries slower than 1s
SLOW_AI_THRESHOLD=30000        # Log AI calls slower than 30s

# Token Bucket (API throttling)
TOKEN_BUCKET_CAPACITY=200
TOKEN_BUCKET_REFILL_RATE=20

# Distributed Locking — see "Distributed locking" below
SINGLE_INSTANCE_MODE=false     # default; true only for a known single instance

# CORS
CORS_ORIGIN=https://your-domain.com
CORS_CREDENTIALS=true

# Logging
LOG_LEVEL=info
```

### Distributed locking (`SINGLE_INSTANCE_MODE`)

This section is the one place this setting is documented.

Background jobs (stale check, post-booking follow-ups, side-effect retry,
weekly mailing, …) take a Redis lock before each run
(`utils/redis-locks.ts`). When Redis is unreachable:

| `SINGLE_INSTANCE_MODE` | Behaviour |
|---|---|
| unset / `false` (**default**, also the `docker-compose` default) | The lock is **denied**: the job skips that run. Safe with any number of instances — two instances can never both run a locked job during a Redis outage. |
| `true` | The lock is **granted** without Redis. Keeps background jobs running through a Redis outage, but only correct when exactly one instance runs. Never set it on a multi-instance deploy. |

### Security Checklist

- [ ] `JWT_SECRET` is cryptographically secure (32+ characters, random)
- [ ] `ANTHROPIC_API_KEY` has sufficient quota
- [ ] Database connections use SSL in production
- [ ] Redis connections are password-protected
- [ ] CORS is configured for your specific domain (not wildcard)
- [ ] Rate limiting is enabled
- [ ] Admin authentication secret is not exposed in frontend bundle

## Docker Deployment

### Quick Start

```bash
# Set required environment variables (or use .env file)
cp .env.example .env
# Edit .env with production credentials

# Build and start all services
docker-compose up -d --build

# Check status
docker-compose ps

# View logs
docker-compose logs -f app
```

### What Docker Compose Provides

`docker-compose.yml` runs three services (`docker compose config` validates
it; CI checks this on every push):

| Service | Image | Resources |
|---------|-------|-----------|
| **app** | Built from the Dockerfile | 1 CPU, 1GB RAM |
| **postgres** | postgres:15-alpine, published on `127.0.0.1:5432` only | 0.5 CPU, 512MB RAM |
| **redis** | redis:7-alpine, published on `127.0.0.1:6379` only | 0.25 CPU, 256MB RAM |

The app's `DATABASE_URL` and `REDIS_URL` default to the compose `postgres`
and `redis` services; set them only to point elsewhere. The Postgres
password defaults to `postgres` and Redis has no password — fine on
127.0.0.1, not for anything exposed; set `POSTGRES_PASSWORD` (and a Redis
password) before opening either port.

The Dockerfile has three stages:
1. `builder` — `npm ci`, then builds shared, backend (`prisma generate` +
   `tsc -p tsconfig.build.json`, which does not compile the tests) and the
   frontend (Vite). `docker-compose.dev.yml` runs this stage (it keeps the
   devDependencies for `tsx watch`).
2. `prod-deps` — the builder's `node_modules` with `npm prune --omit=dev`.
   The `prisma` CLI is a runtime dependency (the entrypoint needs it).
3. `production` — `node:22-alpine`, non-root, `dumb-init`; backend `dist/`,
   Prisma schema + migrations, the entrypoint, the frontend build, and the
   pruned `node_modules`. `HEALTHCHECK` runs `dist/health-check.js`
   against `127.0.0.1:$PORT/health`.

A root `.dockerignore` keeps host `node_modules`, `dist`, `.vite`,
`coverage`, `.git` and every `.env*` file out of the build context (a
`packages/frontend/.env*` would otherwise be baked into the bundle).

### Database Migrations

Every container start runs `scripts/docker-entrypoint.sh`, which runs plain
`prisma migrate deploy` and then starts the server. It fails fast: if the
migration step fails for any reason, the container exits non-zero and the
previous release keeps serving (on Railway, the failed deploy never becomes
active). There is no baseline fallback any more — see
docs/SCHEMA_MIGRATIONS.md for why `prisma/baseline.sh` was removed.

A **new, empty** database (a fresh self-hosted stack, staging) must be
bootstrapped once before the first start:

```bash
docker compose run --rm --entrypoint sh app -c \
  "cd packages/backend && sh scripts/bootstrap-dev-db.sh"
```

The bootstrap script refuses to run when `DATABASE_URL` contains `railway`
or `prod`. Never use `prisma db push` against production.

## Health Checks and Monitoring

### Health Endpoints

| Endpoint | Auth Required | Purpose |
|----------|---------------|---------|
| `GET /health` | No | Liveness probe — returns `{ status: "ok" }` if process is running |
| `GET /health/ready` | No | Readiness probe — checks PostgreSQL and Redis connectivity |
| `GET /health/circuits` | Yes (`x-webhook-secret`) | Circuit breaker states for Gmail, Slack, Claude APIs |
| `GET /health/tasks` | Yes (`x-webhook-secret`) | Background task success rates, recent errors, timeout stats |
| `GET /health/full` | Yes (`x-webhook-secret`) | Comprehensive diagnostic combining all checks above |

### Monitoring Commands

```bash
# Basic liveness check
curl http://localhost:3000/health

# Readiness check (database + Redis)
curl http://localhost:3000/health/ready

# Full diagnostic (requires the admin secret header)
curl -H "x-webhook-secret: $WEBHOOK_SECRET" http://localhost:3000/health/full
```

### What to Monitor

| Metric | Healthy | Warning | Action |
|--------|---------|---------|--------|
| Database latency | < 50ms | > 200ms | Check connection pool, query optimization |
| Redis connectivity | Connected | Disconnected | Locked background jobs skip their runs until Redis is back (unless `SINGLE_INSTANCE_MODE=true`); readiness treats Redis as optional |
| Circuit breakers | All CLOSED | Any OPEN | Check external API status (Gmail/Slack/Claude) |
| Background tasks | All healthy | Error rate > 10% | Check service logs for failures |
| AI response time | < 10s | > 30s | Check Anthropic API status, review prompt size |

## Configuration Tuning

### Small Scale (current — up to 50 appointments/month)

```
RATE_LIMIT_MAX=200
SSE_MAX_CONNECTIONS=100
TOKEN_BUCKET_CAPACITY=200
MAX_CONNECTIONS_PER_USER=3
MAX_TOTAL_CONNECTIONS=50
```

### Medium Scale (50-200 appointments/month)

```
RATE_LIMIT_MAX=500
SSE_MAX_CONNECTIONS=250
TOKEN_BUCKET_CAPACITY=500
MAX_CONNECTIONS_PER_USER=5
MAX_TOTAL_CONNECTIONS=150
```

### Large Scale (200+ appointments/month)

```
RATE_LIMIT_MAX=1000
SSE_MAX_CONNECTIONS=500
TOKEN_BUCKET_CAPACITY=1000
MAX_CONNECTIONS_PER_USER=10
MAX_TOTAL_CONNECTIONS=500
```

At large scale, consider separating API and worker services into independent deploys.

## Troubleshooting

### High Memory Usage

```bash
# Check container resource usage
docker stats

# Restart the app service
docker-compose restart app
```

Common causes: large conversation state blobs (500KB+ JSON), SSE connection accumulation, Redis backpressure.

### Slow AI Responses

Check Anthropic API status. The system has a circuit breaker on Claude calls — if it opens, scheduling conversations pause until the circuit recovers (opens after 3 failures within 2 minutes; retries after 60s).

```bash
# Check circuit breaker status
curl -H "x-webhook-secret: $WEBHOOK_SECRET" http://localhost:3000/health/circuits
```

### Email Delivery Issues

The system uses Gmail API with Pub/Sub push notifications as the primary mechanism and polling (every 3 minutes) as a fallback. If emails aren't being processed:

1. Check the Gmail circuit breaker status
2. Verify Gmail API credentials are valid
3. Check `GET /api/admin/gmail/status` for Gmail-specific diagnostics
4. Review pending email queue: `GET /api/admin/queue/health`

### Database Performance

```bash
# Connect to PostgreSQL
docker-compose exec postgres psql -U postgres -d therapist_scheduling

# Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;

# Check index usage
SELECT indexrelname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes ORDER BY idx_scan DESC;
```

### Stale Conversations

The `StaleCheckService` automatically flags conversations with 48+ hours of inactivity. If conversations are getting stuck:

1. Check admin dashboard for stale appointments (shown with health indicators)
2. Review conversation state via the appointment detail panel
3. Use "Take Control" to manually intervene in stuck conversations

## Backup Strategy

```bash
# Database backup
docker-compose exec postgres pg_dump -U postgres therapist_scheduling > backup_$(date +%Y%m%d).sql

# Redis backup (triggers background save)
docker-compose exec redis redis-cli BGSAVE

# Restore database
cat backup.sql | docker-compose exec -T postgres psql -U postgres therapist_scheduling
```

### Data Retention

A daily sweep (`stale-check.service.ts` `cleanupOldData`) hard-deletes, in
batches of 100 appointments per category per run:

| Data | Removed after | Notes |
|---|---|---|
| Cancelled appointments | 90 days since last update | admin setting `retention.cancelledDays` |
| Post-booking appointments (confirmed, session_held, feedback_requested, completed) | 365 days since last update | admin setting `retention.completedDays`. Their audit events, side-effect rows and pending emails cascade. Graduation is unaffected: completed clients are recorded in `therapist_completed_clients`, which retention never deletes (the sweep re-asserts the record before deleting a completed row). |
| Processed Gmail message (dedup) records | 45 days | |
| Abandoned pending emails | 30 days since last retry | |
| Abandoned unmatched-email attempts | 7 days | |
| Abandoned message-processing failures | 30 days | |
| Resolved weekly-mailing inquiries | 30 days | |
| Side-effect outbox rows | 30 days after finishing | `completed` and `superseded` rows only; pending, running, failed and abandoned rows are kept |

`therapist_completed_clients` holds only a therapist id and a sha256 of the
client's lowercased email; it is deleted only with the therapist.

## Graceful Shutdown

On SIGTERM/SIGINT the server (`server.ts` `gracefulShutdown`):
1. Ends the long-lived SSE streams (an open dashboard would otherwise hold
   the HTTP server open)
2. Closes the HTTP server — stops accepting connections and waits for
   in-flight requests
3. Stops every background service's timers and waits up to 15s for runs
   already in progress to finish (and release their locks)
4. Drains the email queue, then closes Redis and the database
5. Force-exits with status 1 if the whole sequence takes longer than 30s

```bash
# Graceful stop
docker-compose stop app

# Force stop (skip grace period)
docker-compose kill app
```
