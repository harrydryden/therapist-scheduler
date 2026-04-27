/**
 * Tests for the shared country/timezone helpers and the country-aware
 * timezone section that the system prompt builder injects for the agent.
 */

import {
  COUNTRIES,
  COUNTRY_CODES,
  DEFAULT_COUNTRY,
  getCountry,
  getCountryFlag,
  getCountryLabel,
  getDefaultTimezone,
  hasMultipleTimezones,
  isCountryCode,
} from '@therapist-scheduler/shared';

describe('country definitions', () => {
  it('exposes the 11 supported countries', () => {
    expect(COUNTRIES).toHaveLength(11);
    expect(COUNTRY_CODES).toEqual(
      expect.arrayContaining(['UK', 'IE', 'US', 'CA', 'ES', 'DE', 'FR', 'PT', 'AU', 'NZ', 'ZA']),
    );
  });

  it('defaults to UK', () => {
    expect(DEFAULT_COUNTRY).toBe('UK');
  });

  it('every country has a flag emoji and at least one timezone', () => {
    for (const country of COUNTRIES) {
      expect(country.flag.length).toBeGreaterThan(0);
      expect(country.timezones.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('single-timezone countries expose a defaultTimezone', () => {
    const single = COUNTRIES.filter((c) => c.timezones.length === 1);
    for (const country of single) {
      expect(country.defaultTimezone).toBe(country.timezones[0]);
    }
  });

  it('multi-timezone countries leave defaultTimezone null', () => {
    const multi = COUNTRIES.filter((c) => c.timezones.length > 1);
    for (const country of multi) {
      expect(country.defaultTimezone).toBeNull();
    }
    expect(multi.map((c) => c.code).sort()).toEqual(['AU', 'CA', 'US']);
  });
});

describe('isCountryCode', () => {
  it('accepts known country codes', () => {
    expect(isCountryCode('UK')).toBe(true);
    expect(isCountryCode('US')).toBe(true);
    expect(isCountryCode('ZA')).toBe(true);
  });

  it('rejects unknown or malformed codes', () => {
    expect(isCountryCode('GB')).toBe(false);
    expect(isCountryCode('uk')).toBe(false);
    expect(isCountryCode('')).toBe(false);
    expect(isCountryCode('XX')).toBe(false);
  });
});

describe('getCountry', () => {
  it('returns the matching country definition', () => {
    expect(getCountry('IE').label).toBe('Ireland');
    expect(getCountry('FR').label).toBe('France');
  });

  it('falls back to UK for unknown codes', () => {
    expect(getCountry('XX').code).toBe('UK');
    expect(getCountry(null).code).toBe('UK');
    expect(getCountry(undefined).code).toBe('UK');
  });
});

describe('getCountryFlag / getCountryLabel', () => {
  it('returns the flag emoji and label', () => {
    expect(getCountryFlag('UK')).toBe('🇬🇧');
    expect(getCountryFlag('US')).toBe('🇺🇸');
    expect(getCountryLabel('IE')).toBe('Ireland');
  });

  it('falls back to UK for unknown values', () => {
    expect(getCountryFlag('XX')).toBe('🇬🇧');
    expect(getCountryLabel(null)).toBe('United Kingdom');
  });
});

describe('getDefaultTimezone', () => {
  it('returns the IANA timezone for single-timezone countries', () => {
    expect(getDefaultTimezone('UK')).toBe('Europe/London');
    expect(getDefaultTimezone('IE')).toBe('Europe/Dublin');
    expect(getDefaultTimezone('NZ')).toBe('Pacific/Auckland');
    expect(getDefaultTimezone('ZA')).toBe('Africa/Johannesburg');
  });

  it('returns null for countries that span multiple timezones', () => {
    expect(getDefaultTimezone('US')).toBeNull();
    expect(getDefaultTimezone('CA')).toBeNull();
    expect(getDefaultTimezone('AU')).toBeNull();
  });
});

describe('hasMultipleTimezones', () => {
  it('flags US, Canada, and Australia as multi-timezone', () => {
    expect(hasMultipleTimezones('US')).toBe(true);
    expect(hasMultipleTimezones('CA')).toBe(true);
    expect(hasMultipleTimezones('AU')).toBe(true);
  });

  it('treats single-timezone countries as not multi', () => {
    expect(hasMultipleTimezones('UK')).toBe(false);
    expect(hasMultipleTimezones('IE')).toBe(false);
    expect(hasMultipleTimezones('FR')).toBe(false);
  });

  it('treats unknown codes as UK (single timezone)', () => {
    expect(hasMultipleTimezones('XX')).toBe(false);
    expect(hasMultipleTimezones(undefined)).toBe(false);
  });
});
