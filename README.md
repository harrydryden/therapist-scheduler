# Therapist Scheduler

AI-powered scheduling platform that coordinates therapy appointments between clients and therapists via email, with an admin dashboard for oversight.

## Architecture

Monorepo with three packages:

- **`packages/frontend`** — React + Vite + TailwindCSS admin dashboard and public booking UI
- **`packages/backend`** — Fastify + TypeScript API server with Prisma, Redis, Gmail, Claude AI, Notion, and Slack integrations
- **`packages/shared`** — Shared types, constants, and config (API contract types, therapist categories)

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
npm run build:all       # Build shared → backend → frontend
npm run dev:frontend    # Start frontend dev server
npm run dev:backend     # Start backend dev server
npm run test:all        # Run backend tests
npm run typecheck:all   # Type-check all packages
npm run lint:all        # Lint all packages
```

## Production Deployment

```bash
docker-compose up -d
```

See `docs/PRODUCTION_DEPLOYMENT.md` for full deployment guide.

## Documentation

- `docs/ARCHITECTURE_RECOMMENDATIONS.md` — Architecture decisions and recommendations
- `docs/PRODUCTION_DEPLOYMENT.md` — Production deployment guide
- `docs/MONOREPO_MIGRATION.md` — Migration details from the two-repo setup
