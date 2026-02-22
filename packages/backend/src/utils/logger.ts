import pino from 'pino';
import { config } from '../config';

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

// Redaction paths for pino - automatically masks these fields
const redactPaths = config.env === 'production' ? [
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
] : [];

export const logger = pino({
  level: config.logLevel,
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
