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

let changedFiles;
try {
  changedFiles = git(`diff --name-only ${baseRef}...HEAD`).split('\n').filter(Boolean);
} catch (err) {
  // base ref might not exist locally — try fetching
  try {
    git(`fetch origin main --quiet`);
    changedFiles = git(`diff --name-only ${baseRef}...HEAD`).split('\n').filter(Boolean);
  } catch (err2) {
    fail(`could not compute git diff vs ${baseRef}: ${err2.message}`, 2);
  }
}

const schemaChanged = changedFiles.some((f) => f.endsWith('prisma/schema.prisma'));
if (!schemaChanged) {
  console.log('✓ schema-drift-guard: schema.prisma unchanged');
  process.exit(0);
}

const newMigrations = changedFiles.filter(
  (f) => /prisma\/migrations\/[^/]+\/migration\.sql$/.test(f)
);

// Get the actual git status of each migration file (added vs modified)
const addedMigrations = newMigrations.filter((f) => {
  try {
    const status = git(`diff --diff-filter=A --name-only ${baseRef}...HEAD -- ${f}`);
    return status.length > 0;
  } catch {
    return false;
  }
});

if (addedMigrations.length === 0) {
  fail(
    `prisma/schema.prisma was modified without adding a new migration file.\n\n` +
      `   Changed schema, no new migration → production schema drift.\n` +
      `   Add a migration with: npx prisma migrate dev --name <description>\n\n` +
      `   This guard exists because commit 47509cd shipped a schema change\n` +
      `   without a migration, breaking every appointment.findUnique() call\n` +
      `   in production for over a week.`
  );
}

console.log(
  `✓ schema-drift-guard: schema.prisma changed AND ${addedMigrations.length} new migration(s) added:`
);
for (const m of addedMigrations) console.log(`   - ${m}`);
