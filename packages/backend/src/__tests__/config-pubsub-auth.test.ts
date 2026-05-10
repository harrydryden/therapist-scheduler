/**
 * Tests the production-mode warning behaviour for the two Pub/Sub
 * misconfig signals:
 *
 *   1. REQUIRE_PUBSUB_AUTH=false — webhook accepts unauthenticated
 *      POSTs (originally H5 / hotfix #195).
 *   2. GOOGLE_PUBSUB_AUDIENCE unset — webhook still verifies the token
 *      but skips the audience claim check, accepting tokens minted for
 *      other audiences. Less catastrophic than (1) but still a silent
 *      degradation worth alerting on.
 *
 * Both warnings share the same `INSECURE CONFIG` banner shape so log
 * monitoring tools can match a single string and page on either.
 *
 * The recurring `setInterval` is module-level guarded so the warning
 * fires exactly once per process lifecycle even if the check runs
 * twice (which can happen in some hot-reload setups).
 *
 * The helpers live in `config/pubsub-warnings.ts` rather than
 * `config/index.ts` so this test can import them without triggering
 * `loadConfig()` (which requires every prod env var to be set).
 */

import {
  checkProductionPubsubAuth,
  checkProductionPubsubAudience,
  _resetPubsubWarningGuardsForTesting as resetGuards,
} from '../config/pubsub-warnings';

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  resetGuards();
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('checkProductionPubsubAuth', () => {
  it('emits a banner and arms the recurring warning when production has REQUIRE_PUBSUB_AUTH=false', () => {
    checkProductionPubsubAuth({ env: 'production', requirePubsubAuth: false });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('INSECURE CONFIG');
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('REQUIRE_PUBSUB_AUTH=false in production');
  });

  it('does NOT emit when production has the safe default (auth required)', () => {
    checkProductionPubsubAuth({ env: 'production', requirePubsubAuth: true });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit in development (local-dev escape hatch)', () => {
    checkProductionPubsubAuth({ env: 'development', requirePubsubAuth: false });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit in test env', () => {
    checkProductionPubsubAuth({ env: 'test', requirePubsubAuth: false });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('warning text contains explicit remediation steps', () => {
    checkProductionPubsubAuth({ env: 'production', requirePubsubAuth: false });
    const warning = consoleErrorSpy.mock.calls[0][0];
    expect(warning).toContain('GOOGLE_PUBSUB_AUDIENCE');
    expect(warning).toContain('OIDC');
  });

  it('only emits once per process lifecycle (idempotent against re-invocation)', () => {
    // Without the module-level guard, anything that re-imports config
    // could leak intervals and re-emit banners. The guard caps it at
    // one banner + one interval per process, ever.
    checkProductionPubsubAuth({ env: 'production', requirePubsubAuth: false });
    checkProductionPubsubAuth({ env: 'production', requirePubsubAuth: false });
    checkProductionPubsubAuth({ env: 'production', requirePubsubAuth: false });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('checkProductionPubsubAudience', () => {
  it('emits a banner when production has no GOOGLE_PUBSUB_AUDIENCE set', () => {
    checkProductionPubsubAudience({ env: 'production', googlePubsubAudience: undefined });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('INSECURE CONFIG');
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('GOOGLE_PUBSUB_AUDIENCE is unset');
  });

  it('emits a banner when production has GOOGLE_PUBSUB_AUDIENCE set to empty string', () => {
    checkProductionPubsubAudience({ env: 'production', googlePubsubAudience: '' });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit when production has GOOGLE_PUBSUB_AUDIENCE set', () => {
    checkProductionPubsubAudience({
      env: 'production',
      googlePubsubAudience: 'https://app.example.com/api/webhooks/gmail/push',
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit in development even with audience unset (local-dev expectation)', () => {
    checkProductionPubsubAudience({ env: 'development', googlePubsubAudience: undefined });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit in test env', () => {
    checkProductionPubsubAudience({ env: 'test', googlePubsubAudience: undefined });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('warning text describes what the missing audience means for security', () => {
    checkProductionPubsubAudience({ env: 'production', googlePubsubAudience: undefined });
    const warning = consoleErrorSpy.mock.calls[0][0];
    expect(warning).toContain('audience claim');
    expect(warning).toContain('webhook URL');
  });

  it('only emits once per process lifecycle (idempotent against re-invocation)', () => {
    checkProductionPubsubAudience({ env: 'production', googlePubsubAudience: undefined });
    checkProductionPubsubAudience({ env: 'production', googlePubsubAudience: undefined });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('the two checks share the same INSECURE CONFIG banner shape', () => {
  // Log monitoring tools alert on the literal "INSECURE CONFIG" string,
  // so both warnings must include it. This pins the contract.
  it('auth warning contains INSECURE CONFIG marker', () => {
    checkProductionPubsubAuth({ env: 'production', requirePubsubAuth: false });
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/INSECURE CONFIG/);
  });

  it('audience warning contains INSECURE CONFIG marker', () => {
    checkProductionPubsubAudience({ env: 'production', googlePubsubAudience: undefined });
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/INSECURE CONFIG/);
  });
});
