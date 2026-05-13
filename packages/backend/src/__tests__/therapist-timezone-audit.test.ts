/**
 * Tests for the therapist-timezone audit classifier.
 *
 * The classifier is what the backfill script
 * (`scripts/audit-therapist-timezones.ts`) uses to bucket rows into
 * "safe to auto-stamp" vs "needs human review". The boundary matters
 * because mis-classifying a multi-zone country as auto-fixable would
 * silently stamp the platform default and re-create the exact bug
 * we're trying to clean up.
 */

import {
  classifyTherapistTimezone,
  classifyUserTimezone,
  type TherapistTimezoneInput,
  type UserTimezoneInput,
} from '../core/timezone/audit';

function row(overrides: Partial<TherapistTimezoneInput>): TherapistTimezoneInput {
  return {
    id: overrides.id ?? 'therapist-1',
    name: overrides.name ?? 'Test Therapist',
    email: overrides.email ?? 'test@example.com',
    country: overrides.country ?? 'UK',
    explicitTimezone: overrides.explicitTimezone,
    availability: overrides.availability ?? null,
  };
}

describe('classifyTherapistTimezone', () => {
  it('classifies a UK therapist with Europe/London stamp as OK', () => {
    const r = classifyTherapistTimezone(
      row({ country: 'UK', availability: { timezone: 'Europe/London' } }),
    );
    expect(r.classification).toBe('OK');
    expect(r.suggestedFix).toBe('-');
  });

  it('classifies a single-zone country with no stamp as AUTO_FIXABLE with the country default', () => {
    const r = classifyTherapistTimezone(
      row({ country: 'IE', availability: {} }),
    );
    expect(r.classification).toBe('AUTO_FIXABLE');
    expect(r.suggestedFix).toBe('Europe/Dublin');
  });

  it('classifies a US therapist stamped Europe/London as LEGACY_MISS_STAMP (the load-bearing safety case)', () => {
    const r = classifyTherapistTimezone(
      row({ country: 'US', availability: { timezone: 'Europe/London' } }),
    );
    expect(r.classification).toBe('LEGACY_MISS_STAMP');
    expect(r.suggestedFix).toMatch(/ASK THERAPIST/);
  });

  it('classifies a US therapist with no stamp as AMBIGUOUS (never auto-fix multi-zone)', () => {
    const r = classifyTherapistTimezone(
      row({ country: 'US', availability: {} }),
    );
    expect(r.classification).toBe('AMBIGUOUS');
    expect(r.suggestedFix).toMatch(/ASK THERAPIST/);
  });

  it('classifies a US therapist with a deliberate US timezone stamp as OK', () => {
    const r = classifyTherapistTimezone(
      row({ country: 'US', availability: { timezone: 'America/Los_Angeles' } }),
    );
    expect(r.classification).toBe('OK');
  });

  it('classifies a UK therapist stamped Europe/Paris as SINGLE_ZONE_OVERRIDE (probably intentional)', () => {
    const r = classifyTherapistTimezone(
      row({ country: 'UK', availability: { timezone: 'Europe/Paris' } }),
    );
    expect(r.classification).toBe('SINGLE_ZONE_OVERRIDE');
    expect(r.suggestedFix).toMatch(/REVIEW/);
  });

  it('classifies a therapist with no availability JSON as NO_SCHEDULE', () => {
    const r = classifyTherapistTimezone(row({ availability: null }));
    expect(r.classification).toBe('NO_SCHEDULE');
  });

  it('preserves identity fields on the output row for the audit dump', () => {
    const r = classifyTherapistTimezone(
      row({ id: 'abc', name: 'Sam', email: 'sam@example.com', country: 'US', availability: { timezone: 'Europe/London' } }),
    );
    expect(r.id).toBe('abc');
    expect(r.name).toBe('Sam');
    expect(r.email).toBe('sam@example.com');
  });

  it('classifies a US therapist with the new explicit Therapist.timezone as OK (legacy stamp ignored)', () => {
    // The agent has recorded the explicit zone via record_therapist_timezone.
    // Even if availability.timezone is wrong (or absent), the explicit
    // column wins and the row is OK.
    const r = classifyTherapistTimezone(
      row({
        country: 'US',
        explicitTimezone: 'America/Los_Angeles',
        availability: { timezone: 'Europe/London' }, // legacy miss-stamp
      }),
    );
    expect(r.classification).toBe('OK');
    expect(r.currentTimezone).toBe('America/Los_Angeles');
  });
});

function userRow(overrides: Partial<UserTimezoneInput>): UserTimezoneInput {
  return {
    id: overrides.id ?? 'user-1',
    name: overrides.name ?? 'Test User',
    email: overrides.email ?? 'user@example.com',
    country: overrides.country ?? 'UK',
    explicitTimezone: overrides.explicitTimezone,
  };
}

describe('classifyUserTimezone', () => {
  it('classifies a user with the explicit User.timezone set as OK', () => {
    const r = classifyUserTimezone(userRow({ country: 'US', explicitTimezone: 'America/Denver' }));
    expect(r.classification).toBe('OK');
    expect(r.currentTimezone).toBe('America/Denver');
  });

  it('classifies a single-zone-country user with no explicit zone as AUTO_FIXABLE', () => {
    const r = classifyUserTimezone(userRow({ country: 'IE' }));
    expect(r.classification).toBe('AUTO_FIXABLE');
    expect(r.suggestedFix).toBe('Europe/Dublin');
  });

  it('classifies a multi-zone-country user with no explicit zone as AMBIGUOUS', () => {
    const r = classifyUserTimezone(userRow({ country: 'AU' }));
    expect(r.classification).toBe('AMBIGUOUS');
    expect(r.suggestedFix).toMatch(/ASK CLIENT/);
  });
});
