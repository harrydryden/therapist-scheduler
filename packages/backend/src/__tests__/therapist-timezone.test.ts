/**
 * Tests for the three-tier therapist timezone resolver.
 *
 * The resolver is what stops the availability-collection agent from
 * silently encoding "Tuesday 9am" for a US therapist in Europe/London
 * when no recurring schedule has been stamped yet. The "needs
 * clarification" flag flows into the prompt to tell the agent to ASK
 * rather than guess.
 */

const warnSpy = jest.fn();
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: (...a: unknown[]) => warnSpy(...a), error: jest.fn(), debug: jest.fn() },
}));

import { resolveTherapistTimezone, resolveUserTimezone } from '../services/therapist-timezone.service';

beforeEach(() => warnSpy.mockClear());

describe('resolveTherapistTimezone', () => {
  it("returns the stamped timezone when present", () => {
    const r = resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: 'America/Los_Angeles',
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.source).toBe('stamped');
    expect(r.needsClarification).toBe(false);
  });

  it("falls back to the country default for a single-zone country", () => {
    const r = resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: null,
      country: 'UK',
      platformTimezone: 'Europe/London',
    });
    expect(r.timezone).toBe('Europe/London');
    expect(r.source).toBe('country_default');
    expect(r.needsClarification).toBe(false);
  });

  it("flags multi-zone country with no stamp as needing clarification", () => {
    const r = resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: null,
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(r.timezone).toBe('Europe/London');
    expect(r.source).toBe('platform_default');
    expect(r.needsClarification).toBe(true);
  });

  it("flags Australia with no stamp the same way as US", () => {
    const r = resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: null,
      country: 'AU',
      platformTimezone: 'Europe/London',
    });
    expect(r.needsClarification).toBe(true);
    expect(r.source).toBe('platform_default');
  });

  it("emits a WARN when a multi-zone country is stamped with the platform default (legacy miss-stamp signal)", () => {
    resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: 'Europe/London',
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatch(/legacy miss-stamp/);
  });

  it("does NOT WARN when a UK therapist is legitimately stamped Europe/London", () => {
    resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: 'Europe/London',
      country: 'UK',
      platformTimezone: 'Europe/London',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT WARN when a US therapist is stamped with a US timezone", () => {
    resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: 'America/New_York',
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('resolveUserTimezone', () => {
  it("returns the country default for single-zone countries", () => {
    const r = resolveUserTimezone({ country: 'IE', platformTimezone: 'Europe/London' });
    expect(r.source).toBe('country_default');
    expect(r.needsClarification).toBe(false);
  });

  it("flags multi-zone countries as needing clarification", () => {
    const r = resolveUserTimezone({ country: 'US', platformTimezone: 'Europe/London' });
    expect(r.source).toBe('platform_default');
    expect(r.needsClarification).toBe(true);
  });

  it("returns the explicit User.timezone when present, overriding country default", () => {
    const r = resolveUserTimezone({
      explicitTimezone: 'America/Los_Angeles',
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(r.source).toBe('explicit');
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.needsClarification).toBe(false);
  });

  it("returns the explicit zone even when the country is single-zone", () => {
    // A UK-country user who's actually in NYC — explicit wins.
    const r = resolveUserTimezone({
      explicitTimezone: 'America/New_York',
      country: 'UK',
      platformTimezone: 'Europe/London',
    });
    expect(r.source).toBe('explicit');
    expect(r.timezone).toBe('America/New_York');
  });
});

describe('resolveTherapistTimezone — explicit precedence', () => {
  it("returns 'explicit' when Therapist.timezone is set, even when availability.timezone also exists", () => {
    const r = resolveTherapistTimezone({
      explicitTimezone: 'America/Los_Angeles',
      stampedTimezone: 'America/New_York', // legacy stamp; should be ignored
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(r.source).toBe('explicit');
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.needsClarification).toBe(false);
  });

  it("falls back to the legacy availability.timezone stamp when no explicit zone is set", () => {
    const r = resolveTherapistTimezone({
      explicitTimezone: undefined,
      stampedTimezone: 'America/Chicago',
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(r.source).toBe('stamped');
    expect(r.timezone).toBe('America/Chicago');
  });
});
