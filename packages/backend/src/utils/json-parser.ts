import { z } from 'zod';
import { logger } from './logger';
import { CONVERSATION_LIMITS } from '../constants';
import type { ConversationState, ResponseTracking, TherapistAvailability } from '../types';
import type { ConversationCheckpoint, ConversationStage } from '../services/conversation-checkpoint.service';
import type { ConversationFacts } from './conversation-facts';

/**
 * PERFORMANCE FIX: Maximum JSON input sizes to prevent memory exhaustion
 * Large JSON inputs can cause DoS by allocating excessive memory during parsing
 */
const JSON_SIZE_LIMITS = {
  DEFAULT: 1_000_000,          // 1MB - general JSON parsing
  // Tied to the writer's cap so the two can't drift: every save trims the
  // state to MAX_STATE_BYTES (UTF-8 bytes, which is never fewer than the
  // string's length), so any state we wrote is readable. The read limit
  // used to be 500,000 — BELOW the 512,000-byte trim limit — so a state
  // between the two was saved fine and then unreadable on every later
  // turn ("Conversation state not found"). 2x leaves headroom for legacy
  // rows written before the cap was enforced on every save; they are
  // trimmed on their next save.
  CONVERSATION_STATE: CONVERSATION_LIMITS.MAX_STATE_BYTES * 2,
  AVAILABILITY: 50_000,        // 50KB - availability data is small
  STRICT: 100_000,             // 100KB - for untrusted inputs
};

/**
 * Zod schemas for JSON validation
 */
const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'admin']),
  content: z.string(),
  timestamp: z.string().optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every ConversationStage, as a runtime set. Typed as a Record so the
 * compiler rejects a missing or misspelt stage when the union changes.
 */
const KNOWN_CONVERSATION_STAGES: Record<ConversationStage, true> = {
  initial_contact: true,
  awaiting_therapist_availability: true,
  awaiting_user_slot_selection: true,
  awaiting_therapist_confirmation: true,
  awaiting_meeting_link: true,
  confirmed: true,
  rescheduling: true,
  cancelled: true,
  stalled: true,
  chased: true,
  closure_recommended: true,
};

export function isConversationStage(value: unknown): value is ConversationStage {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_CONVERSATION_STAGES, value);
}

/**
 * Checkpoint coercion. `stage` is the only load-bearing field (it drives
 * the prompt, the stage-gated tool surface, the regression guard and the
 * denormalised `checkpointStage` column), so it must be a known stage.
 * Everything else — `context.lastEmailSentTo`, `stalled_since`,
 * `recovery_attempts`, future keys — is carried through untouched.
 */
function coerceCheckpoint(value: Record<string, unknown>): ConversationCheckpoint | undefined {
  if (!isConversationStage(value.stage)) return undefined;
  return {
    ...value,
    stage: value.stage,
    lastSuccessfulAction: typeof value.lastSuccessfulAction === 'string'
      ? (value.lastSuccessfulAction as ConversationCheckpoint['lastSuccessfulAction'])
      : null,
    pendingAction: typeof value.pendingAction === 'string' ? value.pendingAction : null,
    checkpoint_at: typeof value.checkpoint_at === 'string' ? value.checkpoint_at : '',
  } as ConversationCheckpoint;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Facts coercion. The array fields are spread/merged by
 * `updateFacts`/`mergeFacts`, which throw on a missing array, so they're
 * normalised to `[]`; scalar fields are kept when they're strings.
 */
function coerceFacts(value: Record<string, unknown>): ConversationFacts {
  return {
    ...value,
    proposedTimes: stringArray(value.proposedTimes),
    therapistPreferences: stringArray(value.therapistPreferences),
    userPreferences: stringArray(value.userPreferences),
    blockers: stringArray(value.blockers),
    specialNotes: stringArray(value.specialNotes),
    selectedTime: typeof value.selectedTime === 'string' ? value.selectedTime : undefined,
    confirmedTime: typeof value.confirmedTime === 'string' ? value.confirmedTime : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  } as ConversationFacts;
}

/**
 * Response-tracking coercion. The type is an open record, so any object
 * is kept; only `events` is normalised because trackTherapistResponseTime
 * pushes onto it.
 */
function coerceResponseTracking(value: Record<string, unknown>): ResponseTracking {
  const tracking: ResponseTracking = { ...value };
  if (tracking.events !== undefined && !Array.isArray(tracking.events)) {
    delete tracking.events;
  }
  return tracking;
}

/**
 * An optional, permissively-validated top-level field of the stored
 * conversation state. Absent / null → undefined. A malformed value drops
 * only that field (and is logged) — it never fails the whole state, which
 * would otherwise throw away the message log with it.
 */
function lenientStateField<T>(field: string, coerce: (value: Record<string, unknown>) => T | undefined) {
  return z.unknown().transform((value): T | undefined => {
    if (value === undefined || value === null) return undefined;
    const coerced = isPlainObject(value) ? coerce(value) : undefined;
    if (coerced === undefined) {
      logger.warn(
        { field, valueType: Array.isArray(value) ? 'array' : typeof value },
        'Dropping malformed conversation-state field',
      );
    }
    return coerced;
  });
}

/**
 * The non-message fields of ConversationState. These MUST be declared:
 * zod objects strip unknown keys by default, and before they were listed
 * here every read silently discarded the agent's checkpoint, extracted
 * facts and therapist response-time tracking — so each turn restarted at
 * `initial_contact` with empty facts, and the next save wrote that back
 * to the denormalised `checkpointStage` column.
 */
const conversationStateExtrasSchema = z.object({
  checkpoint: lenientStateField('checkpoint', coerceCheckpoint),
  facts: lenientStateField('facts', coerceFacts),
  responseTracking: lenientStateField('responseTracking', coerceResponseTracking),
});

const conversationStateSchema = conversationStateExtrasSchema.extend({
  // FIX: systemPrompt is optional — FIX #20 stores it as '' and
  // storeConversationState allows omitting it, so stored JSON may lack the field.
  // Default to '' when missing so downstream code always sees a string.
  systemPrompt: z.string().nullish().transform(v => v ?? ''),
  messages: z.array(conversationMessageSchema),
});

/**
 * A slot is only considered "display-quality" when it has a full
 * weekday name and HH:MM start/end times. Anything looser — "flexible",
 * "Not specified", "null", three-letter abbreviations — used to slip
 * through the old loose schema and surface as garbage strings ("Mon:
 * flexible-flexible") on the public therapist cards.
 *
 * We enforce the contract here at the parser so every read path
 * (public listing, admin dashboard, agent prompt builder, ATS export)
 * sees the same tight shape. Bad slots are filtered out further down;
 * the rest of the record (timezone, exceptions, valid slots) is kept.
 */
const VALID_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const therapistAvailabilitySlotSchema = z.object({
  day: z.enum(VALID_DAY_NAMES),
  start: z.string().regex(TIME_PATTERN, 'expected HH:MM'),
  end: z.string().regex(TIME_PATTERN, 'expected HH:MM'),
});

const therapistAvailabilityExceptionSchema = z.object({
  date: z.string(),
  available: z.boolean(),
});

const therapistAvailabilitySchema = z.object({
  timezone: z.string(),
  slots: z.array(therapistAvailabilitySlotSchema),
  exceptions: z.array(therapistAvailabilityExceptionSchema).optional(),
});

/**
 * FIX A6: Safely parse JSON with optional schema validation
 *
 * If a schema is provided, validates the parsed JSON against it.
 * If validation fails, returns the fallback value.
 *
 * @param json - The JSON string to parse
 * @param fallback - The value to return if parsing/validation fails
 * @param options - Optional configuration
 * @param options.context - Context string for logging
 * @param options.schema - Optional Zod schema for validation
 */
export function safeJsonParse<T>(
  json: string | null | undefined,
  fallback: T,
  options?: {
    context?: string;
    schema?: z.ZodSchema<T>;
    maxSize?: number; // PERFORMANCE FIX: Optional size limit override
  }
): T {
  if (!json) {
    return fallback;
  }

  const { context, schema, maxSize = JSON_SIZE_LIMITS.DEFAULT } = options || {};

  // PERFORMANCE FIX: Check size before parsing to prevent memory exhaustion
  if (json.length > maxSize) {
    logger.warn(
      { context, size: json.length, maxSize },
      'JSON input exceeds size limit - rejecting to prevent memory exhaustion'
    );
    return fallback;
  }

  try {
    const parsed = JSON.parse(json);

    // FIX A6: If schema provided, validate parsed data
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        logger.warn(
          {
            context,
            errors: result.error.errors.slice(0, 3), // Limit logged errors
            jsonPreview: json.substring(0, 100),
          },
          'JSON schema validation failed - using fallback'
        );
        return fallback;
      }
      return result.data;
    }

    // No schema - return parsed with type assertion (legacy behavior)
    // NOTE: This is less safe but maintains backward compatibility
    return parsed as T;
  } catch (error) {
    logger.warn(
      { error, context, jsonPreview: json.substring(0, 100) },
      'Failed to parse JSON'
    );
    return fallback;
  }
}

/**
 * Parse conversation state from database JSON with Zod validation
 * PERFORMANCE FIX: Added size limit to prevent memory exhaustion
 */
export function parseConversationState(
  json: unknown
): ConversationState | null {
  if (!json) {
    return null;
  }

  let parsed: unknown = json;

  // Handle if it's a JSON string
  if (typeof json === 'string') {
    // PERFORMANCE FIX: Size limit for conversation state
    if (json.length > JSON_SIZE_LIMITS.CONVERSATION_STATE) {
      logger.warn(
        { size: json.length, maxSize: JSON_SIZE_LIMITS.CONVERSATION_STATE },
        'Conversation state JSON exceeds size limit'
      );
      return null;
    }

    try {
      parsed = JSON.parse(json);
    } catch (error) {
      logger.warn(
        { error, jsonPreview: json.substring(0, 100) },
        'Failed to parse conversation state JSON string'
      );
      return null;
    }
  }

  // Validate with Zod schema. The schema's output type IS ConversationState
  // (checked by the annotation) — no cast needed.
  const result = conversationStateSchema.safeParse(parsed);
  if (result.success) {
    const state: ConversationState = result.data;
    return state;
  }

  // Log validation errors for debugging
  logger.warn(
    { errors: result.error.errors, context: 'parseConversationState' },
    'Conversation state failed schema validation'
  );

  // Fallback: try to salvage partial data with loose validation
  // FIX: Accept missing/null systemPrompt since FIX #20 stores it as '' and
  // the storeConversationState signature allows systemPrompt?: string, meaning
  // it can be omitted from the stored JSON. Only messages array is required.
  // The checkpoint / facts / responseTracking fields are salvaged with the
  // same lenient coercion as the strict path — a single malformed message
  // must not also cost the agent its stage and facts.
  if (isPlainObject(parsed)) {
    const state = parsed;
    if (Array.isArray(state.messages)) {
      const extras = conversationStateExtrasSchema.parse(state);
      return {
        ...extras,
        systemPrompt: typeof state.systemPrompt === 'string' ? state.systemPrompt : '',
        messages: state.messages.map((m: unknown) => {
          const msg = isPlainObject(m) ? m : {};
          return {
            role: (msg.role as 'user' | 'assistant' | 'admin') || 'user',
            content: String(msg.content || ''),
            timestamp: msg.timestamp as string | undefined,
          };
        }),
      };
    }
  }

  return null;
}

/**
 * Parse therapist availability from database JSON with Zod validation
 * PERFORMANCE FIX: Added size limit to prevent memory exhaustion
 */
export function parseTherapistAvailability(
  json: unknown
): TherapistAvailability | null {
  if (!json) {
    return null;
  }

  let parsed: unknown = json;

  // Handle if it's a JSON string
  if (typeof json === 'string') {
    // PERFORMANCE FIX: Size limit for availability data
    if (json.length > JSON_SIZE_LIMITS.AVAILABILITY) {
      logger.warn(
        { size: json.length, maxSize: JSON_SIZE_LIMITS.AVAILABILITY },
        'Therapist availability JSON exceeds size limit'
      );
      return null;
    }

    try {
      parsed = JSON.parse(json);
    } catch (error) {
      logger.warn(
        { error, jsonPreview: json.substring(0, 100) },
        'Failed to parse therapist availability JSON string'
      );
      return null;
    }
  }

  // Validate with Zod schema
  const result = therapistAvailabilitySchema.safeParse(parsed);
  if (result.success) {
    return result.data as TherapistAvailability;
  }

  // Log validation errors for debugging
  logger.warn(
    { errors: result.error.errors, context: 'parseTherapistAvailability' },
    'Therapist availability failed schema validation'
  );

  // Fallback: salvage individual slots that pass the strict schema, while
  // dropping any that don't. Historically this fallback coerced
  // {day: null, start: null} to {day: "null", start: "null"} so the
  // frontend would render "null: null-null" — bug fixed by enforcing
  // the per-slot schema here instead of String()-coercing nulls.
  if (typeof parsed === 'object' && parsed !== null) {
    const avail = parsed as Record<string, unknown>;
    if (typeof avail.timezone === 'string' && Array.isArray(avail.slots)) {
      const validSlots: TherapistAvailability['slots'] = [];
      for (const candidate of avail.slots) {
        const slotResult = therapistAvailabilitySlotSchema.safeParse(candidate);
        if (slotResult.success) {
          validSlots.push(slotResult.data);
        }
      }
      const exceptions = Array.isArray(avail.exceptions)
        ? avail.exceptions
            .map((e) => therapistAvailabilityExceptionSchema.safeParse(e))
            .filter((r): r is { success: true; data: { date: string; available: boolean } } => r.success)
            .map((r) => r.data)
        : undefined;
      return {
        timezone: avail.timezone,
        slots: validSlots,
        ...(exceptions !== undefined ? { exceptions } : {}),
      };
    }
  }

  return null;
}

/**
 * Extract and parse a JSON object from an LLM response.
 *
 * AI models often wrap JSON in markdown code fences, include prose around the
 * object, or emit stray backtick characters. This function progressively cleans
 * the response before parsing:
 *  1. Strip markdown code fences (```json … ``` or ``` … ```)
 *  2. Extract the outermost { … } to discard surrounding text
 *  3. Remove backtick characters that appear outside quoted strings
 *
 * @param text      Raw LLM response text
 * @param context   Label for log messages (e.g. "therapist-extraction")
 * @returns         The parsed object, or throws on failure
 */
export function parseJsonFromLLMResponse<T = unknown>(text: string, context?: string): T {
  let jsonStr = text.trim();

  // 1. Strip markdown code fences
  jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');

  // 2. Extract the outermost JSON object
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  // 3. Remove backticks outside of quoted strings (string-aware walk)
  let cleaned = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (escaped) {
      cleaned += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      cleaned += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      cleaned += ch;
      continue;
    }
    if (ch === '`' && !inString) {
      continue;
    }
    cleaned += ch;
  }

  try {
    return JSON.parse(cleaned.trim()) as T;
  } catch (err) {
    logger.warn(
      { err, context, preview: text.substring(0, 200) },
      'Failed to parse JSON from LLM response'
    );
    throw err;
  }
}

/**
 * Safely stringify JSON for database storage
 */
export function safeJsonStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch (error) {
    logger.error({ error }, 'Failed to stringify JSON');
    return '{}';
  }
}
