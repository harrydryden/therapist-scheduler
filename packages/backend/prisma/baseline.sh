#!/bin/sh
# Baseline script: marks all existing migrations as applied if the
# _prisma_migrations table doesn't exist yet (Prisma P3005 fix).
# This is idempotent — safe to run on every deploy.

set -e

# Quick check: try migrate deploy first. If it works, no baseline needed.
if npx prisma migrate deploy 2>/dev/null; then
  echo "Migrations applied successfully."
  exit 0
fi

echo "prisma migrate deploy failed — attempting baseline..."

# Resolve each migration as already applied
for dir in prisma/migrations/*/; do
  migration=$(basename "$dir")
  # Skip the migration_lock.toml directory marker
  if [ "$migration" = "migration_lock.toml" ]; then
    continue
  fi
  echo "Resolving: $migration"
  npx prisma migrate resolve --applied "$migration"
done

echo "Baseline complete. Running migrate deploy..."
npx prisma migrate deploy
