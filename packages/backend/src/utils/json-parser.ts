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
  systemPrompt: z.string(),
  messages: z.array(conversationMessageSchema),
});

const therapistAvailabilitySlotSchema = z.object({
  day: z.string(),
  start: z.string(),
  end: z.string(),
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
 * @deprecated Use safeJsonParse with schema option instead
 * Legacy function for backward compatibility
 */
export function safeJsonParseUnsafe<T>(
  json: string | null | undefined,
  fallback: T,
  context?: string
): T {
  return safeJsonParse(json, fallback, { context });
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
  if (typeof parsed === 'object' && parsed !== null) {
    const state = parsed as Record<string, unknown>;
    if (typeof state.systemPrompt === 'string' && Array.isArray(state.messages)) {
      return {
        systemPrompt: state.systemPrompt,
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

  // Fallback: try to salvage partial data with loose validation
  if (typeof parsed === 'object' && parsed !== null) {
    const avail = parsed as Record<string, unknown>;
    if (typeof avail.timezone === 'string' && Array.isArray(avail.slots)) {
      return {
        timezone: avail.timezone,
        slots: avail.slots.map((s: unknown) => {
          const slot = s as Record<string, unknown>;
          return {
            day: String(slot.day || ''),
            start: String(slot.start || ''),
            end: String(slot.end || ''),
          };
        }),
        exceptions: Array.isArray(avail.exceptions)
          ? avail.exceptions.map((e: unknown) => {
              const exc = e as Record<string, unknown>;
              return {
                date: String(exc.date || ''),
                available: Boolean(exc.available),
              };
            })
          : undefined,
      };
    }
  }

  return null;
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
