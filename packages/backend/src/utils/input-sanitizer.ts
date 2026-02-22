/**
 * Input Sanitizer
 *
 * Provides sanitization for user-provided text to prevent:
 * - XSS attacks (cross-site scripting)
 * - SQL injection (defense in depth - Prisma handles this)
 * - Prompt injection (for AI agent interactions)
 * - Control character injection
 * - Excessive whitespace/formatting abuse
 *
 * Note: This is defense-in-depth. Prisma parameterized queries prevent SQL injection,
 * and proper output encoding prevents XSS. This adds an extra layer of safety.
 */

import { logger } from './logger';

export interface SanitizeOptions {
  /** Maximum length to truncate to */
  maxLength?: number;
  /** Allow newlines (default: true) */
  allowNewlines?: boolean;
  /** Allow HTML tags (default: false - strips all HTML) */
  allowHtml?: boolean;
  /** Strip prompt injection patterns (default: true for AI context) */
  stripPromptInjection?: boolean;
  /** Trim whitespace (default: true) */
  trim?: boolean;
  /** Normalize unicode (default: true) */
  normalizeUnicode?: boolean;
}

const DEFAULT_OPTIONS: SanitizeOptions = {
  maxLength: 10000,
  allowNewlines: true,
  allowHtml: false,
  stripPromptInjection: false,
  trim: true,
  normalizeUnicode: true,
};

// Patterns that might indicate prompt injection attempts
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?prior\s+(instructions|context)/i,
  /forget\s+(everything|all)\s+(you\s+)?know/i,
  /you\s+are\s+now\s+a/i,
  /act\s+as\s+(if\s+)?you\s+are/i,
  /pretend\s+(to\s+be|you\s+are)/i,
  /new\s+instructions:/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<\|im_start\|>/i,
  /<<SYS>>/i,
];

// HTML tag pattern
const HTML_TAG_PATTERN = /<[^>]*>/g;

// Control characters (except newline, tab, carriage return)
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Excessive whitespace pattern
const EXCESSIVE_WHITESPACE_PATTERN = /[ \t]{10,}/g;
const EXCESSIVE_NEWLINES_PATTERN = /\n{5,}/g;

/**
 * Sanitize a string input
 */
export function sanitizeString(input: string, options: SanitizeOptions = {}): string {
  if (typeof input !== 'string') {
    return '';
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  let result = input;

  // 1. Normalize unicode (prevents homograph attacks)
  if (opts.normalizeUnicode) {
    result = result.normalize('NFC');
  }

  // 2. Remove control characters
  result = result.replace(CONTROL_CHAR_PATTERN, '');

  // 3. Strip HTML tags if not allowed
  if (!opts.allowHtml) {
    result = result.replace(HTML_TAG_PATTERN, '');
  }

  // 4. Handle newlines
  if (!opts.allowNewlines) {
    result = result.replace(/[\r\n]+/g, ' ');
  } else {
    // Normalize line endings to \n
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Limit consecutive newlines
    result = result.replace(EXCESSIVE_NEWLINES_PATTERN, '\n\n\n\n');
  }

  // 5. Limit excessive whitespace
  result = result.replace(EXCESSIVE_WHITESPACE_PATTERN, '         ');

  // 6. Strip prompt injection patterns (for AI context)
  if (opts.stripPromptInjection) {
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      if (pattern.test(result)) {
        logger.warn(
          { pattern: pattern.toString(), inputLength: input.length },
          'Potential prompt injection detected and stripped'
        );
        result = result.replace(pattern, '[filtered]');
      }
    }
  }

  // 7. Trim whitespace
  if (opts.trim) {
    result = result.trim();
  }

  // 8. Truncate to max length
  if (opts.maxLength && result.length > opts.maxLength) {
    result = result.substring(0, opts.maxLength);
    logger.debug({ originalLength: input.length, truncatedTo: opts.maxLength }, 'Input truncated');
  }

  return result;
}

/**
 * Sanitize user name
 */
export function sanitizeName(name: string): string {
  return sanitizeString(name, {
    maxLength: 200,
    allowNewlines: false,
    allowHtml: false,
    trim: true,
  });
}

/**
 * Sanitize email-related content (subject, body preview)
 */
export function sanitizeEmailContent(content: string): string {
  return sanitizeString(content, {
    maxLength: 50000, // Allow longer for email bodies
    allowNewlines: true,
    allowHtml: false,
    stripPromptInjection: true, // Important for AI processing
    trim: true,
  });
}

/**
 * Sanitize feedback/notes that might be displayed
 */
export function sanitizeFeedback(feedback: string): string {
  return sanitizeString(feedback, {
    maxLength: 5000,
    allowNewlines: true,
    allowHtml: false,
    trim: true,
  });
}

/**
 * Sanitize content before sending to AI agent
 * More aggressive filtering for prompt injection
 */
export function sanitizeForAI(content: string): string {
  return sanitizeString(content, {
    maxLength: 100000,
    allowNewlines: true,
    allowHtml: false,
    stripPromptInjection: true,
    trim: true,
  });
}

/**
 * Sanitize a JSON object's string values recursively
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  options: SanitizeOptions = {}
): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeString(value, options);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string'
          ? sanitizeString(item, options)
          : typeof item === 'object' && item !== null
            ? sanitizeObject(item as Record<string, unknown>, options)
            : item
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeObject(value as Record<string, unknown>, options);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Check if a string contains potential prompt injection
 * Returns true if suspicious patterns are found
 */
export function detectPromptInjection(input: string): boolean {
  if (typeof input !== 'string') return false;

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return true;
    }
  }

  return false;
}

/**
 * Escape HTML entities for safe display
 * Use this when you need to display user content in HTML context
 */
export function escapeHtml(input: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };

  return input.replace(/[&<>"'/]/g, char => htmlEntities[char] || char);
}
