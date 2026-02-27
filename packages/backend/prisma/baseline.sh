#!/bin/sh
# Baseline script: marks all existing migrations as applied if the
# _prisma_migrations table doesn't exist yet (Prisma P3005 fix).
# This is idempotent — safe to run on every deploy.

set -e

MIGRATE_TIMEOUT=120  # seconds

# Try migrate deploy first. If it works, no baseline needed.
echo "Running prisma migrate deploy..."
if timeout ${MIGRATE_TIMEOUT} npx prisma migrate deploy 2>&1; then
  echo "Migrations applied successfully."
  exit 0
fi

echo "prisma migrate deploy failed — attempting baseline..."

# Only resolve migrations that predate this baseline fix.
# New migrations added AFTER the baseline should be applied normally
# by the final migrate deploy, not marked as already applied.
BASELINE_CUTOFF="20260227"

for dir in prisma/migrations/*/; do
  migration=$(basename "$dir")
  # Skip non-migration entries
  case "$migration" in migration_lock.toml) continue;; esac

  # Only baseline migrations that existed before the cutoff
  migration_date=$(echo "$migration" | cut -c1-8)
  if [ "$migration_date" -le "$BASELINE_CUTOFF" ] 2>/dev/null; then
    echo "Resolving: $migration"
    npx prisma migrate resolve --applied "$migration" || true
  else
    echo "Skipping (will be applied normally): $migration"
  fi
done

echo "Baseline complete. Running migrate deploy..."
timeout ${MIGRATE_TIMEOUT} npx prisma migrate deploy
