import { z } from 'zod';
import { logger } from './logger';
import type { ConversationState, TherapistAvailability } from '../types';

/**
 * PERFORMANCE FIX: Maximum JSON input sizes to prevent memory exhaustion
 * Large JSON inputs can cause DoS by allocating excessive memory during parsing
 */
const JSON_SIZE_LIMITS = {
  DEFAULT: 1_000_000,          // 1MB - general JSON parsing
  CONVERSATION_STATE: 500_000, // 500KB - conversation history can grow
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

const conversationStateSchema = z.object({
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

  // Validate with Zod schema
  const result = conversationStateSchema.safeParse(parsed);
  if (result.success) {
    return result.data as ConversationState;
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
  if (typeof parsed === 'object' && parsed !== null) {
    const state = parsed as Record<string, unknown>;
    if (Array.isArray(state.messages)) {
      return {
        systemPrompt: typeof state.systemPrompt === 'string' ? state.systemPrompt : '',
        messages: state.messages.map((m: unknown) => {
          const msg = m as Record<string, unknown>;
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
