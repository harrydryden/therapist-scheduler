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
 * which one applies until we ask. But once the booking agent has called
 * `record_user_timezone` / `record_therapist_timezone`, the explicit zone is
 * on `SchedulingContext.userTimezone` / `.therapistTimezone` — at which point
 * the "you MUST ask" branch becomes wrong, and the section should render the
 * known zone instead. This module reads from both context fields so the prompt
 * matches the actual state of the world, not just the country.
 *
 * Kept dependency-light (only `@therapist-scheduler/shared` country helpers
 * and the SchedulingContext type) so the prompt fragment can be unit-tested
 * without booting config / Redis / settings.
 */

import {
  getCountry,
  getCountryLabel,
  getDefaultTimezone,
  hasMultipleTimezones,
} from '@therapist-scheduler/shared';
import type { SchedulingContext } from '../../services/scheduling-context.service';

export function buildTimezoneSection(
  context: SchedulingContext,
  schedulingTimezone: string,
): string {
  const userCountry = getCountry(context.userCountry);
  const therapistCountry = getCountry(context.therapistCountry);

  const userLabel = getCountryLabel(context.userCountry);
  const therapistLabel = getCountryLabel(context.therapistCountry);

  const userMulti = hasMultipleTimezones(context.userCountry);
  const therapistMulti = hasMultipleTimezones(context.therapistCountry);

  const userTzLine = renderUserTzLine({
    explicit: context.userTimezone,
    countryLabel: userLabel,
    countryTimezones: userCountry.timezones,
    countryDefault: getDefaultTimezone(context.userCountry),
    multiZone: userMulti,
  });
  const therapistTzLine = renderTherapistTzLine({
    explicit: context.therapistTimezone,
    countryLabel: therapistLabel,
    countryTimezones: therapistCountry.timezones,
    countryDefault: getDefaultTimezone(context.therapistCountry),
    multiZone: therapistMulti,
  });

  return `
## Timezones

- **Database / source of truth:** All appointment times in our database are stored in UK time (\`Europe/London\`). When you call \`mark_scheduling_complete\` or any other tool that records a time, the value MUST be expressed in UK time. Do NOT pass a converted time to a tool.
- **Scheduling timezone (for slot calculation):** \`${schedulingTimezone}\`
- **Client (${context.userName}) is based in:** ${userLabel} — local timezone: ${userTzLine}
- **Therapist (${context.therapistName}) is based in:** ${therapistLabel} — local timezone: ${therapistTzLine}

### Communication rules
- When emailing the **client**, present times in their local timezone. If the client and therapist are in different timezones, also include the equivalent UK time in brackets so the client can match it to anything we send programmatically. Example: "Tuesday at 3pm your time (4pm UK)".
- When emailing the **therapist**, present times in their local timezone. If different from UK, include the UK equivalent in brackets the same way.
- If either party is based in a country with multiple timezones AND we don't yet have their explicit zone on file (see the "local timezone" line above — it will explicitly say "unknown" in that case), you MUST ask them where they are based BEFORE proposing or confirming a specific time. Don't guess. Once asked and the explicit zone is recorded, do NOT ask again.
- **Trust what people tell you over what's on file.** If a client or therapist mentions they are in a different country, region, or timezone than the one above (e.g. they sign off "writing from New York" or say "I'm currently in Berlin"), treat their statement as authoritative for the rest of the conversation and format times for that location. If they tell you a new zone, call \`record_user_timezone\` / \`record_therapist_timezone\` with the new value to overwrite the old one.
- Be explicit about timezone abbreviations (e.g. "BST", "EST", "AEST") when daylight savings could create ambiguity.
- Never silently convert a time from someone's email into UK time and write that converted value back to them — quote the original time and confirm the timezone.

### Encoding a specific local time into a window
When you need to call \`record_availability_window\` for a wall-clock time someone mentioned (e.g. "free Tuesday 2pm"), do NOT compute the +HH:MM offset yourself — call **resolve_local_time** with the calendar parts (year, month, day, hour, minute), the duration in minutes, and the IANA timezone of the speaker (therapist's tz for source="therapist", client's tz for source="user"). It returns {starts_at, ends_at} with DST-aware offsets that you pass verbatim to record_availability_window. It also rejects ambiguous (fall-back) and non-existent (spring-forward) wall-clocks with a specific error so you can re-prompt the speaker.
`;
}

interface RenderTzLineArgs {
  explicit: string | undefined;
  countryLabel: string;
  countryTimezones: readonly string[];
  countryDefault: string | null;
  multiZone: boolean;
}

function renderUserTzLine(args: RenderTzLineArgs): string {
  if (args.explicit) {
    return `${args.explicit} (${args.countryLabel}, on file)`;
  }
  if (!args.multiZone) {
    return `${args.countryDefault} (${args.countryLabel})`;
  }
  return `unknown — ${args.countryLabel} spans multiple timezones (${args.countryTimezones.join(', ')}). You MUST ask the client where they are based (e.g. "what city are you in?") before quoting any specific time. Once they tell you, map the city to the matching IANA timezone from the list above and call \`record_user_timezone\` to persist it — you only need to ask ONCE; subsequent turns and emails will reuse the stored value.`;
}

function renderTherapistTzLine(args: RenderTzLineArgs): string {
  if (args.explicit) {
    return `${args.explicit} (${args.countryLabel}, on file)`;
  }
  if (!args.multiZone) {
    return `${args.countryDefault} (${args.countryLabel})`;
  }
  return `unknown — ${args.countryLabel} spans multiple timezones (${args.countryTimezones.join(', ')}). You MUST ask the therapist where they are based before quoting any specific time. Once they tell you, map to the matching IANA timezone from the list above and call \`record_therapist_timezone\` to persist it — you only need to ask ONCE; subsequent turns, emails, and the recurring-schedule stamp will reuse the stored value.`;
}
