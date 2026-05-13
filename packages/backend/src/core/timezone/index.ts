/**
 * Public surface for the timezone kernel.
 *
 * Import from `core/timezone` rather than the individual submodules so
 * that future reshapes don't ripple across every callsite. The
 * submodules are split by concern (pure wall-clock math vs. DB lookup
 * vs. audit classifier vs. prompt rendering) but most callers only
 * need one or two of them; the barrel reflects what's safe to depend
 * on.
 */

export {
  isValidIanaTimezone,
  resolveWallClock,
  formatIsoWithOffset,
  formatInTimezone,
  type ResolvedInstant,
  type ResolveResult,
} from './wall-clock';

export {
  resolveTherapistTimezone,
  resolveUserTimezone,
  type ResolvedTimezone,
  type TimezoneSource,
} from './resolve';

export { resolveRecipientTimezone } from './recipient';

export {
  classifyTherapistTimezone,
  classifyUserTimezone,
  PLATFORM_DEFAULT_TIMEZONE,
  type TherapistTimezoneInput,
  type TherapistTimezoneAuditRow,
  type TimezoneClassification,
  type UserTimezoneInput,
  type UserTimezoneAuditRow,
} from './audit';

export { buildTimezoneSection } from './prompt-section';
