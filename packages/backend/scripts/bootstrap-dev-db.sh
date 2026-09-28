#!/bin/sh
# Bootstrap a FRESH development / staging / CI database.
#
# The migration history cannot be replayed from an empty database: the
# earliest migrations assume tables that were originally created by
# `prisma db push`, before migration tracking existed. So a new database is
# built the other way round:
#
#   1. `prisma db push` creates the schema from schema.prisma;
#   2. every migration folder is recorded as applied
#      (`prisma migrate resolve --applied`), so later `prisma migrate deploy`
#      runs apply only migrations added after this bootstrap;
#   3. the few objects Prisma's schema language cannot express (partial
#      unique indexes, a CHECK constraint) — which the migrations create in
#      production — are created idempotently, so the database enforces the
#      same booking-race protections as production.
#
# NEVER run this against production: step 2 tells Prisma that migrations
# ran when they did not. Production is already baselined and is only ever
# migrated by `prisma migrate deploy` (scripts/docker-entrypoint.sh). The
# script refuses to run when DATABASE_URL looks like production.
#
# Usage (from packages/backend):
#   DATABASE_URL=postgresql://... sh scripts/bootstrap-dev-db.sh
#   npm run db:bootstrap-dev
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "bootstrap-dev-db: DATABASE_URL is not set" >&2
  exit 1
fi

url_lower=$(printf '%s' "$DATABASE_URL" | tr '[:upper:]' '[:lower:]')
case "$url_lower" in
  *railway*|*prod*)
    echo "bootstrap-dev-db: refusing to run — DATABASE_URL looks like production (contains 'railway' or 'prod')." >&2
    echo "  This script marks every migration as applied without running it. Production is migrated only by 'prisma migrate deploy'." >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")/.."

echo "bootstrap-dev-db: creating the schema from prisma/schema.prisma (prisma db push)..."
npx --no-install prisma db push --skip-generate

echo "bootstrap-dev-db: recording every migration as applied..."
for dir in prisma/migrations/*/; do
  name=$(basename "$dir")
  if out=$(npx --no-install prisma migrate resolve --applied "$name" 2>&1); then
    echo "  applied: $name"
  else
    case "$out" in
      *P3008*) echo "  already recorded: $name" ;;
      *) printf '%s\n' "$out" >&2; exit 1 ;;
    esac
  fi
done

echo "bootstrap-dev-db: creating migration-only constraints..."
# Keep in step with the migrations that own these objects:
#   20260206_add_unique_user_therapist_constraint, 20260215_add_unique_booking_slot_constraint,
#   20260219_add_unique_constraints, 20260516_therapist_scoped_side_effects
# (column names as they are today — therapist_notion_id was renamed to
# therapist_handle by 20260508).
npx --no-install prisma db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_requests_user_therapist_active_unique"
  ON "appointment_requests" ("user_email", "therapist_handle")
  WHERE "status" IN ('pending', 'contacted', 'negotiating');
CREATE UNIQUE INDEX IF NOT EXISTS "idx_unique_booking_slot"
  ON "appointment_requests" ("therapist_handle", "confirmed_date_time")
  WHERE "status" NOT IN ('cancelled', 'rejected', 'completed') AND "confirmed_date_time" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_submissions_appointment_request_id_key"
  ON "feedback_submissions" ("appointment_request_id")
  WHERE "appointment_request_id" IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'side_effect_logs_scope_check') THEN
    ALTER TABLE "side_effect_logs" ADD CONSTRAINT "side_effect_logs_scope_check" CHECK (
      ("appointment_id" IS NOT NULL AND "therapist_id" IS NULL)
      OR ("appointment_id" IS NULL AND "therapist_id" IS NOT NULL)
    );
  END IF;
END $$;
SQL

npx --no-install prisma migrate status
echo "bootstrap-dev-db: done."
