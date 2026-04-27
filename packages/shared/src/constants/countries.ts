/**
 * Country definitions used across the platform.
 *
 * Each country has:
 *  - code: short uppercase identifier persisted on User/Therapist records
 *  - label: human-readable name shown in admin UI
 *  - flag: emoji flag displayed on therapist cards
 *  - timezones: IANA timezones associated with the country. Countries with
 *    multiple timezones require the agent to ask where the person is based
 *    before formatting times for them.
 *  - defaultTimezone: timezone to assume when the country has a single one,
 *    or null when ambiguous.
 *
 * Database appointment times are always stored in UK time (Europe/London).
 * The timezone here is only used to present times to the relevant party.
 */

export type CountryCode =
  | 'UK'
  | 'IE'
  | 'US'
  | 'CA'
  | 'ES'
  | 'DE'
  | 'FR'
  | 'PT'
  | 'AU'
  | 'NZ'
  | 'ZA';

export interface CountryDefinition {
  code: CountryCode;
  label: string;
  flag: string;
  timezones: readonly string[];
  defaultTimezone: string | null;
}

export const COUNTRIES: readonly CountryDefinition[] = [
  {
    code: 'UK',
    label: 'United Kingdom',
    flag: '🇬🇧',
    timezones: ['Europe/London'],
    defaultTimezone: 'Europe/London',
  },
  {
    code: 'IE',
    label: 'Ireland',
    flag: '🇮🇪',
    timezones: ['Europe/Dublin'],
    defaultTimezone: 'Europe/Dublin',
  },
  {
    code: 'US',
    label: 'United States',
    flag: '🇺🇸',
    timezones: [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Phoenix',
      'America/Los_Angeles',
      'America/Anchorage',
      'Pacific/Honolulu',
    ],
    defaultTimezone: null,
  },
  {
    code: 'CA',
    label: 'Canada',
    flag: '🇨🇦',
    timezones: [
      'America/St_Johns',
      'America/Halifax',
      'America/Toronto',
      'America/Winnipeg',
      'America/Edmonton',
      'America/Vancouver',
    ],
    defaultTimezone: null,
  },
  {
    code: 'ES',
    label: 'Spain',
    flag: '🇪🇸',
    timezones: ['Europe/Madrid'],
    defaultTimezone: 'Europe/Madrid',
  },
  {
    code: 'DE',
    label: 'Germany',
    flag: '🇩🇪',
    timezones: ['Europe/Berlin'],
    defaultTimezone: 'Europe/Berlin',
  },
  {
    code: 'FR',
    label: 'France',
    flag: '🇫🇷',
    timezones: ['Europe/Paris'],
    defaultTimezone: 'Europe/Paris',
  },
  {
    code: 'PT',
    label: 'Portugal',
    flag: '🇵🇹',
    timezones: ['Europe/Lisbon'],
    defaultTimezone: 'Europe/Lisbon',
  },
  {
    code: 'AU',
    label: 'Australia',
    flag: '🇦🇺',
    timezones: [
      'Australia/Perth',
      'Australia/Adelaide',
      'Australia/Darwin',
      'Australia/Brisbane',
      'Australia/Sydney',
      'Australia/Hobart',
    ],
    defaultTimezone: null,
  },
  {
    code: 'NZ',
    label: 'New Zealand',
    flag: '🇳🇿',
    timezones: ['Pacific/Auckland'],
    defaultTimezone: 'Pacific/Auckland',
  },
  {
    code: 'ZA',
    label: 'South Africa',
    flag: '🇿🇦',
    timezones: ['Africa/Johannesburg'],
    defaultTimezone: 'Africa/Johannesburg',
  },
] as const;

export const COUNTRY_CODES: readonly CountryCode[] = COUNTRIES.map((c) => c.code);

export const DEFAULT_COUNTRY: CountryCode = 'UK';

const COUNTRY_BY_CODE: Record<string, CountryDefinition> = COUNTRIES.reduce(
  (acc, country) => {
    acc[country.code] = country;
    return acc;
  },
  {} as Record<string, CountryDefinition>,
);

export function isCountryCode(value: string): value is CountryCode {
  return Object.prototype.hasOwnProperty.call(COUNTRY_BY_CODE, value);
}

export function getCountry(code: string | null | undefined): CountryDefinition {
  if (code && isCountryCode(code)) {
    return COUNTRY_BY_CODE[code];
  }
  return COUNTRY_BY_CODE[DEFAULT_COUNTRY];
}

export function getCountryFlag(code: string | null | undefined): string {
  return getCountry(code).flag;
}

export function getCountryLabel(code: string | null | undefined): string {
  return getCountry(code).label;
}

/**
 * Whether a country has multiple timezones — agents should ask the person
 * where they are based before quoting times.
 */
export function hasMultipleTimezones(code: string | null | undefined): boolean {
  return getCountry(code).timezones.length > 1;
}

/**
 * Get the default timezone for a country. Returns null for countries with
 * multiple timezones (callers should ask the user/therapist for their region).
 */
export function getDefaultTimezone(code: string | null | undefined): string | null {
  return getCountry(code).defaultTimezone;
}
