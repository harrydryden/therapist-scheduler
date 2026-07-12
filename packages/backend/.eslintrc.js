/**
 * Kernel-boundary lint rule (Stage D1 of the agent-harness/lifecycle
 * refactor plan — docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md).
 *
 * core/README.md has always said the boundary is "enforced by code
 * review, not yet by lint rules" — this is that follow-up. Enforces
 * core/README.md's rule 1: core/** must not import domain/** or a
 * scheduling-specific services/*.service module.
 *
 * Deliberately minimal otherwise: no `extends` / recommended rulesets.
 * Turning those on would surface a large number of pre-existing,
 * unrelated findings across ~14k lines with no bearing on the kernel
 * boundary this file exists to enforce — out of scope for this PR.
 *
 * Allowlist-first: the second `overrides` entry below names every file
 * that still violates the rule and turns it off for exactly those files.
 * New files under core/ — and new imports added to files NOT in that
 * list — are caught immediately. Started at ~46 edges across 21 files
 * when this rule landed (Stage D1); Stage D2 moved core/agent/tools/'s
 * policy half to domain/scheduling/agent/ and removed its 15 entries.
 * Stage D3 does the same for core/email/inbound/. Entries here should
 * shrink, not grow.
 */

const KERNEL_BOUNDARY_MESSAGE =
  'core/** must not import domain/** or a scheduling-specific service — see core/README.md. ' +
  'If this file genuinely needs scheduling concepts, it belongs in domain/scheduling/, not core/.';

// Services whose types/signatures are scheduling-specific per
// core/README.md rule 2 (appointmentId-typed APIs, ConversationStage,
// etc). This is a judgment call, not an exhaustive per-file audit —
// generic infra that happens to live in services/ (settings, email
// OAuth/bounce/thread-fetching, tracking-code's string helpers) is
// deliberately NOT listed here; those are legitimately usable from
// core/. email-processing.service.ts is also deliberately excluded: its
// disposition (dissolve the backward-compat shim) is Stage D3's job, not
// this rule's.
const SCHEDULING_SERVICE_GLOBS = [
  '**/services/scheduling-context.service.*',
  '**/services/conversation-checkpoint.service.*',
  '**/services/agent-memory.service.*',
  '**/services/appointment-tool-counter.*',
  '**/services/audit-event.service.*',
  '**/services/appointment-event.service.*',
  '**/services/thread-divergence.service.*',
  '**/services/invitation-reply.service.*',
  '**/services/slack-notification.service.*',
  '**/services/email-classifier.service.*',
  '**/services/email-queue.service.*',
];

// Today's known violating files (see docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md
// findings #4 and #5). One entry per file, not per edge — the rule can't
// be scoped finer than "this whole file is grandfathered in" without
// per-line suppression comments, which would be noisier than the file
// list itself.
const ALLOWLISTED_VIOLATORS = [
  // core/agent/tools/* moved to domain/scheduling/agent/ in Stage D2 —
  // no longer under core/, so no longer needs (or gets) an entry here.
  'src/core/email/inbound/availability-routing.ts',
  'src/core/email/inbound/closure-auto-dismiss.ts',
  'src/core/email/inbound/divergence-handling.ts',
  'src/core/email/inbound/nudge-reply.ts',
  'src/core/email/inbound/process.ts',
  'src/core/timezone/prompt-section.ts',
];

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 2020,
  },
  // '@typescript-eslint' isn't enabled here (no rules from it are turned
  // on), but several files carry pre-existing
  // `// eslint-disable-next-line @typescript-eslint/...` comments written
  // in anticipation of an eventual typed-lint config. Without registering
  // the plugin, ESLint errors that those rules don't exist. Registering
  // it here just makes the disable comments resolve; it doesn't turn on
  // any of its rules.
  plugins: ['import', '@typescript-eslint'],
  settings: {
    // Default node resolver only looks for .js/.json/.node by default —
    // without this, relative imports of sibling .ts files fail to
    // resolve and the rule silently never matches anything.
    'import/resolver': {
      node: {
        extensions: ['.js', '.ts'],
      },
    },
  },
  rules: {},
  overrides: [
    {
      files: ['src/core/**/*.ts'],
      rules: {
        'import/no-restricted-paths': [
          'error',
          {
            zones: [
              {
                target: './src/core',
                from: './src/domain',
                message: KERNEL_BOUNDARY_MESSAGE,
              },
              {
                target: './src/core',
                from: SCHEDULING_SERVICE_GLOBS,
                message: KERNEL_BOUNDARY_MESSAGE,
              },
            ],
          },
        ],
      },
    },
    {
      files: ALLOWLISTED_VIOLATORS,
      rules: {
        'import/no-restricted-paths': 'off',
      },
    },
  ],
};
