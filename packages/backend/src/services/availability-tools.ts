/**
 * Tool surface for the availability-collection agent.
 *
 * Distinct from `schedulingTools` in agent-tool-loop.ts — the booking
 * agent has a richer surface (send_email, cancel_appointment,
 * mark_scheduling_complete, …) because it's mediating a bilateral
 * negotiation between client and therapist. This agent only ever
 * speaks to the therapist about THEIR availability, so the tool set
 * is intentionally smaller:
 *
 *   - record_availability_window: capture a one-off window the
 *     therapist mentioned. Same input shape as the booking agent's
 *     tool of the same name (`recordAvailabilityWindowInputSchema`),
 *     but the executor writes to `Therapist.upcomingAvailability` —
 *     per-therapist storage — instead of per-appointment memory.
 *   - remember: soft observations the agent wants to retain across
 *     turns (e.g. "therapist asked us to email at 9am their time").
 *     Storage layer is the same agent-memory module the booking
 *     agent uses, just scoped to the TherapistConversation.
 *   - mark_complete: terminate the conversation when the agent has
 *     captured enough availability info — sets the conversation
 *     status to `completed` and stops the loop.
 *   - flag_for_human_review: escalate to admin and pause automation.
 *
 * Phase 2 deliberately ships NO email tool. The agent can decide
 * what it wants to do (record windows, mark complete, escalate),
 * but the actual outbound send_email path lands in phase 3 when the
 * onboarding & nudge flows wire up. Until then, the agent's text
 * output is captured into conversationState but not transmitted.
 */

import Anthropic from '@anthropic-ai/sdk';

export const availabilityTools: Anthropic.Tool[] = [
  {
    name: 'record_availability_window',
    description:
      'Capture an upcoming availability window the therapist has shared. Use this whenever they mention specific times they can offer for client sessions, e.g. "I can take new clients Tuesday and Thursday afternoons", "I have openings the week of the 22nd", or "I\'m out the first week of August so don\'t book me then". Resolve relative phrasing ("next week", "the week of the 15th") to absolute ISO 8601 timestamps yourself using today\'s date — the system stores what you submit verbatim, so the meaning won\'t drift if the conversation continues for days. Use status="available" for offered slots and status="unavailable" for explicit blocks/holidays. Past windows are filtered automatically; do NOT submit windows whose endsAt is already in the past. The quote field captures the original phrasing so an admin can verify your date resolution.',
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
 * `flag_for_human_review` is here because flipping `humanControlEnabled`
 * is a meaningful state change that future inbound emails will gate on;
 * we want the conversation row to reflect that flip even if the rest of
 * the loop crashes.
 */
export const AVAILABILITY_SIDE_EFFECT_TOOLS = new Set([
  'record_availability_window',
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
