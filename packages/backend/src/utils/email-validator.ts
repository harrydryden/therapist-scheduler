/**
 * Enhanced Email Validation Utilities
 *
 * Provides additional validation beyond basic RFC 5322 syntax checking:
 * - Domain MX record validation
 * - Disposable email detection
 * - Common typo suggestions
 */

import dns from 'dns';
import { promisify } from 'util';
import { logger } from './logger';

const resolveMx = promisify(dns.resolveMx);

/**
 * PERFORMANCE FIX: DNS lookup timeout configuration
 * Default system DNS can hang for 30+ seconds on unresponsive DNS servers
 */
const DNS_TIMEOUT_MS = 5000; // 5 second timeout for MX lookups

/**
 * Common disposable email domain patterns
 * These are temporary email services that should be blocked for appointment requests
 */
const DISPOSABLE_EMAIL_PATTERNS = [
  /^(10minute|tempmail|guerrilla|mailinator|throwaway|fakeinbox|temp-mail)/i,
  /^(yopmail|sharklasers|trashmail|maildrop|getairmail|mohmal)/i,
  /^(dispostable|mailnesia|tempinbox|emailondeck|getnada|mintemail)/i,
  /^(burnermail|spamgourmet|mytrashmail|incognitomail|anonymmail)/i,
];

/**
 * Known disposable email domains (exact match)
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'tempmail.com',
  '10minutemail.com',
  'throwaway.email',
  'fakeinbox.com',
  'temp-mail.org',
  'yopmail.com',
  'sharklasers.com',
  'trashmail.com',
  'maildrop.cc',
  'getairmail.com',
  'mohmal.com',
  'dispostable.com',
  'mailnesia.com',
  'tempinbox.com',
  'emailondeck.com',
  'getnada.com',
  'mintemail.com',
  'burnermail.io',
  'spamgourmet.com',
  'mytrashmail.com',
  'guerrillamail.org',
  'guerrillamail.net',
  'guerrillamailblock.com',
  'spam4.me',
  'grr.la',
  'pokemail.net',
]);

/**
 * Common email typos and their corrections
 */
const COMMON_TYPOS: Record<string, string> = {
  // Gmail typos
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gmailcom': 'gmail.com',
  'g]mail.com': 'gmail.com',
  // Outlook/Hotmail typos
  'hotmal.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outloo.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  // Yahoo typos
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'yhoo.com': 'yahoo.com',
  // iCloud typos
  'iclould.com': 'icloud.com',
  'icoud.com': 'icloud.com',
  'icloud.co': 'icloud.com',
  // UK domains
  'gmail.co.uk': 'gmail.com', // Gmail doesn't have .co.uk
  'hotmail.co.luk': 'hotmail.co.uk',
  'yahoo.co.luk': 'yahoo.co.uk',
};

export interface EmailValidationResult {
  isValid: boolean;
  email: string;
  normalizedEmail: string;
  errors: string[];
  warnings: string[];
  suggestions: string[];
  isDisposable: boolean;
  hasMxRecord: boolean | null; // null if check was skipped/failed
}

/**
 * Normalize an email address
 * - Lowercase
 * - Trim whitespace
 * - Remove dots from gmail local part (gmail ignores them)
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const [localPart, domain] = trimmed.split('@');

  if (!localPart || !domain) {
    return trimmed;
  }

  // Gmail ignores dots in the local part
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    // Also handle + aliases (everything after + is ignored by gmail)
    const baseLocalPart = localPart.split('+')[0].replace(/\./g, '');
    return `${baseLocalPart}@gmail.com`;
  }

  return trimmed;
}

/**
 * Check if a domain is a known disposable email provider
 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;

  // Check exact match
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return true;
  }

  // Check pattern match
  for (const pattern of DISPOSABLE_EMAIL_PATTERNS) {
    if (pattern.test(domain)) {
      return true;
    }
  }

  return false;
}

/**
 * Check for common email typos and suggest corrections
 */
export function checkForTypos(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const suggestion = COMMON_TYPOS[domain];
  if (suggestion) {
    const localPart = email.split('@')[0];
    return `${localPart}@${suggestion}`;
  }

  return null;
}

/**
 * Verify domain has valid MX records
 * Returns true if MX records exist, false if not, null on error
 *
 * PERFORMANCE FIX: Added timeout to prevent hanging on slow DNS
 */
export async function verifyMxRecords(email: string): Promise<boolean | null> {
  const domain = email.split('@')[1];
  if (!domain) return false;

  try {
    // PERFORMANCE FIX: Race between MX lookup and timeout
    // Prevents request handlers from hanging on slow/unresponsive DNS
    const timeoutPromise = new Promise<dns.MxRecord[]>((_, reject) => {
      setTimeout(() => reject(new Error('DNS_TIMEOUT')), DNS_TIMEOUT_MS);
    });

    const mxPromise = resolveMx(domain);

    const records = await Promise.race([mxPromise, timeoutPromise]);
    return records && records.length > 0;
  } catch (error: any) {
    // ENODATA or ENOTFOUND means no MX records
    if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') {
      return false;
    }
    // Timeout - log and return null (unknown status)
    if (error.message === 'DNS_TIMEOUT') {
      logger.warn({ domain, timeoutMs: DNS_TIMEOUT_MS }, 'MX record lookup timed out');
      return null;
    }
    // Other errors (network) - return null to indicate unknown
    logger.warn({ domain, error: error.code }, 'MX record lookup failed');
    return null;
  }
}

/**
 * Comprehensive email validation
 *
 * @param email - Email address to validate
 * @param options - Validation options
 * @returns Validation result with errors, warnings, and suggestions
 */
export async function validateEmail(
  email: string,
  options: {
    checkMx?: boolean;
    blockDisposable?: boolean;
    suggestTypos?: boolean;
  } = {}
): Promise<EmailValidationResult> {
  const {
    checkMx = true,
    blockDisposable = true,
    suggestTypos = true,
  } = options;

  const result: EmailValidationResult = {
    isValid: true,
    email: email,
    normalizedEmail: normalizeEmail(email),
    errors: [],
    warnings: [],
    suggestions: [],
    isDisposable: false,
    hasMxRecord: null,
  };

  // Basic format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    result.isValid = false;
    result.errors.push('Invalid email format');
    return result;
  }

  // Check for common typos
  if (suggestTypos) {
    const typoSuggestion = checkForTypos(email);
    if (typoSuggestion) {
      result.warnings.push(`Possible typo detected`);
      result.suggestions.push(`Did you mean ${typoSuggestion}?`);
    }
  }

  // Check for disposable email
  if (blockDisposable) {
    result.isDisposable = isDisposableEmail(email);
    if (result.isDisposable) {
      result.isValid = false;
      result.errors.push('Disposable email addresses are not allowed. Please use a permanent email address.');
    }
  }

  // Verify MX records
  if (checkMx && result.isValid) {
    result.hasMxRecord = await verifyMxRecords(email);
    if (result.hasMxRecord === false) {
      result.isValid = false;
      result.errors.push('Email domain does not have valid mail servers. Please check the email address.');
    }
  }

  return result;
}

/**
 * Quick validation for API routes - returns simple boolean
 * Use validateEmail() for detailed validation with suggestions
 */
export async function isValidEmail(email: string): Promise<boolean> {
  const result = await validateEmail(email, {
    checkMx: true,
    blockDisposable: true,
    suggestTypos: false,
  });
  return result.isValid;
}
