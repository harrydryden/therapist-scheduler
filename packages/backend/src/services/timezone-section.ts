/**
 * Country-aware timezone guidance for the scheduling agent's system prompt.
 *
 * Database appointment times are always stored in UK time (Europe/London) — that
 * is the platform's source of truth and the agent must never alter it. However,
 * when speaking to a user or therapist who is based in a different country, the
 * agent should communicate times in that party's local timezone so they can act
 * on them without manual conversion.
 *
 * For countries with multiple timezones (US, Canada, Australia) we don't know
 * which one applies until we ask, so the prompt instructs the agent to ask
 * before quoting any specific time.
 *
 * Kept in its own module (with no service-level dependencies) so the prompt
 * fragment can be unit-tested without booting config / Redis / settings.
 */

import {
  getCountry,
  getCountryLabel,
  getDefaultTimezone,
  hasMultipleTimezones,
} from '@therapist-scheduler/shared';
import type { SchedulingContext } from './scheduling-context.service';

export function buildTimezoneSection(
  context: SchedulingContext,
  schedulingTimezone: string,
): string {
  const userCountry = getCountry(context.userCountry);
  const therapistCountry = getCountry(context.therapistCountry);

  const userLabel = getCountryLabel(context.userCountry);
  const therapistLabel = getCountryLabel(context.therapistCountry);

  const userTz = getDefaultTimezone(context.userCountry);
  const therapistTz = getDefaultTimezone(context.therapistCountry);

  const userMulti = hasMultipleTimezones(context.userCountry);
  const therapistMulti = hasMultipleTimezones(context.therapistCountry);

  const userTzLine = userMulti
    ? `unknown — ${userLabel} spans multiple timezones (${userCountry.timezones.join(', ')}). You MUST ask the client where they are based before quoting any specific time, then use the matching IANA timezone.`
    : `${userTz} (${userLabel})`;

  const therapistTzLine = therapistMulti
    ? `unknown — ${therapistLabel} spans multiple timezones (${therapistCountry.timezones.join(', ')}). You MUST ask the therapist where they are based before quoting any specific time, then use the matching IANA timezone.`
    : `${therapistTz} (${therapistLabel})`;

  return `
## Timezones

- **Database / source of truth:** All appointment times in our database are stored in UK time (\`Europe/London\`). When you call \`mark_scheduling_complete\` or any other tool that records a time, the value MUST be expressed in UK time. Do NOT pass a converted time to a tool.
- **Scheduling timezone (for slot calculation):** \`${schedulingTimezone}\`
- **Client (${context.userName}) is based in:** ${userLabel} — local timezone: ${userTzLine}
- **Therapist (${context.therapistName}) is based in:** ${therapistLabel} — local timezone: ${therapistTzLine}

### Communication rules
- When emailing the **client**, present times in their local timezone. If the client and therapist are in different timezones, also include the equivalent UK time in brackets so the client can match it to anything we send programmatically. Example: "Tuesday at 3pm your time (4pm UK)".
- When emailing the **therapist**, present times in their local timezone. If different from UK, include the UK equivalent in brackets the same way.
- If either party is based in a country with multiple timezones AND we don't yet know their specific region, you MUST ask them where they are based BEFORE proposing or confirming a specific time. Don't guess.
- Be explicit about timezone abbreviations (e.g. "BST", "EST", "AEST") when daylight savings could create ambiguity.
- Never silently convert a time from someone's email into UK time and write that converted value back to them — quote the original time and confirm the timezone.
`;
}
