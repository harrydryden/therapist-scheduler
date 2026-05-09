/**
 * Tests the production-mode safety lock on REQUIRE_PUBSUB_AUTH.
 *
 * The flag's default is true, but it can be turned off via the env var.
 * Setting it to false in production is the worst case — the
 * unauthenticated Gmail push webhook becomes wide open. The schema
 * superRefine refuses to validate this combination so the misconfig
 * fails at boot rather than silently shipping.
 */

import { z } from 'zod';

// Re-define the relevant slice of the config schema so this test can
// drive it directly without depending on env vars or process.exit
// behaviour from the real loadConfig().
function buildSchema() {
  return z
    .object({
      env: z.enum(['development', 'production', 'test']),
      requirePubsubAuth: z.boolean(),
    })
    .superRefine((cfg, ctx) => {
      if (cfg.env === 'production' && cfg.requirePubsubAuth === false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requirePubsubAuth'],
          message:
            'REQUIRE_PUBSUB_AUTH=false is not permitted in production. ' +
            'Configure GOOGLE_PUBSUB_AUDIENCE and remove the override, ' +
            'or set NODE_ENV to development/test if this really is local.',
        });
      }
    });
}

describe('config: REQUIRE_PUBSUB_AUTH production safety', () => {
  const schema = buildSchema();

  it('refuses production with requirePubsubAuth=false', () => {
    const result = schema.safeParse({ env: 'production', requirePubsubAuth: false });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/not permitted in production/);
    }
  });

  it('accepts production with requirePubsubAuth=true', () => {
    const result = schema.safeParse({ env: 'production', requirePubsubAuth: true });
    expect(result.success).toBe(true);
  });

  it('allows development with requirePubsubAuth=false (local-dev escape hatch)', () => {
    const result = schema.safeParse({ env: 'development', requirePubsubAuth: false });
    expect(result.success).toBe(true);
  });

  it('allows test env with requirePubsubAuth=false', () => {
    const result = schema.safeParse({ env: 'test', requirePubsubAuth: false });
    expect(result.success).toBe(true);
  });
});
