/**
 * Backend Jest configuration.
 *
 * Uses @swc/jest for TypeScript transpilation — significantly faster than
 * ts-jest because SWC skips full type checking and uses a Rust-based
 * transformer. Type safety is still enforced by `npm run typecheck`, which
 * runs as part of the build step, so we don't lose anything by skipping
 * type-check during test runs.
 *
 * If you need to debug a failing test interactively, run a single file:
 *   npx jest src/__tests__/foo.test.ts
 */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  transform: {
    '^.+\\.(t|j)s$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: false },
          target: 'es2020',
          // Match the Node 20 runtime — no need to down-level further for tests.
          loose: false,
        },
        sourceMaps: 'inline',
        module: { type: 'commonjs' },
      },
    ],
  },

  // Reasonable default for CI / local — leave one core free for the OS.
  // Override with `--maxWorkers=N` for tighter resource use when running
  // alongside other heavy processes.
  maxWorkers: '50%',

  collectCoverageFrom: [
    'src/utils/**/*.ts',
    'src/services/**/*.ts',
    '!src/**/*.d.ts',
    '!src/utils/logger.ts',
    '!src/utils/database.ts',
  ],
  coverageReporters: ['text', 'text-summary', 'lcov'],
};
