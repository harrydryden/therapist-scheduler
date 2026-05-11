/**
 * Tool surface for the availability-collection agent.
 *
 * The agent's role is narrow: it collects upcoming availability from
 * therapists and writes it to the platform. It does NOT propose
 * specific session times, NOT confirm bookings, and NOT negotiate
 * slots — those are strictly the booking agent's responsibilities,
 * which runs separately and reads from what this agent collects.
 *
 *   - send_email: outbound email to the therapist. Recipient is
 *     hardcoded inside the executor (always therapist.email — never
 *     accepts a `to` field from the model). First successful send
 *     stashes Gmail thread + initial message ID back onto the
 *     TherapistConversation row so future inbound replies can be
 *     matched to this conversation.
 *   - record_availability_window: capture a one-off window. Shape
 *     mirrors agent-memory.service.ts's per-appointment windows but
 *     the executor writes to `Therapist.upcomingAvailability` —
 *     per-therapist storage that the booking agent reads when
 *     building its system prompt (see system-prompt-builder.ts).
 *   - record_booking_link: capture the therapist's scheduling-tool
 *     URL (Calendly, Acuity, ...). Writes to `Therapist.bookingLink`,
 *     also read by the booking agent's prompt.
 *   - remember: soft observations the agent retains across turns
 *     (e.g. "therapist asked us to email at 9am their time"). Stored
 *     on `TherapistConversation.memory`.
 *   - mark_complete: terminate the conversation when enough
 *     availability is captured — sets status='completed'.
 *   - flag_for_human_review: escalate to admin and pause automation.
 *
 * Anything booking-related — proposing times, confirming slots,
 * coordinating between parties — is out of scope for this agent.
 * If the therapist tries to drive the conversation that way ("when
 * works for you?"), the agent explains another part of the system
 * will follow up with a specific proposal once availability is on
 * file.
 */

import Anthropic from '@anthropic-ai/sdk';

export const availabilityTools: Anthropic.Tool[] = [
  {
    name: 'send_email',
    description:
      'Send an email to the therapist. The recipient is fixed — you do NOT supply a "to" field. Use this for the introductory outbound, for replies that need to acknowledge something the therapist said, or for clarifying questions about availability. Keep emails short (one or two paragraphs) and direct. Do NOT propose specific session times in the email — that\'s the booking agent\'s job, not yours. If the therapist asks you to pick a time, tell them another part of the system will follow up with a specific proposal once their availability is on file. Sign off as "Justin" on a separate line.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subject: {
          type: 'string',
          description:
            'Subject line. The executor will prepend "Spill" if not already present, so you don\'t need to include it yourself.',
        },
        body: {
          type: 'string',
          description:
            'Plain text body. Write each paragraph as a single continuous line — do NOT insert line breaks within paragraphs. Use blank lines between paragraphs. Email clients handle wrapping.',
        },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: 'record_booking_link',
    description:
      "Record the therapist's direct booking link (Calendly, Acuity, YouCanBook.me, SavvyCal, or any other scheduling tool URL they use). Use this whenever they share a link in their reply, e.g. 'You can book me at calendly.com/...', 'My scheduling page is https://...', or similar. The link is the richest form of availability we can capture — once it's on file, the booking agent can use it directly when a session needs to be scheduled, and we don't need to keep collecting fine-grained time windows. Overwrites any existing link on file (most recent intent wins). If the therapist tells you the link they previously shared is no longer valid, record the new one and they should be set. After capturing a link, you can usually mark_complete sooner — the link covers what individual windows would have.",
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            'The full booking-link URL exactly as the therapist shared it, including the scheme (https://). Do not modify or shorten — the executor stores it verbatim and validates it is a parseable URL.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'record_availability_window',
    description:
      'Capture an upcoming availability window the therapist has shared. Use this whenever they mention specific times they\'re free, e.g. "I\'m free Tuesday and Thursday afternoons", "I have openings the week of the 22nd", or "I\'m out the first week of August so don\'t schedule me then". Resolve relative phrasing ("next week", "the week of the 15th") to absolute ISO 8601 timestamps yourself using today\'s date — the system stores what you submit verbatim, so the meaning won\'t drift if the conversation continues for days. Use status="available" for offered slots and status="unavailable" for explicit blocks/holidays. Past windows are filtered automatically; do NOT submit windows whose endsAt is already in the past. The quote field captures the original phrasing so an admin can verify your date resolution.',
    input_schema: {
      type: 'object' as const,
      properties: {
        starts_at: {
          type: 'string',
          description:
            'Absolute start of the window in ISO 8601 with offset, e.g. "2026-05-19T14:00:00+01:00". Compute from the relative phrasing using today\'s date.',
        },
        ends_at: {
          type: 'string',
          description:
            'Absolute end of the window in ISO 8601 with offset. Must be strictly after starts_at and not entirely in the past.',
        },
        status: {
          type: 'string',
          enum: ['available', 'unavailable'],
          description:
            'available = an open slot the therapist offered; unavailable = an explicit block / holiday / out-of-office.',
        },
        quote: {
          type: 'string',
          description:
            'The original phrase from the email, verbatim. Helps the next turn and admins verify your date resolution. Maximum 280 characters.',
        },
      },
      required: ['starts_at', 'ends_at', 'status', 'quote'],
    },
  },
  {
    name: 'remember',
    description:
      'Record a soft observation about this therapist conversation you would want a colleague taking it over to know. Use sparingly: only for things NOT already obvious from the message log and NOT availability primitives (those go through record_availability_window). Good examples: "therapist asked us to email at 9am their time, not earlier", "therapist mentioned moving offices in March so availability there is provisional", "therapist prefers single-paragraph emails". Do NOT include therapy-clinical content; this is for scheduling continuity only. Re-call with a corrected note if a previous one is wrong; identical text on the same conversation is silently deduped.',
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
          description:
            'preference = stated style or preference; constraint = recurring fixed obligation; context = situational background; decision = an agreement made.',
        },
      },
      required: ['note', 'category'],
    },
  },
  {
    name: 'mark_complete',
    description:
      'End this availability-collection conversation. Call this when the therapist has shared enough upcoming availability for the platform to use, or when they\'ve told us nothing useful is available (e.g. they\'re fully booked / not currently taking new clients) and continuing would be unproductive. Once called, the conversation is marked completed and no further agent processing will occur on this thread. Provide a short summary so admins reviewing later see at a glance what was captured.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description:
            'One-line summary of the outcome, e.g. "Captured 3 weekly windows through end of June" or "Therapist not taking new clients until September — paused".',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'flag_for_human_review',
    description:
      'Flag this conversation for admin review when you are uncertain how to proceed or the situation is outside normal availability collection. Use this proactively rather than guessing or stalling — examples: the therapist asked a question you can\'t answer, they\'re expressing frustration, they want to discuss something other than scheduling, or the reply is ambiguous in a way that matters. Once called, automation pauses until an admin takes over.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description:
            'Clear explanation of why you are flagging this for review and what you are uncertain about.',
        },
        suggested_action: {
          type: 'string',
          description: 'Your best guess at what the next action should be (optional).',
        },
      },
      required: ['reason'],
    },
  },
];

/**
 * Tools that mutate persistent state. The agent loop checkpoints the
 * conversation row before executing any of these so a crash mid-execution
 * doesn't lose progress.
 *
 * `send_email` is here because outbound mail is the most irreversible
 * side effect on the surface — we want the conversation state persisted
 * before we send so that if the send succeeds but the subsequent state
 * update fails, the agent's intent (subject/body it chose) is still
 * recoverable from the last checkpoint.
 *
 * `flag_for_human_review` is here because flipping `humanControlEnabled`
 * is a meaningful state change that future inbound emails will gate on;
 * we want the conversation row to reflect that flip even if the rest of
 * the loop crashes.
 */
export const AVAILABILITY_SIDE_EFFECT_TOOLS = new Set([
  'send_email',
  'record_availability_window',
  'record_booking_link',
  'mark_complete',
  'flag_for_human_review',
]);

/**
 * Tools that should halt the iteration loop after execution. Both
 * `mark_complete` and `flag_for_human_review` are terminal for the
 * conversation — once called the agent shouldn't continue calling more
 * tools on the same turn.
 */
export const AVAILABILITY_TERMINAL_TOOLS = new Set([
  'mark_complete',
  'flag_for_human_review',
]);
