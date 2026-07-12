/**
 * Scheduling tools definition — passed to Claude by the booking agent's
 * tool loop (services/agent-tool-loop.ts). Moved out of that file
 * (Stage D2, docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md) to sit beside
 * dispatch.ts: the tool schema and the code that executes those tools
 * are both scheduling policy, not generic loop mechanism.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SEND_EMAIL_PURPOSE_VALUES } from '../../../schemas/tool-inputs';

export const schedulingTools: Anthropic.Tool[] = [
  {
    name: 'resolve_local_time',
    description:
      'Convert a wall-clock time in a specific IANA timezone into the (starts_at, ends_at) ISO 8601 pair that record_availability_window expects. ALWAYS call this before record_availability_window — do NOT compute the +HH:MM offset yourself, because it changes across DST and varies by region. Supply the wall-clock parts (year, month, day, hour, minute), the duration in minutes, and the IANA timezone (the therapist\'s for therapist-source windows, the user\'s for user-source windows). The executor handles DST-aware offset selection and rejects ambiguous (fall-back) or non-existent (spring-forward) inputs so you can re-prompt the speaker.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: {
          type: 'string',
          description:
            'IANA timezone identifier for the wall-clock time (e.g. "Europe/London", "America/New_York", "Australia/Sydney"). Use the speaker\'s timezone shown above in the prompt; if the speaker\'s timezone is ambiguous (country has multiple zones and none is on file), ASK rather than guessing.',
        },
        year: { type: 'number', description: 'Four-digit year (e.g. 2026).' },
        month: { type: 'number', description: 'Month, 1-12 (1 = January).' },
        day: { type: 'number', description: 'Day of month, 1-31.' },
        hour: { type: 'number', description: 'Hour in 24-hour clock, 0-23 (e.g. 14 for 2pm).' },
        minute: { type: 'number', description: 'Minute, 0-59.' },
        duration_minutes: {
          type: 'number',
          description:
            'Duration of the window in minutes. Use the natural duration ("free 2pm-4pm" → 120; "free Tuesday afternoon" → 240 or whatever you interpret afternoon to mean). Min 1, max 14 days.',
        },
      },
      required: ['timezone', 'year', 'month', 'day', 'hour', 'minute', 'duration_minutes'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email to a recipient. Always pass `purpose` so the system can track stage progression correctly — without it, the system falls back to inferring stage from recipient alone, which can\'t distinguish "asking the therapist for more slots after a user rejection" from "courtesy thanks to the therapist after forwarding slots".',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address',
        },
        subject: {
          type: 'string',
          description: 'Email subject line. MUST include "Spill" somewhere in the subject (e.g., "Spill Therapy - Scheduling your session").',
        },
        body: {
          type: 'string',
          description: 'Email body content (plain text). IMPORTANT: Do NOT insert line breaks within paragraphs - only use blank lines between paragraphs. Let the email client handle text wrapping. Each paragraph should be a single continuous line of text.',
        },
        purpose: {
          type: 'string',
          // Sourced from the Zod schema so a new purpose value
          // propagates automatically — no risk of the tool definition
          // drifting from the handler's exhaustive switch.
          enum: [...SEND_EMAIL_PURPOSE_VALUES],
          description:
            'Declared intent for this email — strongly recommended on every call. Pick the value that matches what the email is for:\n' +
            '- `request_availability`: initial email to the therapist asking for their general availability.\n' +
            '- `send_options`: email to the user with the therapist\'s available time slots.\n' +
            '- `confirm_slot_with_therapist`: after the user picks a time, asking the therapist to confirm.\n' +
            '- `request_more_availability`: the user rejected all offered times and you are asking the therapist for new slots. Use this — NOT `request_availability` — so the system knows this is a deliberate go-back, not an initial outreach.\n' +
            '- `acknowledge`: a courtesy reply ("thanks", "I\'ll get back to you", "received"). The stage WILL NOT change — use this for replies that don\'t shift who we\'re waiting on.\n' +
            '- `other`: anything that doesn\'t fit the above. Used sparingly.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'update_therapist_availability',
    description: 'Save therapist availability to the database for future bookings. Use this when a therapist provides their general availability for the first time. The time ranges are wall-clock times in the therapist\'s local timezone — supply the matching IANA timezone in the optional `timezone` field when the therapist is in a multi-zone country (US, Australia, Canada, etc.) or when their stamped timezone might be wrong. Without it the system falls back to the country\'s default (single-zone countries) or the platform default (multi-zone countries), and the latter is almost certainly wrong.',
    input_schema: {
      type: 'object' as const,
      properties: {
        availability: {
          type: 'object',
          description: 'Availability by day of week. Keys are day names (Monday, Tuesday, etc.), values are time ranges like "09:00-12:00, 14:00-17:00" in the therapist\'s local timezone.',
          additionalProperties: { type: 'string' },
        },
        timezone: {
          type: 'string',
          description: 'Optional IANA timezone identifier for the supplied wall-clock ranges (e.g. "America/New_York", "Australia/Sydney"). REQUIRED when the therapist is in a multi-zone country and no timezone is on file yet — the Timezones section above flags this case. Omit when the therapist is in a single-zone country (UK, IE, ...).',
        },
      },
      required: ['availability'],
    },
  },
  {
    name: 'mark_scheduling_complete',
    description: "Mark the scheduling as complete and send final confirmation emails to both parties. Use this AFTER the therapist confirms they will send the meeting link.\n\nPREFERRED CALL SHAPE: supply the structured form — `timezone` + `year` + `month` + `day` + `hour` + `minute` — with the wall-clock components AS THE TIME WAS AGREED and the IANA timezone they were agreed in (e.g. the client confirmed \"3pm my time\" from New York → hour: 15, timezone: \"America/New_York\"). The executor converts to the canonical stored form via the same DST-aware path resolve_local_time uses. Do NOT convert the agreed time to another timezone yourself — freehand conversion is exactly the DST-prone step this form exists to eliminate.\n\nLEGACY CALL SHAPE: pass `confirmed_datetime` as a freeform string like \"Monday 3rd February at 10:00am\" — interpreted as UK time (Europe/London), so ONLY use this form when the agreed time is already expressed in UK time. Prefer the structured form for new calls — it eliminates a class of date-resolution and timezone-conversion errors.",
    input_schema: {
      type: 'object' as const,
      properties: {
        confirmed_datetime: {
          type: 'string',
          description: 'LEGACY: the confirmed appointment date and time as a freeform string (e.g., "Monday 3rd February at 10:00am"). Provide this OR the structured form (timezone+year+month+day+hour+minute), not both.',
        },
        timezone: {
          type: 'string',
          description: 'PREFERRED: IANA timezone the confirmed time was AGREED in (e.g. "America/New_York" when the client confirmed a time in their own zone). The executor converts DST-safely — never pre-convert the wall-clock to a different zone yourself.',
        },
        year: { type: 'number', description: 'PREFERRED: four-digit year of the confirmed appointment.' },
        month: { type: 'number', description: 'PREFERRED: month 1-12 of the confirmed appointment.' },
        day: { type: 'number', description: 'PREFERRED: day of month 1-31 of the confirmed appointment.' },
        hour: { type: 'number', description: 'PREFERRED: hour 0-23 of the confirmed appointment, as agreed in `timezone`.' },
        minute: { type: 'number', description: 'PREFERRED: minute 0-59 of the confirmed appointment.' },
        notes: {
          type: 'string',
          description: 'Any additional notes about the booking',
        },
      },
      required: [],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel the appointment when either the client or therapist indicates they want to cancel or can no longer proceed. This frees up the therapist for other bookings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'The reason for cancellation (e.g., "Client requested cancellation", "Therapist unavailable")',
        },
        cancelled_by: {
          type: 'string',
          enum: ['client', 'therapist'],
          description: 'Who initiated the cancellation',
        },
      },
      required: ['reason', 'cancelled_by'],
    },
  },
  {
    name: 'recommend_cancel_match',
    description: 'Recommend cancelling this match to the admin when the user has declined the therapist (e.g. due to availability issues, preference, or any other reason they do not want to proceed). This sends an alert to the admin so they can cancel the match and free up the therapist for other users. Use this instead of cancel_appointment when the user indicates they do not want to work with this therapist but has not explicitly asked to cancel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'The reason the user has declined the match (e.g., "User declined due to therapist availability not matching their schedule")',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'issue_voucher_code',
    description: 'Issue a new session voucher code for a user who does not have one. Use this when a user contacts you saying they need a session code to book. The voucher code and booking link will be generated for the provided email address. Share the display code and booking URL with the user in your reply.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: {
          type: 'string',
          description: 'The email address of the user to issue the voucher to',
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'initiate_reschedule',
    description: 'Signal that a reschedule is needed for a confirmed appointment. Call this BEFORE sending any emails when either the client or therapist requests a time change. This clears the current confirmed date so the system knows rescheduling is in progress. Do NOT call this for non-rescheduling requests like missing meeting links, session questions, or general acknowledgments.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason for the reschedule (e.g., "Client requested to move to a different day", "Therapist no longer available at confirmed time")',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'flag_for_human_review',
    description: 'Flag this conversation for human review when you are uncertain how to proceed, the situation is unusual, or you need guidance. This enables human control mode so an admin can review and respond. Use this proactively when unsure rather than guessing or stalling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation of why you are flagging this for review and what you are uncertain about',
        },
        suggested_action: {
          type: 'string',
          description: 'Your best guess at what the next action should be (optional - helps the admin understand your thinking)',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'remember',
    description:
      'Record an observation about this conversation that you would want a colleague taking it over to know. Use sparingly: only for things that are NOT already obvious from the message log and are NOT scheduling primitives like proposed times or blockers (those are auto-extracted). Good examples: a stated communication preference ("user prefers single-line emails"), a recurring constraint ("therapist responds before 10am UK"), situational context ("user mentioned a job interview Friday"), or an explicit decision ("agreed to switch to weekly Mondays"). The system retains up to 20 notes per conversation and evicts the oldest. Re-call this tool with a corrected note if a previous one is wrong or stale — duplicate text on the same conversation is silently deduped. Do NOT include therapy-clinical content; this is for scheduling continuity only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        note: {
          type: 'string',
          description: 'The observation to retain. One sentence is ideal. Maximum 280 characters.',
        },
        category: {
          type: 'string',
          enum: ['preference', 'constraint', 'context', 'decision'],
          description: 'preference = stated style or preference; constraint = recurring fixed obligation; context = situational background; decision = an agreement made.',
        },
      },
      required: ['note', 'category'],
    },
  },
  {
    name: 'record_booking_link',
    description:
      "Record the therapist's direct booking link (Calendly, Acuity, YouCanBook.me, SavvyCal, or any other scheduling-tool URL) when they share one during the conversation. Use this whenever they mention a link like 'You can book me at calendly.com/...', 'My scheduling page is https://...', or similar. The link is the richest form of availability we can capture — once it's on file, future bookings will see it automatically. Always overwrites the existing link if there is one (most recent intent wins). After capturing the link, still forward it to the client (per the booking-link workflow above) so they can use it directly.",
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            'The full booking-link URL exactly as the therapist shared it, including the scheme (https://). The executor stores it verbatim and validates it is a parseable URL.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'record_availability_window',
    description:
      'Record an episodic / one-off availability window that someone mentioned in conversation, alongside the therapist\'s recurring base schedule. Use this when you see relative or partial availability phrasings like "I can do Mondays for the next two weeks", "I\'m free this Friday afternoon", "I\'m out the week of the 15th", or "after the school holidays I\'ll have more time". Use resolve_local_time FIRST to compute starts_at and ends_at from the calendar date + wall-clock time + timezone — do NOT invent the offset yourself. Past windows are filtered out automatically when the prompt is rebuilt; do NOT submit windows whose endsAt is already in the past. Use status="available" for offered slots and status="unavailable" for explicit blocks/holidays. ROUTING: source="therapist" windows are stored on the therapist\'s permanent record so future bookings see them too; source="user" windows are scoped to THIS booking only (a user\'s "I\'m out next week" doesn\'t apply to other bookings).',
    input_schema: {
      type: 'object' as const,
      properties: {
        starts_at: {
          type: 'string',
          description: 'Absolute start of the window in ISO 8601 with offset, e.g. "2026-02-03T10:00:00+00:00". Use the value returned by resolve_local_time verbatim; do not edit the offset.',
        },
        ends_at: {
          type: 'string',
          description: 'Absolute end of the window in ISO 8601 with offset. Use the value returned by resolve_local_time verbatim. Must be strictly after starts_at and not entirely in the past.',
        },
        status: {
          type: 'string',
          enum: ['available', 'unavailable'],
          description: 'available = an open slot the therapist (or user) offered; unavailable = an explicit block / holiday / out-of-office.',
        },
        source: {
          type: 'string',
          enum: ['therapist', 'user'],
          description: 'Who said it. Usually \'therapist\', but the user can also note their own absences.',
        },
        quote: {
          type: 'string',
          description: 'The original phrase from the email, verbatim. Helps later turns and admins verify your date resolution. Maximum 280 characters.',
        },
      },
      required: ['starts_at', 'ends_at', 'status', 'source', 'quote'],
    },
  },
  {
    name: 'record_user_timezone',
    description:
      "Persist the client's IANA timezone on their User record. Call this when you've determined what timezone the client is actually in — typically after asking them which city/region they're based in, when the Timezones section above flags their country as having multiple zones. Map their stated location (e.g. \"San Francisco\", \"NYC\", \"Brisbane\") to the matching IANA zone from the country's list shown in the Timezones section, and pass that here. After this call, every subsequent confirmation/reminder email to the client quotes times in this zone. Once recorded, you do NOT need to ask again on subsequent turns.",
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: {
          type: 'string',
          description:
            'IANA timezone identifier the client confirmed (e.g. "America/Los_Angeles", "Australia/Sydney"). MUST be a real IANA zone — the executor validates via Intl.DateTimeFormat and rejects unknown strings. Prefer a zone from the country\'s timezone list shown in the Timezones section.',
        },
      },
      required: ['timezone'],
    },
  },
  {
    name: 'record_therapist_timezone',
    description:
      "Persist the therapist's IANA timezone on their Therapist record. Call this once you know which region they're in — typically after asking them, when their country has multiple zones (US, AU, CA, ...) and we don't yet have a stamped zone on file. The recorded zone becomes the canonical signal for: (a) interpreting future bare wall-clock times they mention, (b) formatting emails to them, (c) stamping a recurring schedule via update_therapist_availability. Once recorded, you do NOT need to ask again on subsequent turns.",
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: {
          type: 'string',
          description:
            'IANA timezone identifier the therapist confirmed (e.g. "America/New_York", "Pacific/Auckland"). MUST be a real IANA zone — the executor validates via Intl.DateTimeFormat and rejects unknown strings. Prefer a zone from the country\'s timezone list shown in the Timezones section.',
        },
      },
      required: ['timezone'],
    },
  },
];
