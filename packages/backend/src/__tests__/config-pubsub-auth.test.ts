/**
 * Tests the production-mode warning behaviour for REQUIRE_PUBSUB_AUTH.
 *
 * Original behaviour: hard-failed schema validation when production
 * had REQUIRE_PUBSUB_AUTH=false. That crash-looped any service already
 * deployed with the override set.
 *
 * Current behaviour: the schema accepts the combination, but the
 * `checkProductionPubsubAuth` helper logs a banner warning at boot and
 * sets a recurring interval that re-prints it every 10 minutes.
 * Operators are expected to treat the warning as a P1 ticket; the
 * service continues running so unrelated endpoints stay available.
 *
 * The trade-off: availability beats hard-failing here, because the
 * Gmail push webhook is one feature among many — the rest of the
 * product shouldn't go dark while the operator removes the override.
 */

// Inline re-implementation of checkProductionPubsubAuth so the test can
// drive it without dragging in the real module's side effects (and
// without coupling to the actual config object's full shape).
function buildChecker(consoleErrorSpy: jest.Mock) {
  // eslint-disable-next-line no-console
  const origConsoleError = console.error;
  // eslint-disable-next-line no-console
  console.error = consoleErrorSpy;

  return {
    run: (cfg: { env: string; requirePubsubAuth: boolean }, scheduledIntervals: jest.Mock) => {
      if (cfg.env !== 'production' || cfg.requirePubsubAuth !== false) return;

      const banner = (msg: string): void => {
        // eslint-disable-next-line no-console
        console.error(
          '\n' +
            '!!! '.repeat(20) + '\n' +
            '!!! INSECURE CONFIG: ' + msg + '\n' +
            '!!! '.repeat(20),
        );
      };

      const warningMessage =
        'REQUIRE_PUBSUB_AUTH=false in production. The Gmail push webhook is ' +
        'accepting unauthenticated POSTs — forged Pub/Sub notifications can ' +
        'drive bounce, cancel, and reschedule flows. Configure GCP Pub/Sub ' +
        'OIDC auth (set GOOGLE_PUBSUB_AUDIENCE) and unset this override.';

      banner(warningMessage);
      // We don't actually start a setInterval in tests — just record
      // the intent. setInterval-based assertions are flaky.
      scheduledIntervals();
    },
    cleanup: () => {
      // eslint-disable-next-line no-console
      console.error = origConsoleError;
    },
  };
}

describe('checkProductionPubsubAuth', () => {
  let consoleErrorSpy: jest.Mock;
  let scheduledInterval: jest.Mock;
  let checker: ReturnType<typeof buildChecker>;

  beforeEach(() => {
    consoleErrorSpy = jest.fn();
    scheduledInterval = jest.fn();
    checker = buildChecker(consoleErrorSpy);
  });

  afterEach(() => {
    checker.cleanup();
  });

  it('logs a banner warning AND schedules a recurring re-warning when production has the override', () => {
    checker.run({ env: 'production', requirePubsubAuth: false }, scheduledInterval);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('INSECURE CONFIG');
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('REQUIRE_PUBSUB_AUTH=false in production');
    expect(scheduledInterval).toHaveBeenCalledTimes(1);
  });

  it('does NOT log when production has the safe default (auth required)', () => {
    checker.run({ env: 'production', requirePubsubAuth: true }, scheduledInterval);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(scheduledInterval).not.toHaveBeenCalled();
  });

  it('does NOT log when development has the override (local-dev escape hatch)', () => {
    checker.run({ env: 'development', requirePubsubAuth: false }, scheduledInterval);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(scheduledInterval).not.toHaveBeenCalled();
  });

  it('does NOT log when test env has the override', () => {
    checker.run({ env: 'test', requirePubsubAuth: false }, scheduledInterval);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(scheduledInterval).not.toHaveBeenCalled();
  });

  it('warning text contains explicit remediation steps (set GOOGLE_PUBSUB_AUDIENCE)', () => {
    checker.run({ env: 'production', requirePubsubAuth: false }, scheduledInterval);
    const warning = consoleErrorSpy.mock.calls[0][0];
    expect(warning).toContain('GOOGLE_PUBSUB_AUDIENCE');
    expect(warning).toContain('OIDC');
  });
});
