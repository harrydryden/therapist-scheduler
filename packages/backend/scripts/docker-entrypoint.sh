#!/bin/sh
# Docker entrypoint: apply pending Prisma migrations, then start the server.
#
# Fail fast. If `prisma migrate deploy` fails for ANY reason — a broken
# migration, a lock timeout, the database being unreachable — the container
# exits non-zero and the platform keeps the previous release running. There
# is deliberately no fallback: the old baseline.sh "recovery" marked
# unapplied migrations as applied (and failed ones as rolled back) on any
# failure, including a transient connection error, which is how migrations
# silently went missing in production.
#
# Production is already baselined (every migration is recorded in
# _prisma_migrations). A brand-new dev / staging / CI database is created
# with scripts/bootstrap-dev-db.sh, never by this entrypoint — see
# docs/SCHEMA_MIGRATIONS.md.
set -eu

cd /app/packages/backend

echo "Applying database migrations (prisma migrate deploy)..."
npx --no-install prisma migrate deploy

echo "Migrations applied. Starting server..."
exec node /app/packages/backend/dist/server.js
