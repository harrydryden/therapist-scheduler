# Production Deployment Guide

## Deployment Scale

This guide covers production deployment for the Therapist Scheduler platform. The current architecture supports:
- 2-3 concurrent appointment negotiations
- 10+ background services running on a single instance
- 10-50 admin dashboard users
- Hundreds of appointments per month

## Pre-Deployment Checklist

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

# Notion (therapist database)
NOTION_API_KEY=secret_your-notion-integration-token
NOTION_DATABASE_ID=your-notion-database-id

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

# Distributed Locking
SINGLE_INSTANCE_MODE=true      # Set false for multi-instance deployments

# CORS
CORS_ORIGIN=https://your-domain.com
CORS_CREDENTIALS=true

# Logging
LOG_LEVEL=info
```

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

The production `docker-compose.yml` runs three services:

| Service | Image | Resources |
|---------|-------|-----------|
| **app** | Built from Dockerfile (multi-stage) | 1 CPU, 1GB RAM |
| **postgres** | postgres:15-alpine | 0.5 CPU, 512MB RAM |
| **redis** | redis:7-alpine | 0.25 CPU, 256MB RAM |

The Dockerfile uses a multi-stage build:
1. Stage 1: Build shared package + backend
2. Stage 2: Build frontend (Vite)
3. Stage 3: Minimal runtime combining both

### Database Migrations

After the first deployment, run Prisma migrations:

```bash
# Apply pending migrations
docker-compose exec app npx prisma migrate deploy --schema=packages/backend/prisma/schema.prisma

# Or push schema directly (development/initial setup)
docker-compose exec app npx prisma db push --schema=packages/backend/prisma/schema.prisma
```

## Health Checks and Monitoring

### Health Endpoints

| Endpoint | Auth Required | Purpose |
|----------|---------------|---------|
| `GET /health` | No | Liveness probe — returns `{ status: "ok" }` if process is running |
| `GET /health/ready` | No | Readiness probe — checks PostgreSQL and Redis connectivity |
| `GET /health/circuits` | Yes (Admin) | Circuit breaker states for Gmail, Slack, Notion, Claude APIs |
| `GET /health/tasks` | Yes (Admin) | Background task success rates, recent errors, timeout stats |
| `GET /health/full` | Yes (Admin) | Comprehensive diagnostic combining all checks above |

### Monitoring Commands

```bash
# Basic liveness check
curl http://localhost:3000/health

# Readiness check (database + Redis)
curl http://localhost:3000/health/ready

# Full diagnostic (requires admin auth header)
curl -H "Authorization: Bearer <jwt-token>" http://localhost:3000/health/full
```

### What to Monitor

| Metric | Healthy | Warning | Action |
|--------|---------|---------|--------|
| Database latency | < 50ms | > 200ms | Check connection pool, query optimization |
| Redis connectivity | Connected | Disconnected | Services degrade to PostgreSQL fallback |
| Circuit breakers | All CLOSED | Any OPEN | Check external API status (Gmail/Slack/Notion/Claude) |
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

At large scale, consider separating API and worker services (see `ARCHITECTURE_RECOMMENDATIONS.md`).

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

Check Anthropic API status. The system has a circuit breaker on Claude calls — if it opens, scheduling conversations pause until the circuit recovers (30s timeout, 5 failure threshold).

```bash
# Check circuit breaker status
curl -H "Authorization: Bearer <jwt>" http://localhost:3000/health/circuits
```

### Email Delivery Issues

The system uses Gmail API with Pub/Sub push notifications as the primary mechanism and polling (every 3 minutes) as a fallback. If emails aren't being processed:

1. Check the Gmail circuit breaker status
2. Verify Gmail API credentials are valid
3. Check `GET /api/webhooks/gmail/health` for Gmail-specific diagnostics
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

The system automatically cleans up old data:
- Cancelled appointments: removed after 90 days
- Completed appointments: removed after 365 days
- Processed Gmail message records: removed after 7 days
- Completed weekly mailing inquiries: removed after 30 days

## Graceful Shutdown

The server implements a 30-second graceful shutdown period:
1. Stops accepting new connections
2. Waits for in-flight requests to complete
3. Stops all background services in order
4. Closes database and Redis connections
5. Force-exits after 30s if anything hangs

```bash
# Graceful stop
docker-compose stop app

# Force stop (skip grace period)
docker-compose kill app
```
