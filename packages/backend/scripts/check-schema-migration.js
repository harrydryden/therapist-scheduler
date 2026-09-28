#!/usr/bin/env node
/**
 * Schema drift guard.
 *
 * Fails if `schema.prisma` has been modified in the current branch (vs origin/main)
 * without a corresponding new migration file under `prisma/migrations/`.
 *
 * Designed to run in CI on every PR to catch the exact class of bug we hit
 * when commit 47509cd added `bookingMethod` to the schema without a migration.
 *
 * Usage:
 *   node scripts/check-schema-migration.js              # diff vs origin/main
 *   node scripts/check-schema-migration.js HEAD~3       # diff vs a custom ref
 *   BASE_REF=origin/<pr-base> node scripts/check-schema-migration.js   # CI
 *
 * Exit codes:
 *   0 - schema unchanged, OR schema changed AND a new migration was added
 *   1 - schema changed, no new migration (drift risk)
 *   2 - tooling error (git unavailable, etc.)
 */
const { execSync } = require('child_process');

const baseRef = process.argv[2] || process.env.BASE_REF || 'origin/main';

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
}

function fail(msg, code = 1) {
  console.error(`\n❌ schema-drift-guard: ${msg}\n`);
  process.exit(code);
}

// Read-only: the guard never fetches (a fetch mutates refs, and in CI the
// checkout step owns that). If the base ref is missing, fetch it first —
// e.g. `git fetch origin main` locally, or `fetch-depth: 0` in CI.
let changedFiles;
try {
  changedFiles = git(`diff --name-only ${baseRef}...HEAD`).split('\n').filter(Boolean);
} catch (err) {
  fail(
    `could not compute git diff vs ${baseRef}: ${err.message}\n` +
      `   Make sure the base ref exists locally (git fetch origin <branch>) or pass it: ` +
      `node scripts/check-schema-migration.js <ref> / BASE_REF=<ref>.`,
    2,
  );
}

const schemaChanged = changedFiles.some((f) => f.endsWith('prisma/schema.prisma'));
if (!schemaChanged) {
  console.log('✓ schema-drift-guard: schema.prisma unchanged');
  process.exit(0);
}

const newMigrations = changedFiles.filter(
  (f) => /prisma\/migrations\/[^/]+\/migration\.sql$/.test(f)
);

// Get the set of files ADDED (status A) in this diff, then intersect with the
// candidate migration files. Computed with a single pathspec-free git call so
// it works regardless of the current working directory — `git diff -- <path>`
// treats <path> as relative to CWD, but `changedFiles` paths are repo-root
// relative, so a per-file pathspec silently matched nothing when the guard was
// run from packages/backend (via `npm run check:schema-migration`).
let addedSet = new Set();
try {
  addedSet = new Set(
    git(`diff --diff-filter=A --name-only ${baseRef}...HEAD`).split('\n').filter(Boolean)
  );
} catch {
  // Leave addedSet empty — treated as "no new migration" below.
}
const addedMigrations = newMigrations.filter((f) => addedSet.has(f));

if (addedMigrations.length === 0) {
  fail(
    `prisma/schema.prisma was modified without adding a new migration file.\n\n` +
      `   Changed schema, no new migration → production schema drift.\n` +
      `   Add a migration (hand-written, idempotent SQL — see docs/SCHEMA_MIGRATIONS.md)\n` +
      `   under prisma/migrations/<timestamp>_<description>/migration.sql.\n\n` +
      `   This guard exists because commit 47509cd shipped a schema change\n` +
      `   without a migration, breaking every appointment.findUnique() call\n` +
      `   in production for over a week.`
  );
}

console.log(
  `✓ schema-drift-guard: schema.prisma changed AND ${addedMigrations.length} new migration(s) added:`
);
for (const m of addedMigrations) console.log(`   - ${m}`);
