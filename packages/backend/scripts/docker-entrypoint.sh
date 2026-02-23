#!/bin/sh
# Docker entrypoint: runs Prisma migrations before starting the server.
# This ensures schema changes from merged branches are applied on restart.
set -e

echo "Running database migrations..."

cd /app/packages/backend

# baseline.sh handles both fresh deployments (baseline) and incremental migrations.
# It is idempotent — safe to run on every container start.
sh prisma/baseline.sh

echo "Migrations complete. Starting server..."
exec node /app/packages/backend/dist/server.js
