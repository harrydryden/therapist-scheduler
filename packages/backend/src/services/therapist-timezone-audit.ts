/**
 * Audit helper for therapist timezone stamps.
 *
 * Pure classifier — takes a therapist row's relevant fields and returns
 * a bucket plus a suggested action. Used by the
 * `scripts/audit-therapist-timezones.ts` backfill tool and by the
 * accompanying tests; lives in `src/services` so it sits alongside the
 * runtime resolver in `therapist-timezone.service.ts` and the two
 * share the same view of "what's a sensible stamp."
 *
 * The classifier does NOT auto-correct multi-zone countries: when we
 * don't know which US/AU/CA region a therapist is in, the only safe
 * move is to ask. Single-zone countries with no stamp are the only
 * auto-fixable subset.
 */

import {
  getDefaultTimezone,
  hasMultipleTimezones,
} from '@therapist-scheduler/shared';

export const PLATFORM_DEFAULT_TIMEZONE = 'Europe/London';

export type TimezoneClassification =
  | 'OK'
  | 'LEGACY_MISS_STAMP'
  | 'AUTO_FIXABLE'
  | 'SINGLE_ZONE_OVERRIDE'
  | 'AMBIGUOUS'
  | 'NO_SCHEDULE';

export interface TherapistTimezoneInput {
  id: string;
  name: string;
  email: string;
  country: string;
  /** Value of the new `Therapist.timezone` column (the canonical
   *  agent-confirmed zone). When present, the row is OK regardless of
   *  what's in availability.timezone — explicit wins. */
  explicitTimezone?: string | null;
  /** Parsed `availability` JSON or null if the therapist has none. */
  availability: { timezone?: string } | null;
}

export interface TherapistTimezoneAuditRow {
  id: string;
  name: string;
  email: string;
  country: string;
  currentTimezone: string;
  classification: TimezoneClassification;
  /** The IANA timezone to stamp on `--apply`, or a human-readable
   *  instruction when no automated fix is appropriate. */
  suggestedFix: string;
}

export function classifyTherapistTimezone(
  row: TherapistTimezoneInput,
): TherapistTimezoneAuditRow {
  // Explicit `Therapist.timezone` column trumps everything — the
  // canonical agent-confirmed zone. When present, the row is OK and
  // the legacy stamp is irrelevant for classification.
  const explicit = (row.explicitTimezone ?? '').trim();
  if (explicit) {
    return base(row, explicit, 'OK', '-');
  }

  const current = row.availability?.timezone ?? '';
  const countryDefault = getDefaultTimezone(row.country);
  const multiZone = hasMultipleTimezones(row.country);

  if (!row.availability) {
    return base(row, '', 'NO_SCHEDULE', '-');
  }

  if (!current) {
    if (countryDefault) {
      return base(row, '', 'AUTO_FIXABLE', countryDefault);
    }
    return base(
      row,
      '',
      'AMBIGUOUS',
      `ASK THERAPIST (${row.country} has multiple timezones)`,
    );
  }

  if (multiZone) {
    if (current === PLATFORM_DEFAULT_TIMEZONE && row.country.toUpperCase() !== 'UK') {
      return base(
        row,
        current,
        'LEGACY_MISS_STAMP',
        `ASK THERAPIST (${row.country} has multiple timezones; current stamp is platform default)`,
      );
    }
    return base(row, current, 'OK', '-');
  }

  if (countryDefault && current !== countryDefault) {
    return base(
      row,
      current,
      'SINGLE_ZONE_OVERRIDE',
      `REVIEW: country default is ${countryDefault} but stamp is ${current}`,
    );
  }
  return base(row, current, 'OK', '-');
}

function base(
  row: TherapistTimezoneInput,
  current: string,
  classification: TimezoneClassification,
  suggestedFix: string,
): TherapistTimezoneAuditRow {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    country: row.country,
    currentTimezone: current,
    classification,
    suggestedFix,
  };
}

/**
 * User classifier. Simpler than the therapist one — users have only the
 * single `User.timezone` column, no `availability.timezone` fallback.
 *
 * Buckets used:
 *   - OK         explicit zone on file
 *   - AUTO_FIXABLE   single-zone country, no zone — country default is unambiguous
 *   - AMBIGUOUS  multi-zone country, no zone — the booking agent should ask
 */
export interface UserTimezoneInput {
  id: string;
  name: string | null;
  email: string;
  country: string;
  explicitTimezone?: string | null;
}

export interface UserTimezoneAuditRow {
  id: string;
  name: string;
  email: string;
  country: string;
  currentTimezone: string;
  classification: 'OK' | 'AUTO_FIXABLE' | 'AMBIGUOUS';
  suggestedFix: string;
}

export function classifyUserTimezone(row: UserTimezoneInput): UserTimezoneAuditRow {
  const explicit = (row.explicitTimezone ?? '').trim();
  if (explicit) {
    return {
      id: row.id,
      name: row.name ?? '',
      email: row.email,
      country: row.country,
      currentTimezone: explicit,
      classification: 'OK',
      suggestedFix: '-',
    };
  }
  const countryDefault = getDefaultTimezone(row.country);
  if (countryDefault) {
    return {
      id: row.id,
      name: row.name ?? '',
      email: row.email,
      country: row.country,
      currentTimezone: '',
      classification: 'AUTO_FIXABLE',
      suggestedFix: countryDefault,
    };
  }
  return {
    id: row.id,
    name: row.name ?? '',
    email: row.email,
    country: row.country,
    currentTimezone: '',
    classification: 'AMBIGUOUS',
    suggestedFix: `ASK CLIENT (${row.country} has multiple timezones)`,
  };
}
