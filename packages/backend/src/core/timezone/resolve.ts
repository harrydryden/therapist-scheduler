/**
 * Pure timezone resolution for therapists and users.
 *
 * The resolvers in this module are dependency-light by design — no
 * Prisma, no config, no Redis. They take the relevant row fields as
 * input and apply the precedence chain:
 *
 *   1. Explicit `timezone` column (populated by the agent after asking
 *      where the person is based). STRONGEST signal; supersedes
 *      everything else.
 *   2. (Therapists only) The legacy `availability.timezone` stamp.
 *   3. The country's default timezone for single-zone countries.
 *   4. Platform default ('Europe/London'), with `needsClarification`
 *      flagged so the agent knows it's a guess.
 *
 * Callers that need to look a recipient up by email and load the row
 * themselves use `resolveRecipientTimezone` from `./recipient.ts`,
 * which lives in a separate module so importing this file (or the
 * `core/timezone` barrel via the wall-clock helpers) doesn't transitively
 * pull in Prisma + config and break test-time module loading.
 */

import { getDefaultTimezone } from '@therapist-scheduler/shared';
import { logger } from '../../utils/logger';

/**
 * Where the resolved timezone came from:
 *   - 'explicit'         the `Therapist.timezone` / `User.timezone` column.
 *   - 'stamped'          legacy `Therapist.availability.timezone` JSON
 *                        field (therapists only).
 *   - 'country_default'  single-zone country, the country default is
 *                        unambiguous.
 *   - 'platform_default' multi-zone country with no stamp; the agent
 *                        SHOULD ask before relying on this.
 */
export type TimezoneSource = 'explicit' | 'stamped' | 'country_default' | 'platform_default';

export interface ResolvedTimezone {
  timezone: string;
  source: TimezoneSource;
  /** True iff the country has multiple zones AND no explicit zone or
   *  stamp on file — the agent should ASK before relying on the
   *  resolved value. */
  needsClarification: boolean;
}

export function resolveTherapistTimezone(args: {
  /** Value of the new `Therapist.timezone` column. */
  explicitTimezone?: string | null;
  /** Value of legacy `availability.timezone` JSON field. */
  stampedTimezone: string | null | undefined;
  country: string | null | undefined;
  platformTimezone: string;
}): ResolvedTimezone {
  const explicit = (args.explicitTimezone ?? '').trim();
  if (explicit) {
    return { timezone: explicit, source: 'explicit', needsClarification: false };
  }
  const stamped = (args.stampedTimezone ?? '').trim();
  if (stamped) {
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
  if (stamped !== 'Europe/London') return;
  const countryDefault = getDefaultTimezone(country);
  if (countryDefault === null && country.toUpperCase() !== 'UK') {
    logger.warn(
      { country, stamped },
      'therapist-timezone: stamped timezone looks suspicious — multi-zone country with Europe/London stamp, may be a legacy miss-stamp',
    );
  }
}

/**
 * Resolve the timezone for a user (booking-side client). Mirrors
 * `resolveTherapistTimezone` but users have no `availability.timezone`
 * stamp field — we go straight from country to platform default when
 * there's no explicit value.
 */
export function resolveUserTimezone(args: {
  explicitTimezone?: string | null;
  country: string | null | undefined;
  platformTimezone: string;
}): ResolvedTimezone {
  const explicit = (args.explicitTimezone ?? '').trim();
  if (explicit) {
    return { timezone: explicit, source: 'explicit', needsClarification: false };
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
