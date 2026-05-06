import pino from 'pino';
import { config } from '../config';
import { getTraceContext } from './request-tracing';

/**
 * Mask sensitive email addresses for logging
 * Examples:
 *   "john.doe@example.com" -> "j***e@e***.com"
 *   "a@b.co" -> "a***@b***.co"
 */
export function maskEmail(email: string | undefined | null): string {
  if (!email) return '[no-email]';

  const parts = email.split('@');
  if (parts.length !== 2) return '[invalid-email]';

  const [local, domain] = parts;
  const domainParts = domain.split('.');

  // Mask local part: keep first and last char if long enough
  const maskedLocal = local.length <= 2
    ? local[0] + '***'
    : local[0] + '***' + local[local.length - 1];

  // Mask domain: keep first char and TLD
  const tld = domainParts[domainParts.length - 1];
  const maskedDomain = domain.length <= 4
    ? domain[0] + '***.' + tld
    : domain[0] + '***.' + tld;

  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * Mask multiple emails in an object for safe logging
 * Returns a new object with email fields masked
 */
export function maskSensitiveData<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj };

  const emailFields = [
    'email', 'userEmail', 'therapistEmail', 'fromEmail', 'toEmail',
    'from', 'to', 'emailAddress', 'schedulerEmail'
  ];

  for (const field of emailFields) {
    if (field in result && typeof result[field] === 'string') {
      (result as Record<string, unknown>)[field] = maskEmail(result[field] as string);
    }
  }

  return result;
}

// Redaction paths for pino — automatically masks these fields in every
// environment. Previously this was production-only, but staging logs and
// any non-local sink (e.g. a developer ssh'd into a dev VM tailing a
// process) leak PII just as easily as prod logs do. The censor below
// masks emails into a readable form (`j***e@e***.com`) and replaces
// non-email values with `[REDACTED]`, so logs stay structurally readable.
const redactPaths = [
  // Emails (top-level + one-level nested)
  'email',
  'userEmail',
  'therapistEmail',
  'fromEmail',
  'toEmail',
  'from',
  'to',
  'emailAddress',
  'schedulerEmail',
  '*.email',
  '*.userEmail',
  '*.therapistEmail',
  '*.fromEmail',
  '*.toEmail',
  '*.emailAddress',
  // Names
  'userName',
  'therapistName',
  '*.userName',
  '*.therapistName',
  // Email subjects/bodies — emails carry conversational PII, and subjects
  // in this codebase routinely embed names ("Re: Booking with John").
  'subject',
  '*.subject',
  // Specific fields known to carry full user-supplied content. We avoid
  // adding bare `body`/`content` because those are too generic — they
  // would mask harmless framework fields. Add new specific names here as
  // PII-bearing log sites are discovered.
  'responseContent',
  '*.responseContent',
];

export const logger = pino({
  level: config.logLevel,
  // Auto-inject traceId/appointmentId/source from the AsyncLocalStorage
  // trace context if present. Explicit values in the log payload still
  // win because pino merges them after the mixin output.
  mixin() {
    const ctx = getTraceContext();
    if (!ctx) return {};
    const out: Record<string, unknown> = { traceId: ctx.traceId };
    if (ctx.appointmentId) out.appointmentId = ctx.appointmentId;
    if (ctx.source) out.source = ctx.source;
    return out;
  },
  redact: {
    paths: redactPaths,
    censor: (value) => {
      if (typeof value === 'string' && value.includes('@')) {
        return maskEmail(value);
      }
      return '[REDACTED]';
    },
  },
  transport:
    config.env === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        }
      : undefined,
});

interface TokenUsageParams {
  traceId: string;
  service: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latency: number;
}

export function logTokenUsage(params: TokenUsageParams): void {
  logger.info(
    {
      type: 'token_usage',
      ...params,
    },
    `Token usage: ${params.totalTokens} tokens (${params.promptTokens} prompt, ${params.completionTokens} completion) in ${params.latency}ms`
  );
}
