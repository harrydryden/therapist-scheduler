/**
 * Resolve a therapist's IANA timezone with confidence labelling.
 *
 * Several callers (the availability-collection agent's prompt builder,
 * the booking agent's prompt builder, the recurring-schedule writer)
 * need the therapist's wall-clock timezone. Up to now the pattern was:
 *
 *   const tz = therapist.availability?.timezone
 *           || getDefaultTimezone(therapist.country)
 *           || platformTimezone;
 *
 * which silently lands at the platform default (Europe/London) for any
 * therapist in a multi-zone country (US, AU, CA, RU, BR, ...) who
 * hasn't yet had a recurring schedule stamped. Every "Tuesday 9am" they
 * mention is then misinterpreted by several hours, indistinguishably
 * from intentional London time.
 *
 * This helper returns the same string the original chain would have,
 * but also tells the caller WHICH branch supplied it so the prompt
 * builder can ask the therapist to confirm rather than guess.
 */

import { getDefaultTimezone } from '@therapist-scheduler/shared';
import { logger } from '../utils/logger';

/**
 * Where the resolved timezone came from:
 *   - 'stamped'         — an explicit `availability.timezone` on the row,
 *                         the strongest signal.
 *   - 'country_default' — single-zone country (UK, IE, etc.), the country
 *                         default is unambiguous.
 *   - 'platform_default' — multi-zone country with no stamp, falling
 *                         through to the platform default. The agent
 *                         SHOULD ask before relying on this.
 */
export type TimezoneSource = 'stamped' | 'country_default' | 'platform_default';

export interface ResolvedTimezone {
  timezone: string;
  source: TimezoneSource;
  /** True iff the country has multiple zones AND no explicit stamp. */
  needsClarification: boolean;
}

export function resolveTherapistTimezone(args: {
  stampedTimezone: string | null | undefined;
  country: string | null | undefined;
  platformTimezone: string;
}): ResolvedTimezone {
  const stamped = (args.stampedTimezone ?? '').trim();
  if (stamped) {
    // Light sanity check: stamped but country is multi-zone is fine —
    // the stamp wins. Stamped but doesn't match the country's default
    // is also fine (therapist may live in a different region than the
    // platform default for their country).
    maybeWarnSuspicious(stamped, args.country);
    return { timezone: stamped, source: 'stamped', needsClarification: false };
  }
  const countryDefault = getDefaultTimezone(args.country ?? '');
  if (countryDefault) {
    return {
      timezone: countryDefault,
      source: 'country_default',
      needsClarification: false,
    };
  }
  return {
    timezone: args.platformTimezone,
    source: 'platform_default',
    needsClarification: true,
  };
}

/**
 * Emit a single WARN for stamped timezones that look out-of-place for
 * the therapist's country — e.g. a US therapist with the platform
 * default ('Europe/London') stamped on their availability record from
 * a legacy ingestion. Observability only; no behavioural change.
 *
 * The check is intentionally narrow: only flag when the stamp is the
 * platform default AND the country has multiple zones. A US therapist
 * deliberately stamped with 'America/New_York' is fine; one stamped
 * with 'Europe/London' on a row created before the country-default
 * precedence existed is the legacy case we want to surface.
 */
function maybeWarnSuspicious(stamped: string, country: string | null | undefined) {
  if (!country) return;
  // Heuristic: stamped is 'Europe/London' (the platform default) and
  // the country is one where the country default would have returned
  // null (i.e. multi-zone). getDefaultTimezone returning null is the
  // signal for "multi-zone" — we re-evaluate to detect the case
  // without hard-coding country codes here.
  if (stamped !== 'Europe/London') return;
  const countryDefault = getDefaultTimezone(country);
  if (countryDefault === null && country.toUpperCase() !== 'UK') {
    // Multi-zone country stamped with the UK default. Probable legacy
    // miss-stamp from before the country-default precedence existed.
    logger.warn(
      { country, stamped },
      'therapist-timezone: stamped timezone looks suspicious — multi-zone country with Europe/London stamp, may be a legacy miss-stamp',
    );
  }
}

/**
 * Resolve the timezone for a user (booking-side client) with the same
 * three-tier confidence labelling. Mirrors resolveTherapistTimezone but
 * users have no explicit stamp field today — we go straight from
 * country to platform default.
 */
export function resolveUserTimezone(args: {
  country: string | null | undefined;
  platformTimezone: string;
}): ResolvedTimezone {
  const countryDefault = getDefaultTimezone(args.country ?? '');
  if (countryDefault) {
    return {
      timezone: countryDefault,
      source: 'country_default',
      needsClarification: false,
    };
  }
  return {
    timezone: args.platformTimezone,
    source: 'platform_default',
    needsClarification: true,
  };
}
