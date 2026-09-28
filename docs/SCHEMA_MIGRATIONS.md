# Schema Migration Workflow

This doc explains how to add a Prisma schema change without breaking
production. The booking_method incident in March 2026 was caused by
shipping a schema change without a corresponding migration, so following
this workflow is **mandatory** for any change that touches `schema.prisma`.

## TL;DR

1. Edit `packages/backend/prisma/schema.prisma`
2. Write the migration by hand in
   `prisma/migrations/<YYYYMMDD>_<description>/migration.sql` —
   idempotent SQL (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
   `DO $$ … IF NOT EXISTS … $$` for constraints). `prisma migrate dev`
   does **not** work here (see "Why migrations can't be replayed from
   empty"); `prisma migrate diff` can draft the SQL for you:
   `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`
   against a bootstrapped dev database.
3. Apply it to your dev database: `npx prisma migrate deploy`
4. Run integration tests: `npm run test:integration` (requires `TEST_DATABASE_URL`)
5. Run the schema drift guard: `npm run check:schema-migration`
6. Commit BOTH `schema.prisma` AND the new migration directory in the same commit

## How each kind of database gets its schema

| Database | How it is created / migrated |
|---|---|
| **Production** | Already baselined — every migration is recorded in `_prisma_migrations`. Every container start runs plain `prisma migrate deploy` (`scripts/docker-entrypoint.sh`); if it fails for any reason the container exits and the previous release keeps serving. There is no fallback. |
| **Fresh dev / staging / CI** | `npm -w therapist-scheduler-backend run db:bootstrap-dev` (`scripts/bootstrap-dev-db.sh`), once. Then `prisma migrate deploy` as usual. |
| **Integration tests** | The test helper resets `TEST_DATABASE_URL` with `prisma db push --force-reset` at the start of the run. |

### `scripts/bootstrap-dev-db.sh`

For a brand-new, empty database:

1. `prisma db push` builds the schema from `schema.prisma`;
2. every folder in `prisma/migrations/` is recorded as applied
   (`prisma migrate resolve --applied`), so later `prisma migrate deploy`
   runs only apply migrations added afterwards;
3. the handful of objects Prisma's schema language cannot express — the
   partial unique indexes `appointment_requests_user_therapist_active_unique`,
   `idx_unique_booking_slot`, `feedback_submissions_appointment_request_id_key`
   and the `side_effect_logs_scope_check` CHECK — are created idempotently,
   so the database enforces the same booking-race protections as production.
   (If a migration changes one of these, update the script too.)

It is re-runnable (already-recorded migrations are skipped) and it
**refuses to run when `DATABASE_URL` contains `railway` or `prod`**: step 2
tells Prisma that migrations ran when they did not, which must never happen
to production.

```bash
cd packages/backend
DATABASE_URL="postgresql://postgres@localhost:5432/therapist_dev" npm run db:bootstrap-dev
```

### What happened to `baseline.sh`

`prisma/baseline.sh` used to wrap `migrate deploy` with a "recovery" that,
on **any** failure (including a transient connection error or its own
120-second timeout), marked failed migrations as rolled back and every
migration up to a cutoff date as applied — without running them. A fresh
database and a `db push` database both crash-looped through it, and it once
silently skipped a real migration in production. It was removed in
September 2026: production is baselined, so it only ever needs
`migrate deploy`, and new databases use the bootstrap script above.

## What can go wrong if you skip this

The Prisma client is generated from `schema.prisma` at build time. If you
add a column to the schema but don't add a migration:

- The Prisma client expects the column to exist
- The production database doesn't have it
- Every query that selects all columns (including no-`select` `findUnique`
  calls) fails at runtime with `column "X" does not exist`
- The error is wrapped by the calling code's try/catch and may be invisible
  in logs depending on what swallows it

This is exactly what happened in the booking_method incident. The schema
change shipped, the migration didn't, and **every** appointment-related
query failed in production for over a week. The only reason we caught it
was because messages weren't being processed and a user complained.

## CI guards

`.github/workflows/ci.yml` runs on every push and pull request. The schema
checks in it:

### 1. `prisma validate`

Fails on a schema that doesn't parse or is internally inconsistent.

### 2. Schema drift guard (`scripts/check-schema-migration.js`)

Diffs the branch against its base (the PR base in CI, `origin/main`
locally). Fails if `schema.prisma` was modified without a new migration
file in the same diff. It is read-only — it never fetches; make sure the
base ref exists locally (`git fetch origin main`) or pass it:

```bash
cd packages/backend && npm run check:schema-migration
BASE_REF=origin/my-base node scripts/check-schema-migration.js
```

This is fast (no DB needed). It only checks that a migration was added,
not what it contains — review the SQL.

### 3. Integration tests (`src/__tests__/integration/`)

The CI integration job starts a `postgres:16` service, bootstraps it with
`scripts/bootstrap-dev-db.sh` (which also proves the bootstrap works on an
empty database), and runs `npm -w therapist-scheduler-backend run
test:integration`. The tests reset the database with `prisma db push` and
issue `findUnique`/`findMany` with no-select clauses against every model,
catching Prisma-client↔schema drift even when a migration exists but
doesn't fully cover the schema.

```bash
cd packages/backend
TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/test_db" \
DATABASE_URL="$TEST_DATABASE_URL" \
  npm run test:integration
```

Both variables must point at the same, expendable database: the helper
connects with `TEST_DATABASE_URL`, the services under test use the app's
Prisma client (`DATABASE_URL`). The run wipes it (`--force-reset`).

## Why migrations can't be replayed from empty

The `prisma/migrations/` directory has a historical baselining issue:
the earliest migration assumes tables already exist (because the schema
was originally created via `prisma db push` before migration tracking
was added), and `20260218_status_enum_migration` can never apply in
sequence. So `prisma migrate dev` (which replays the history into a shadow
database) and `prisma migrate reset` don't work, and nothing replays the
history from empty — new databases are bootstrapped instead (above).

A replayable `0_init` baseline (`prisma migrate diff --from-empty
--to-schema-datamodel`) resolved once in production would fix this for
good; it has not been done yet.

## Example: adding a column

```bash
# 1. Edit the model in schema.prisma
vim packages/backend/prisma/schema.prisma

# 2. Write the migration (idempotent)
mkdir -p prisma/migrations/20261001_add_my_field
cat > prisma/migrations/20261001_add_my_field/migration.sql <<'SQL'
ALTER TABLE "foo" ADD COLUMN IF NOT EXISTS "my_field" TEXT;
SQL

# 3. Apply it to your (bootstrapped) dev database
cd packages/backend
npx prisma migrate deploy

# 4. Run the integration tests against a clean test DB
TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/test" \
DATABASE_URL="postgresql://user:pass@localhost:5432/test" npm run test:integration

# 5. Verify the schema drift guard passes
npm run check:schema-migration

# 6. Commit BOTH files together
git add prisma/schema.prisma prisma/migrations/
git commit -m "Add my_field to FooModel"
```

## Hotfix: missing migration in production

If a migration is missing in production (the column exists in the schema
but not in the DB), the fix is:

1. Create the migration locally by hand (see TL;DR step 2)
2. Use `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` so
   the migration is idempotent in case anyone hotfixed prod manually
3. Deploy. The entrypoint's `prisma migrate deploy` applies it; if it
   fails, the new container exits and the old release keeps running —
   read the deploy log, fix the SQL, redeploy
4. Verify with `prisma migrate status` against production
