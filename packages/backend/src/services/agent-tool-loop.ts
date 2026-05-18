/**
 * Agent Tool Loop
 *
 * Extracted from justin-time.service.ts where the same ~130-line tool loop
 * was duplicated between startScheduling() and processEmailReply(). Both
 * methods follow the identical pattern:
 *
 *   1. Call Claude API with messages + tools
 *   2. Extract tool calls and text from response
 *   3. Execute each tool call, collecting results
 *   4. Update checkpoint state based on tool results
 *   5. Handle flag_for_human_review by stopping the loop
 *   6. Feed tool results back to Claude and repeat (up to MAX_TOOL_ITERATIONS)
 *
 * The only differences were:
 *   - processEmailReply checkpoints state to DB before side-effecting tools
 *   - Log message context strings ("startScheduling" vs "processEmailReply")
 *
 * This module parameterizes those differences and provides one reusable loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicClient } from '../utils/anthropic-client';
import { CLAUDE_MODELS, MODEL_CONFIG } from '../config/models';
import { logger } from '../utils/logger';
import { resilientCall } from '../utils/resilient-call';
import { circuitBreakerRegistry, CIRCUIT_BREAKER_CONFIGS } from '../utils/circuit-breaker';
import {
  type ConversationCheckpoint,
  type ConversationAction,
  type ConversationStage,
  createCheckpoint,
  updateCheckpoint,
  stageFromAction,
  wouldRegress,
} from '../services/conversation-checkpoint.service';
import { truncateMessageContent } from './ai-conversation.service';
import { auditEventService } from './audit-event.service';
import { getSettingValue } from './settings.service';
// `PURE_TOOLS` lives in `core/agent/tools/pure-tools.ts` so the
// dispatcher (which bypasses the human-control gate + idempotency
// mark for pure tools) and this loop (which bypasses the turn
// budget) agree about the set. See that module for the full rationale.
import { PURE_TOOLS } from '../core/agent/tools/pure-tools';
import { getToolsForStage } from './tools-for-stage';
import {
  appendToolRoundTrip,
  buildBudgetExhaustedMessage,
  buildErrorBreakerAdminMessage,
  buildErrorBreakerFlagReason,
  buildMaxIterationsAdminMessage,
  buildMaxIterationsFlagReason,
  buildSameHashAbortMessage,
  buildSameHashBlockedMessage,
  buildSkipMessage,
  buildTurnBreakerReason,
  computeTurnHash,
  parseClaudeResponse,
} from './tool-loop-helpers';
import type { ToolExecutionResult, SchedulingContext } from './scheduling-context.service';
import type { ConversationState } from '../types';
import {
  availabilityTools,
  AVAILABILITY_SIDE_EFFECT_TOOLS,
  AVAILABILITY_TERMINAL_TOOLS,
} from '../domain/scheduling/availability/agent/tools';

const MAX_TOOL_ITERATIONS = 5;

/** Cumulative tool-call failures within a single runToolLoop invocation
 *  that trip the error circuit breaker. Three failures in one turn is the
 *  agent thrashing on a real problem (validation errors, transient outages,
 *  prompt-injection driving impossible tool calls). Better to escalate
 *  than keep retrying. */
const TURN_ERROR_LIMIT = 3;

/** Maximum tool-call attempts across a single runToolLoop invocation.
 *  Closes the "5 iterations × N tool_use blocks per iteration" amplification
 *  that lets one inbound trigger push 30+ calls into the per-appointment
 *  lifecycle counter. Generous enough for a realistic turn — e.g.
 *  remember + record_availability_window + send_email + record_booking_link
 *  + a follow-up email — but well below any plausible legitimate need.
 *
 *  Sized at 12 (was 8) to accommodate therapist replies that list many
 *  one-off availability windows in a single message — each window is one
 *  `record_availability_window` call, and operators reported the prior
 *  budget tripping on ~5-date replies once `resolve_local_time` calls
 *  were also counted. With pure tools now exempt (see `PURE_TOOLS`
 *  below) the new budget gates ~12 state-changing calls per turn.
 *  Loop-style runaway is still caught by the SAME_HASH_TURN_ABORT
 *  guard, not by this budget. */
const TURN_TOOL_BUDGET = 12;

/** Number of times the same (toolName, input) hash can appear within one
 *  runToolLoop invocation before the loop aborts. 1st: executes. 2nd:
 *  short-circuited with a directive telling the model to try something
 *  else or call flag_for_human_review. 3rd: loop aborts and escalates.
 *  Catches the dominant cause of ceiling trips — idempotent retries and
 *  injection-driven repeated calls. */
const SAME_HASH_TURN_ABORT = 3;

const claudeCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.CLAUDE_API);

// Pure helpers (computeTurnHash, buildSkipMessage, parseClaudeResponse,
// the turn-guard message builders, and appendToolRoundTrip) live in
// tool-loop-helpers.ts so they can be unit-tested without dragging in
// the loop's anthropic + prisma + settings module graph.

/**
 * Shared Anthropic call shape used by both tool loops. Centralises model
 * selection, max_tokens, and circuit-breaker config so changing any of
 * them is a one-line edit. Stays in this module (not in tool-loop-helpers)
 * because it imports anthropic + circuit-breaker — the helpers file is
 * deliberately import-free of runtime side-effects so its tests stay fast.
 *
 * `system` accepts either a plain string (booking loop) or a
 * `TextBlockParam[]` (availability loop, which uses cache_control on the
 * stable system + tool prefix). The Anthropic SDK accepts both shapes.
 */
async function callAgentClaude(args: {
  system: string | Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  context: string;
  traceId: string;
}): Promise<Anthropic.Message> {
  return resilientCall(
    () =>
      anthropicClient.messages.create({
        model: CLAUDE_MODELS.AGENT,
        max_tokens: MODEL_CONFIG.agent.maxTokens,
        system: args.system,
        tools: args.tools,
        messages: args.messages,
      }),
    { context: args.context, traceId: args.traceId, circuitBreaker: claudeCircuitBreaker },
  );
}

/** Scheduling tools definition — passed to Claude */
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
          enum: [
            'request_availability',
            'send_options',
            'confirm_slot_with_therapist',
            'request_more_availability',
            'acknowledge',
            'other',
          ],
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
    description: "Mark the scheduling as complete and send final confirmation emails to both parties. Use this AFTER the therapist confirms they will send the meeting link.\n\nPREFERRED CALL SHAPE: supply the structured form — `timezone` + `year` + `month` + `day` + `hour` + `minute` — and the executor synthesises the canonical ISO 8601 datetime via the same DST-aware path resolve_local_time uses. Use Europe/London (UK time) as the timezone in line with the 'Database / source of truth' rule from the Timezones section.\n\nLEGACY CALL SHAPE: pass `confirmed_datetime` as a freeform string like \"Monday 3rd February at 10:00am\". Kept for backward compatibility; chrono-parsed downstream. Prefer the structured form for new calls — it eliminates a class of date-resolution errors.",
    input_schema: {
      type: 'object' as const,
      properties: {
        confirmed_datetime: {
          type: 'string',
          description: 'LEGACY: the confirmed appointment date and time as a freeform string (e.g., "Monday 3rd February at 10:00am"). Provide this OR the structured form (timezone+year+month+day+hour+minute), not both.',
        },
        timezone: {
          type: 'string',
          description: 'PREFERRED: IANA timezone of the confirmed time. Use "Europe/London" — appointment times are canonical in UK time per the Timezones section.',
        },
        year: { type: 'number', description: 'PREFERRED: four-digit year of the confirmed appointment.' },
        month: { type: 'number', description: 'PREFERRED: month 1-12 of the confirmed appointment.' },
        day: { type: 'number', description: 'PREFERRED: day of month 1-31 of the confirmed appointment.' },
        hour: { type: 'number', description: 'PREFERRED: hour 0-23 of the confirmed appointment (UK time).' },
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

/** Tools whose execution produces external side effects (DB mutations, emails).
 *  checkpointBeforeSideEffects() is called before these to ensure conversation state
 *  is persisted, so a crash mid-execution doesn't lose prior agent work. */
const SIDE_EFFECT_TOOLS = new Set([
  'send_email',
  'mark_scheduling_complete',
  'flag_for_human_review',
  'recommend_cancel_match',
  'cancel_appointment',
  'initiate_reschedule',
  'update_therapist_availability',
  'record_booking_link',
  'issue_voucher_code',
]);

// Stage-gated tool surface lives in tools-for-stage.ts to keep the matrix
// a pure function — easier to unit-test without dragging in the loop's
// anthropic + prisma + settings module graph.

export interface ExecutedTool {
  toolName: string;
  emailSentTo?: 'user' | 'therapist';
  timestamp: string;
}

export interface ToolLoopCallbacks {
  /** Execute a single tool call. Provided by JustinTimeService. */
  executeToolCall: (toolCall: Anthropic.ToolUseBlock, context: SchedulingContext) => Promise<ToolExecutionResult>;
  /** Optional: checkpoint state before side-effecting tools (used by processEmailReply) */
  checkpointBeforeSideEffects?: () => Promise<void>;
  /** Optional: server-side escalation when the loop detects a runaway
   *  condition (e.g. TURN_ERROR_LIMIT tripped) without the agent having
   *  called flag_for_human_review itself. Implementations should flip
   *  humanControlEnabled on the appointment so subsequent inbound mail
   *  doesn't resume the loop. */
  flagForHumanReview?: (reason: string) => Promise<void>;
}

export interface ToolLoopResult {
  /** Number of loop iterations completed */
  iterations: number;
  /** Total tool errors encountered */
  totalToolErrors: number;
  /** Tools that were successfully executed (for compensation tracking) */
  executedTools: ExecutedTool[];
  /** Whether the loop was terminated by flag_for_human_review */
  flaggedForHumanReview: boolean;
  /** Whether max iterations were hit */
  hitMaxIterations: boolean;
}

/**
 * Run the Claude tool loop.
 *
 * Calls Claude with the given messages and tools, executes tool calls,
 * feeds results back to Claude, and repeats until Claude stops calling tools
 * or we hit MAX_TOOL_ITERATIONS.
 *
 * @param systemPrompt - The system prompt for Claude
 * @param messages - Initial messages for Claude
 * @param conversationState - Mutable state object (messages are appended in-place)
 * @param context - Scheduling context
 * @param callbacks - Tool execution and checkpoint callbacks
 * @param traceId - Trace ID for log correlation
 * @param logContext - Context string for log messages (e.g., "startScheduling")
 * @returns Final messagesForClaude array (for callers that need it) and loop result
 */
export async function runToolLoop(
  systemPrompt: string,
  initialMessages: Anthropic.MessageParam[],
  conversationState: ConversationState,
  context: SchedulingContext,
  callbacks: ToolLoopCallbacks,
  traceId: string,
  logContext: string,
): Promise<{ messages: Anthropic.MessageParam[]; result: ToolLoopResult }> {
  // Bootstrap checkpoint when entering the loop without one.
  //
  // `justin-time.service.ts` initialises checkpoint for first-contact
  // runs, but inbound-reply runs load whatever's in conversationState —
  // legacy rows pre-instrumentation, or rows where a prior iteration
  // returned text-only with no tool call (no checkpointAction → no
  // stage write at line ~654 below). Without this guard, the loop's
  // end-of-turn `storeConversationState` writes a null `checkpoint.stage`
  // back to the denormalised column, which trumps the schema default
  // and re-surfaces the "Awaiting next message" fallback on the
  // dashboard. Setting the floor here keeps the column non-null even
  // if no tool fires this turn.
  if (!conversationState.checkpoint) {
    conversationState.checkpoint = createCheckpoint('initial_contact', null);
  }

  let messagesForClaude = [...initialMessages];
  let iteration = 0;
  let totalToolErrors = 0;
  const executedTools: ExecutedTool[] = [];
  let flaggedForHumanReview = false;

  // Turn-scope counters for the budget + same-hash guards. Both live in
  // this closure so they cumulate across iterations within one runToolLoop
  // invocation but reset cleanly per invocation.
  let toolsThisTurn = 0;
  const turnHashCounts = new Map<string, number>();
  let budgetExhausted = false;
  let sameHashAborted = false;

  // Set to true when the loop exits because Claude returned no tool calls
  // (the canonical "I'm done" signal). Used to distinguish a natural finish
  // from an iteration-cap exhaustion in the post-loop block — iteration may
  // legitimately equal MAX_TOOL_ITERATIONS on the last natural-exit
  // iteration, but only the cap-exhaustion case should escalate.
  let loopFinishedNaturally = false;

  // Read the stage-gate setting once per invocation. The tool surface is
  // still re-derived per iteration (since the checkpoint can advance
  // mid-loop), but the on/off switch is stable within a single inbound.
  // Falls open to false on settings failure — narrower is the behaviour
  // change, full surface is the safe default.
  let stageGatedToolsEnabled = false;
  try {
    stageGatedToolsEnabled = await getSettingValue<boolean>('agent.stageGatedTools');
  } catch (err) {
    logger.warn(
      { err, traceId, appointmentRequestId: context.appointmentRequestId },
      `${logContext} - Failed to read agent.stageGatedTools setting; defaulting to full tool surface`,
    );
  }

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    logger.debug(
      { traceId, appointmentRequestId: context.appointmentRequestId, iteration },
      `${logContext} - Claude API call iteration`
    );

    // Re-derive the tool surface every iteration: the checkpoint can
    // advance during the loop (e.g. send_email → awaiting_user_slot_selection)
    // and a narrower tool set may apply to the next Claude call.
    const tools = stageGatedToolsEnabled
      ? getToolsForStage(
          conversationState.checkpoint?.stage as ConversationStage | undefined,
          schedulingTools,
        )
      : schedulingTools;

    const response = await callAgentClaude({
      system: systemPrompt,
      tools,
      messages: messagesForClaude,
      context: logContext,
      traceId,
    });

    const { toolCalls, assistantText } = parseClaudeResponse(response);

    // Save assistant response to conversation state
    if (assistantText) {
      conversationState.messages.push({
        role: 'assistant',
        content: truncateMessageContent(assistantText),
      });
    }

    // If no tool calls, Claude is done
    if (toolCalls.length === 0) {
      logger.info(
        { traceId, appointmentRequestId: context.appointmentRequestId, iterations: iteration },
        `${logContext} - Claude finished responding (no more tool calls)`
      );
      loopFinishedNaturally = true;
      break;
    }

    // Checkpoint before side-effecting tools (if callback provided)
    const hasSideEffects = toolCalls.some(tc => SIDE_EFFECT_TOOLS.has(tc.name));
    if (hasSideEffects && callbacks.checkpointBeforeSideEffects) {
      await callbacks.checkpointBeforeSideEffects();
    }

    // Execute tools and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let stopLoop = false;

    for (const toolCall of toolCalls) {
      let toolResult: string;
      let isError = false;

      // Pure tools (compute-only, no side effects) bypass the turn
      // budget. See PURE_TOOLS for the contract — `resolve_local_time`
      // is prompted before EVERY `record_availability_window`, so
      // counting it doubled the budget pressure on multi-date
      // therapist replies. Excluding it gates the budget on
      // state-changing calls only.
      const isPureTool = PURE_TOOLS.has(toolCall.name);

      // Turn budget guard. Once exhausted, push a synthetic result for
      // every remaining tool_use block in this iteration (Anthropic
      // requires one result per use) but do not execute. The trip is
      // flagged after the for-loop completes.
      if (!isPureTool && toolsThisTurn >= TURN_TOOL_BUDGET) {
        budgetExhausted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: buildBudgetExhaustedMessage(toolCall.name, TURN_TOOL_BUDGET),
          is_error: false,
        });
        // Audit the short-circuit. The executor never sees this tool_use
        // block, so without this the only signal that something was
        // suppressed lives in the assistant message; the audit log lets a
        // post-incident triage break "51/50" down by bucket.
        auditEventService.logToolExecuted(context.appointmentRequestId, {
          traceId,
          toolName: toolCall.name,
          result: 'skipped',
          bucket: 'turn_budget_exhausted',
        });
        continue;
      }

      // Same-hash-in-turn guard. 1st occurrence executes; 2nd is
      // short-circuited with a directive (model gets one chance to
      // pivot); SAME_HASH_TURN_ABORT-th aborts the loop entirely.
      const turnHash = computeTurnHash(toolCall.name, toolCall.input);
      const seenCount = (turnHashCounts.get(turnHash) ?? 0) + 1;
      turnHashCounts.set(turnHash, seenCount);

      if (seenCount >= SAME_HASH_TURN_ABORT) {
        sameHashAborted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: buildSameHashAbortMessage(toolCall.name, seenCount),
          is_error: false,
        });
        auditEventService.logToolExecuted(context.appointmentRequestId, {
          traceId,
          toolName: toolCall.name,
          result: 'skipped',
          bucket: 'same_hash_aborted',
        });
        continue;
      }

      if (seenCount > 1) {
        // 2nd occurrence: skip with directive, still costs a budget slot
        // for state-changing tools (a tool_use block was emitted and
        // answered). Pure tools don't tick the budget — their result
        // is deterministic, so a repeat call is just wasted compute.
        if (!isPureTool) toolsThisTurn++;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: buildSameHashBlockedMessage(toolCall.name),
          is_error: false,
        });
        auditEventService.logToolExecuted(context.appointmentRequestId, {
          traceId,
          toolName: toolCall.name,
          result: 'skipped',
          bucket: 'same_hash_blocked',
        });
        continue;
      }

      // First occurrence — execute. Increment before the call so a thrown
      // exception still counts against the budget. Pure tools (see
      // PURE_TOOLS) don't count — they're side-effect-free and the
      // prompt mandates calling `resolve_local_time` once per window
      // recorded, which doubles the budget hit on multi-date replies.
      if (!isPureTool) toolsThisTurn++;
      const result = await callbacks.executeToolCall(toolCall, context);

      if (result.success) {
        if (result.skipped) {
          toolResult = buildSkipMessage(result.toolName, result.skipReason);
        } else {
          toolResult = result.resultMessage || `Tool ${result.toolName} executed successfully.`;

          executedTools.push({
            toolName: result.toolName,
            emailSentTo: result.emailSentTo,
            timestamp: new Date().toISOString(),
          });

          // Merge response tracking into conversation state (therapist email timing).
          // This is done here instead of inside sendEmail to avoid a mid-loop state
          // save that would invalidate the optimistic lock version.
          if (result.responseTracking) {
            conversationState.responseTracking = {
              ...conversationState.responseTracking,
              ...result.responseTracking,
            };
          }

          // Update checkpoint after successful tool execution
          if (result.checkpointAction) {
            // Explicit annotation: the runToolLoop entry-side bootstrap
            // mutates `conversationState.checkpoint`, which knocks TS's
            // narrowing here back to implicit `any` (TS7022) without it.
            const currentCheckpoint: ConversationCheckpoint | undefined =
              conversationState.checkpoint;
            const newStage = stageFromAction(result.checkpointAction);

            // Prevent send_email from regressing the checkpoint stage —
            // EXCEPT when the agent declared a purpose that makes the
            // regression intentional. The guard was originally added
            // for courtesy emails ("Thanks, I've forwarded your dates")
            // that would otherwise flip the stage backward and mis-route
            // the chaser. With the explicit `purpose` parameter on
            // send_email, we can now distinguish:
            //
            //   - 'request_more_availability': user rejected slots,
            //     agent is genuinely going BACK to the therapist for
            //     more. The regression IS the intent. Allow it.
            //   - 'acknowledge': courtesy reply, stage MUST NOT change.
            //     The handler already returns checkpointAction=undefined
            //     for this case so this branch isn't reached.
            //   - undefined / other purposes / no purpose: legacy
            //     behaviour — guard against the original courtesy-email
            //     regression bug.
            const isIntentionalRegression =
              result.emailPurpose === 'request_more_availability';
            const isRegression = !isIntentionalRegression &&
              currentCheckpoint &&
              result.toolName === 'send_email' &&
              wouldRegress(currentCheckpoint.stage as ConversationStage, newStage);

            if (isRegression) {
              // Don't change the stage, but still update lastEmailSentTo context
              // so the fallback chase logic has accurate tracking
              if (result.emailSentTo) {
                conversationState.checkpoint = {
                  ...currentCheckpoint!,
                  context: {
                    ...currentCheckpoint!.context,
                    lastEmailSentTo: result.emailSentTo,
                  },
                };
              }

              logger.info(
                {
                  traceId,
                  appointmentRequestId: context.appointmentRequestId,
                  currentStage: currentCheckpoint!.stage,
                  blockedStage: newStage,
                  action: result.checkpointAction,
                  emailSentTo: result.emailSentTo,
                },
                `${logContext} - Blocked checkpoint regression from send_email, updated context only`
              );
            } else {
              const updatedCheckpoint = updateCheckpoint(
                currentCheckpoint || null,
                result.checkpointAction,
                null,
                result.emailSentTo ? { lastEmailSentTo: result.emailSentTo } : undefined
              );
              conversationState.checkpoint = updatedCheckpoint;

              logger.info(
                {
                  traceId,
                  appointmentRequestId: context.appointmentRequestId,
                  action: result.checkpointAction,
                  newStage: updatedCheckpoint.stage,
                },
                `${logContext} - Checkpoint updated after tool execution`
              );
            }
          }
        }

        // Tools that enable human control stop the loop to prevent
        // the agent from taking further actions on a paused conversation.
        if ((toolCall.name === 'flag_for_human_review' || toolCall.name === 'recommend_cancel_match') && !result.skipped) {
          const reason = toolCall.name === 'recommend_cancel_match'
            ? 'Agent recommended cancelling match — stopping tool loop'
            : 'Agent flagged for human review — stopping tool loop';
          logger.info(
            { traceId, appointmentRequestId: context.appointmentRequestId },
            `${logContext} - ${reason}`
          );
          conversationState.messages.push({
            role: 'admin' as const,
            content: toolCall.name === 'recommend_cancel_match'
              ? '[System: Match cancellation recommended. Agent processing paused pending admin review.]'
              : '[System: Conversation flagged for human review. Agent processing paused.]',
          });
          flaggedForHumanReview = true;
          stopLoop = true;
          break;
        }
      } else {
        toolResult = `Error: ${result.error}`;
        isError = true;
        totalToolErrors++;
        logger.error(
          { traceId, tool: result.toolName, error: result.error },
          `${logContext} - Tool execution failed`
        );
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: toolResult,
        is_error: isError,
      });
    }

    // Turn-level circuit breakers: budget exhaustion or same-hash abort.
    // Both trip after the inner for-loop so all tool_results for this
    // iteration are collected (Anthropic requires one result per use)
    // before the while loop exits without feeding them back to Claude.
    if (!stopLoop && !flaggedForHumanReview && (budgetExhausted || sameHashAborted)) {
      const reason = buildTurnBreakerReason(
        budgetExhausted ? 'budget' : 'same_hash',
        { budget: TURN_TOOL_BUDGET, sameHashAbortLimit: SAME_HASH_TURN_ABORT },
      );
      logger.warn(
        {
          traceId,
          appointmentRequestId: context.appointmentRequestId,
          toolsThisTurn,
          iteration,
          budgetExhausted,
          sameHashAborted,
          bucket: budgetExhausted ? 'turn_budget_exhausted' : 'same_hash_aborted',
        },
        `${logContext} - Turn-level circuit breaker tripped — ${reason}`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: `[System: ${reason}]`,
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(reason);
        } catch (flagErr) {
          logger.error(
            { traceId, appointmentRequestId: context.appointmentRequestId, err: flagErr },
            `${logContext} - Failed to flag for human review at turn-level breaker`,
          );
        }
      }
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    // Error circuit breaker: TURN_ERROR_LIMIT failures within a single
    // runToolLoop invocation indicates the agent is thrashing — either a
    // genuinely broken tool, an impossible request, or prompt-injection
    // pushing impossible inputs. Escalate to human control rather than
    // continue iterating and burning the per-appointment tool ceiling.
    // Checked after the inner for-loop so all tool_results from this
    // iteration are still collected for logging, then the while loop
    // exits without sending them back to Claude (same pattern as
    // flag_for_human_review).
    if (!stopLoop && !flaggedForHumanReview && totalToolErrors >= TURN_ERROR_LIMIT) {
      logger.warn(
        {
          traceId,
          appointmentRequestId: context.appointmentRequestId,
          totalToolErrors,
          limit: TURN_ERROR_LIMIT,
          iteration,
          bucket: 'error',
        },
        `${logContext} - Tool error circuit breaker tripped — stopping loop and flagging for review`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: buildErrorBreakerAdminMessage(totalToolErrors),
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(buildErrorBreakerFlagReason(totalToolErrors));
        } catch (flagErr) {
          logger.error(
            { traceId, appointmentRequestId: context.appointmentRequestId, err: flagErr },
            `${logContext} - Failed to flag for human review at circuit breaker`,
          );
        }
      }
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    if (stopLoop) {
      break;
    }

    // Feed tool results back to Claude for the next iteration
    messagesForClaude = appendToolRoundTrip(messagesForClaude, response, toolResults);

    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId, toolCount: toolCalls.length, iteration },
      `${logContext} - Tools executed, continuing conversation with results`
    );
  }

  // Iteration-ceiling escalation. Mirrors the budget / same-hash / error-
  // breaker blocks inside the while-loop: log + admin message + flag for
  // human review. Only fires when the cap was reached with the agent still
  // working (toolCalls on the last iteration); a natural finish on
  // iteration MAX is NOT a runaway and should not escalate. Without this
  // the loop just exited silently and the user saw whatever mid-thought
  // Claude managed to emit before iterations ran out.
  if (
    iteration >= MAX_TOOL_ITERATIONS &&
    !flaggedForHumanReview &&
    !loopFinishedNaturally
  ) {
    const reason = buildMaxIterationsFlagReason(MAX_TOOL_ITERATIONS);
    logger.warn(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        iterations: iteration,
        bucket: 'max_iterations',
      },
      `${logContext} - Max tool iterations reached without natural completion — flagging for review`,
    );
    conversationState.messages.push({
      role: 'admin' as const,
      content: buildMaxIterationsAdminMessage(MAX_TOOL_ITERATIONS),
    });
    if (callbacks.flagForHumanReview) {
      try {
        await callbacks.flagForHumanReview(reason);
      } catch (flagErr) {
        logger.error(
          { traceId, appointmentRequestId: context.appointmentRequestId, err: flagErr },
          `${logContext} - Failed to flag for human review at iteration ceiling`,
        );
      }
    }
    flaggedForHumanReview = true;
  }

  return {
    messages: messagesForClaude,
    result: {
      iterations: iteration,
      totalToolErrors,
      executedTools,
      flaggedForHumanReview,
      hitMaxIterations: iteration >= MAX_TOOL_ITERATIONS,
    },
  };
}

// ─── Availability-Collection Agent Loop ─────────────────────────────────────
//
// Parallel to runToolLoop but for the slim availability-collection agent.
// Sibling rather than generalisation: the booking loop has scheduling-FSM
// regression checks and a richer side-effect surface (emails, lifecycle
// transitions) that don't apply here. Keeping them as two focused
// functions is easier to reason about than one branching generalisation.
// Adds prompt caching that the booking loop doesn't currently use — the
// system prompt + tool definitions are stable across a conversation, so
// caching them at the last system block cuts cost on every iteration
// after the first.

/** Context for the availability-collection agent. Slim by design: no
 *  client counterpart exists, so no userName / userEmail. */
export interface AvailabilityAgentContext {
  /** TherapistConversation.id. The conversation row is the canonical
   *  state container — same role as appointmentRequestId for the
   *  booking agent. */
  conversationId: string;
  therapistId: string;
  therapistName: string;
  therapistEmail: string;
  therapistCountry: string;
  /** Why this conversation exists; drives prompt phrasing. */
  kind: 'onboarding' | 'nudge_reply';
}

export interface AvailabilityToolLoopCallbacks {
  executeToolCall: (
    toolCall: Anthropic.ToolUseBlock,
    context: AvailabilityAgentContext,
  ) => Promise<ToolExecutionResult>;
  /** Checkpoint conversationState to the DB before any side-effecting
   *  tool runs. Same role as in runToolLoop — protects against losing
   *  the agent's prior work if a write crashes mid-execution. */
  checkpointBeforeSideEffects?: () => Promise<void>;
  /** Server-side escalation when the loop trips its error circuit
   *  breaker. Flips humanControlEnabled on the TherapistConversation so
   *  later inbound mail doesn't resume the loop. */
  flagForHumanReview?: (reason: string) => Promise<void>;
}

export interface AvailabilityToolLoopResult {
  iterations: number;
  totalToolErrors: number;
  executedTools: ExecutedTool[];
  /** True if flag_for_human_review fired — agent paused for admin. */
  flaggedForHumanReview: boolean;
  /** True if mark_complete fired — conversation reached natural end. */
  markedComplete: boolean;
  hitMaxIterations: boolean;
}

/**
 * Minimal mutable state passed into the availability loop. The loop
 * appends assistant messages to `messages` in-place so the orchestrator
 * can persist the final state without us needing to return the array.
 * Mirrors the booking loop's relationship with ConversationState.
 */
export interface AvailabilityConversationState {
  messages: Array<{ role: 'user' | 'assistant' | 'admin'; content: string }>;
}

/**
 * Run the availability-collection tool loop.
 *
 * Iterates up to MAX_TOOL_ITERATIONS, calling Claude with the supplied
 * messages plus the static `availabilityTools` set. Stops early on
 * mark_complete or flag_for_human_review (both terminal for the
 * conversation), or when Claude returns no further tool calls.
 *
 * `conversationState.messages` is mutated in place as assistant turns
 * accumulate; the orchestrator persists it after the loop returns.
 */
export async function runAvailabilityToolLoop(
  systemPrompt: string,
  initialMessages: Anthropic.MessageParam[],
  conversationState: AvailabilityConversationState,
  context: AvailabilityAgentContext,
  callbacks: AvailabilityToolLoopCallbacks,
  traceId: string,
  logContext: string,
): Promise<{ messages: Anthropic.MessageParam[]; result: AvailabilityToolLoopResult }> {
  let messagesForClaude = [...initialMessages];
  let iteration = 0;
  let totalToolErrors = 0;
  const executedTools: ExecutedTool[] = [];
  let flaggedForHumanReview = false;
  let markedComplete = false;

  // Turn-scope counters for the budget + same-hash guards (mirrors the
  // booking loop). Closure-scoped so they cumulate across iterations
  // within one runAvailabilityToolLoop invocation and reset per invocation.
  let toolsThisTurn = 0;
  const turnHashCounts = new Map<string, number>();
  let budgetExhausted = false;
  let sameHashAborted = false;

  // Mirrors the booking loop: true when Claude returns no tool calls (the
  // canonical "I'm done" signal), distinguishing a natural finish from
  // iteration-cap exhaustion in the post-loop block.
  let loopFinishedNaturally = false;

  // cache_control on the system block caches both tool definitions and
  // system prompt (tools render before system in the request prefix).
  // Both are stable for the lifetime of one conversation, so every
  // iteration after the first reads from the cache at ~0.1x cost.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    logger.debug(
      { traceId, conversationId: context.conversationId, iteration },
      `${logContext} - availability agent Claude API call iteration`,
    );

    const response = await callAgentClaude({
      system: systemBlocks,
      tools: availabilityTools,
      messages: messagesForClaude,
      context: logContext,
      traceId,
    });

    const { toolCalls, assistantText } = parseClaudeResponse(response);

    if (assistantText) {
      conversationState.messages.push({
        role: 'assistant',
        content: truncateMessageContent(assistantText),
      });
    }

    if (toolCalls.length === 0) {
      logger.info(
        { traceId, conversationId: context.conversationId, iterations: iteration },
        `${logContext} - availability agent finished responding (no more tool calls)`,
      );
      loopFinishedNaturally = true;
      break;
    }

    const hasSideEffects = toolCalls.some((tc) => AVAILABILITY_SIDE_EFFECT_TOOLS.has(tc.name));
    if (hasSideEffects && callbacks.checkpointBeforeSideEffects) {
      await callbacks.checkpointBeforeSideEffects();
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let stopLoop = false;

    for (const toolCall of toolCalls) {
      let toolResult: string;
      let isError = false;

      // Pure tools (currently just `resolve_local_time`) bypass the
      // budget — see PURE_TOOLS at the top of this file. The prompt
      // mandates calling resolve_local_time before every recorded
      // window, so counting it doubled the budget hit on multi-date
      // therapist replies.
      const isPureTool = PURE_TOOLS.has(toolCall.name);

      // Turn budget guard (mirrors booking loop). The booking loop writes
      // an audit event via auditEventService.logToolExecuted; the
      // availability loop has no equivalent table (audit events are
      // appointment-scoped, this loop runs on TherapistConversation), so
      // we surface the bucket through structured logging instead. Same
      // searchable signal in logs without a schema lift.
      if (!isPureTool && toolsThisTurn >= TURN_TOOL_BUDGET) {
        budgetExhausted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: buildBudgetExhaustedMessage(toolCall.name, TURN_TOOL_BUDGET),
          is_error: false,
        });
        logger.warn(
          {
            traceId,
            conversationId: context.conversationId,
            toolName: toolCall.name,
            bucket: 'turn_budget_exhausted',
          },
          `${logContext} - availability turn budget exhausted on tool ${toolCall.name}`,
        );
        continue;
      }

      // Same-hash-in-turn guard (mirrors booking loop).
      const turnHash = computeTurnHash(toolCall.name, toolCall.input);
      const seenCount = (turnHashCounts.get(turnHash) ?? 0) + 1;
      turnHashCounts.set(turnHash, seenCount);

      if (seenCount >= SAME_HASH_TURN_ABORT) {
        sameHashAborted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: buildSameHashAbortMessage(toolCall.name, seenCount),
          is_error: false,
        });
        logger.warn(
          {
            traceId,
            conversationId: context.conversationId,
            toolName: toolCall.name,
            seenCount,
            bucket: 'same_hash_aborted',
          },
          `${logContext} - availability same-hash abort on tool ${toolCall.name}`,
        );
        continue;
      }

      if (seenCount > 1) {
        // Pure tools don't tick the budget on the 2nd occurrence
        // either — their result is deterministic, so a repeat call
        // is wasted compute, not a budget concern.
        if (!isPureTool) toolsThisTurn++;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: buildSameHashBlockedMessage(toolCall.name),
          is_error: false,
        });
        logger.info(
          {
            traceId,
            conversationId: context.conversationId,
            toolName: toolCall.name,
            seenCount,
            bucket: 'same_hash_blocked',
          },
          `${logContext} - availability same-hash 2nd-occurrence skip on tool ${toolCall.name}`,
        );
        continue;
      }

      // Pure tools (PURE_TOOLS) don't count against the budget. See
      // the top of the file for the rationale.
      if (!isPureTool) toolsThisTurn++;
      const result = await callbacks.executeToolCall(toolCall, context);

      if (result.success) {
        if (result.skipped) {
          toolResult = buildSkipMessage(result.toolName, result.skipReason);
        } else {
          toolResult = result.resultMessage || `Tool ${result.toolName} executed successfully.`;
          executedTools.push({
            toolName: result.toolName,
            emailSentTo: result.emailSentTo,
            timestamp: new Date().toISOString(),
          });
        }

        if (!result.skipped && AVAILABILITY_TERMINAL_TOOLS.has(toolCall.name)) {
          if (toolCall.name === 'flag_for_human_review') {
            flaggedForHumanReview = true;
            conversationState.messages.push({
              role: 'admin',
              content: '[System: Conversation flagged for human review. Agent processing paused.]',
            });
          } else if (toolCall.name === 'mark_complete') {
            markedComplete = true;
            conversationState.messages.push({
              role: 'admin',
              content: '[System: Availability-collection conversation marked complete by agent.]',
            });
          }
          logger.info(
            { traceId, conversationId: context.conversationId, tool: toolCall.name },
            `${logContext} - terminal tool fired, stopping availability loop`,
          );
          stopLoop = true;
        }
      } else {
        toolResult = `Error: ${result.error}`;
        isError = true;
        totalToolErrors++;
        logger.error(
          { traceId, tool: result.toolName, error: result.error },
          `${logContext} - availability tool execution failed`,
        );
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: toolResult,
        is_error: isError,
      });

      if (stopLoop) break;
    }

    // Turn-level circuit breakers (budget / same-hash). Mirror the booking
    // loop and fire before the error breaker so the right cause is logged.
    if (!stopLoop && !flaggedForHumanReview && !markedComplete && (budgetExhausted || sameHashAborted)) {
      const reason = buildTurnBreakerReason(
        budgetExhausted ? 'budget' : 'same_hash',
        { budget: TURN_TOOL_BUDGET, sameHashAbortLimit: SAME_HASH_TURN_ABORT },
      );
      logger.warn(
        {
          traceId,
          conversationId: context.conversationId,
          toolsThisTurn,
          iteration,
          budgetExhausted,
          sameHashAborted,
        },
        `${logContext} - availability turn-level circuit breaker tripped — ${reason}`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: `[System: ${reason}]`,
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(reason);
        } catch (flagErr) {
          logger.error(
            { traceId, conversationId: context.conversationId, err: flagErr },
            `${logContext} - Failed to flag for human review at turn-level breaker`,
          );
        }
      }
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    // Error circuit breaker — mirrors the booking loop. TURN_ERROR_LIMIT
    // failures in one runAvailabilityToolLoop invocation means the agent
    // is thrashing; escalate to human control rather than continue.
    if (!stopLoop && !flaggedForHumanReview && !markedComplete && totalToolErrors >= TURN_ERROR_LIMIT) {
      logger.warn(
        {
          traceId,
          conversationId: context.conversationId,
          totalToolErrors,
          limit: TURN_ERROR_LIMIT,
          iteration,
          bucket: 'error',
        },
        `${logContext} - availability tool error circuit breaker tripped — stopping loop and flagging for review`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: buildErrorBreakerAdminMessage(totalToolErrors),
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(buildErrorBreakerFlagReason(totalToolErrors));
        } catch (flagErr) {
          logger.error(
            { traceId, conversationId: context.conversationId, err: flagErr },
            `${logContext} - Failed to flag for human review at circuit breaker`,
          );
        }
      }
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    if (stopLoop) break;

    messagesForClaude = appendToolRoundTrip(messagesForClaude, response, toolResults);

    logger.info(
      {
        traceId,
        conversationId: context.conversationId,
        toolCount: toolCalls.length,
        iteration,
      },
      `${logContext} - availability tools executed, continuing`,
    );
  }

  // Iteration-ceiling escalation. Mirrors the booking loop: a cap hit
  // with the agent still working is a runaway and should flag for review;
  // a natural finish on the last iteration is not. `markedComplete` is the
  // availability loop's equivalent terminal-tool signal — also exempt.
  if (
    iteration >= MAX_TOOL_ITERATIONS &&
    !flaggedForHumanReview &&
    !markedComplete &&
    !loopFinishedNaturally
  ) {
    const reason = buildMaxIterationsFlagReason(MAX_TOOL_ITERATIONS);
    logger.warn(
      {
        traceId,
        conversationId: context.conversationId,
        iterations: iteration,
        bucket: 'max_iterations',
      },
      `${logContext} - availability agent hit max tool iterations without natural completion — flagging for review`,
    );
    conversationState.messages.push({
      role: 'admin' as const,
      content: buildMaxIterationsAdminMessage(MAX_TOOL_ITERATIONS),
    });
    if (callbacks.flagForHumanReview) {
      try {
        await callbacks.flagForHumanReview(reason);
      } catch (flagErr) {
        logger.error(
          { traceId, conversationId: context.conversationId, err: flagErr },
          `${logContext} - Failed to flag for human review at availability iteration ceiling`,
        );
      }
    }
    flaggedForHumanReview = true;
  }

  return {
    messages: messagesForClaude,
    result: {
      iterations: iteration,
      totalToolErrors,
      executedTools,
      flaggedForHumanReview,
      markedComplete,
      hitMaxIterations: iteration >= MAX_TOOL_ITERATIONS,
    },
  };
}
