# Schema Migration Workflow

This doc explains how to add a Prisma schema change without breaking
production. The booking_method incident in March 2026 was caused by
shipping a schema change without a corresponding migration, so following
this workflow is **mandatory** for any change that touches `schema.prisma`.

## TL;DR

1. Edit `packages/backend/prisma/schema.prisma`
2. Generate a migration: `cd packages/backend && npx prisma migrate dev --name describe_your_change`
3. Verify the migration SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`
4. Run integration tests: `npm run test:integration` (requires `TEST_DATABASE_URL`)
5. Run the schema drift guard: `npm run check:schema-migration`
6. Commit BOTH `schema.prisma` AND the new migration directory in the same commit

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

Two checks run in CI to catch this class of bug:

### 1. Schema drift guard (`scripts/check-schema-migration.js`)

Diffs the current branch against `origin/main`. Fails if `schema.prisma`
was modified without a new migration file in the same diff.

```bash
cd packages/backend && npm run check:schema-migration
```

This is fast (no DB needed) and should run on every PR.

### 2. Integration test (`src/__tests__/integration/`)

Spins up a real Postgres test database, applies `schema.prisma` via
`prisma db push`, and issues `findUnique`/`findMany` with no-select
clauses against every model. Catches Prisma-client↔schema drift even if
both `schema.prisma` and the migration are technically present but the
migration doesn't fully cover the schema.

```bash
TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/test_db" \
  cd packages/backend && npm run test:integration
```

In CI, the test database can be a service container or Postgres on
localhost — the test resets it via `--force-reset` so any expendable
DB works.

## Why migrations can't be replayed from empty

The `prisma/migrations/` directory has a historical baselining issue:
the earliest migration assumes tables already exist (because the schema
was originally created via `prisma db push` before migration tracking
was added). Production handles this via `prisma/baseline.sh` which marks
old migrations as already applied on first deploy.

For tests, we sidestep the issue entirely by using `prisma db push` (which
treats `schema.prisma` as the source of truth and doesn't replay history).
This is sufficient to catch the Prisma-client↔schema drift class of bug.

If you want to run migrations from empty for some reason (e.g., to verify
a new migration is syntactically valid), you'll hit this baselining issue
and need to seed the `_prisma_migrations` table manually.

## Example: adding a column

```bash
# 1. Edit the model in schema.prisma
vim packages/backend/prisma/schema.prisma

# 2. Generate the migration (this also applies it to your local dev DB)
cd packages/backend
npx prisma migrate dev --name add_my_field

# 3. Inspect the generated SQL
cat prisma/migrations/*_add_my_field/migration.sql

# 4. Run the integration test against a clean test DB
TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/test" npm run test:integration

# 5. Verify the schema drift guard passes
npm run check:schema-migration

# 6. Commit BOTH files together
git add prisma/schema.prisma prisma/migrations/
git commit -m "Add my_field to FooModel"
```

## Hotfix: missing migration in production

If a migration is missing in production (the column exists in the schema
but not in the DB), the fix is:

1. Create the migration locally (do NOT include `prisma migrate dev`'s
   shadow database — write the SQL by hand)
2. Use `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` so
   the migration is idempotent in case anyone hotfixed prod manually
3. Deploy. `prisma migrate deploy` will apply the new migration
4. Verify with `prisma migrate status` against production
