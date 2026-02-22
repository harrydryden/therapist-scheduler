import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { HEADERS } from '../constants';
import { Errors } from '../utils/response';
import { cacheManager } from '../utils/redis';

/**
 * FIX R3: Constant-time string comparison to prevent timing attacks
 * Timing attacks can reveal the correct secret by measuring response time differences.
 * This function ensures comparison takes the same time regardless of where mismatch occurs.
 */
export function safeCompare(a: string, b: string): boolean {
  // If lengths differ, we still need constant-time comparison
  // Pad shorter string to match length (comparison will fail, but timing is consistent)
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  // Make buffers same length by padding shorter one
  const maxLen = Math.max(aBuffer.length, bBuffer.length);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  aBuffer.copy(aPadded);
  bBuffer.copy(bPadded);

  // Evaluate both conditions unconditionally to avoid timing leak from && short-circuit
  const lengthOk = aBuffer.length === bBuffer.length ? 1 : 0;
  const contentOk = timingSafeEqual(aPadded, bPadded) ? 1 : 0;

  return (lengthOk & contentOk) === 1;
}

// FIX H11: Brute force protection configuration
// Threshold raised from 5 to 10: a single admin dashboard page load fires
// multiple concurrent API requests (appointments, stats, detail), so a wrong
// secret easily burns through 5 attempts before the frontend can react.
const AUTH_RATE_LIMIT = {
  MAX_FAILED_ATTEMPTS: 10, // Max failed attempts per window
  WINDOW_SECONDS: 300,     // 5 minute window
  LOCKOUT_SECONDS: 300,    // 5 minute lockout after max attempts
};

// FIX L5: Configurable trusted proxy depth to prevent IP spoofing attacks
// Set TRUSTED_PROXY_DEPTH to the number of trusted proxies in front of the app
// Default: 1 (e.g., Railway/Vercel add one proxy layer)
// If you have multiple load balancers, increase this value
const TRUSTED_PROXY_DEPTH = parseInt(process.env.TRUSTED_PROXY_DEPTH || '1', 10);

/**
 * Get client IP for rate limiting
 * FIX L5: Only trust the nth-from-right IP in X-Forwarded-For chain
 * This prevents attackers from spoofing their IP by adding fake headers
 */
function getClientIP(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const ips = forwarded.split(',').map(ip => ip.trim());
    // Take the (n+1)th IP from the right, where n is the trusted proxy depth
    // This is the IP that was added by the first trusted proxy
    const trustedIndex = Math.max(0, ips.length - TRUSTED_PROXY_DEPTH);
    return ips[trustedIndex] || request.ip || 'unknown';
  }
  return request.ip || 'unknown';
}

/**
 * Check if IP is locked out from auth attempts
 * FIX H11: Prevents brute force attacks on webhook secret
 */
async function checkAuthRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  try {
    const lockoutKey = `auth:lockout:${ip}`;
    const attemptsKey = `auth:attempts:${ip}`;

    // Check if currently locked out
    const lockoutUntil = await cacheManager.getString(lockoutKey);
    if (lockoutUntil) {
      const remaining = parseInt(lockoutUntil, 10) - Date.now();
      if (remaining > 0) {
        return { allowed: false, retryAfter: Math.ceil(remaining / 1000) };
      }
    }

    // Check attempt count
    const attemptsStr = await cacheManager.getString(attemptsKey);
    const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;

    if (attempts >= AUTH_RATE_LIMIT.MAX_FAILED_ATTEMPTS) {
      return { allowed: false, retryAfter: AUTH_RATE_LIMIT.LOCKOUT_SECONDS };
    }

    return { allowed: true };
  } catch (err) {
    // FIX #15: Log at error level when brute force protection is unavailable.
    // Failing open is the pragmatic choice (don't lock out admins when Redis is down),
    // but this should trigger an operational alert.
    logger.error({ err, ip }, 'AUTH RATE LIMIT UNAVAILABLE - brute force protection disabled. Fix Redis connection.');
    return { allowed: true };
  }
}

/**
 * Record a failed auth attempt
 */
async function recordFailedAttempt(ip: string): Promise<void> {
  try {
    const attemptsKey = `auth:attempts:${ip}`;
    const lockoutKey = `auth:lockout:${ip}`;

    // Increment attempts (atomic operation)
    const attempts = await cacheManager.incr(attemptsKey);

    // Set TTL on first attempt
    if (attempts === 1) {
      await cacheManager.expire(attemptsKey, AUTH_RATE_LIMIT.WINDOW_SECONDS);
    }

    // If max attempts reached, set lockout
    if (attempts >= AUTH_RATE_LIMIT.MAX_FAILED_ATTEMPTS) {
      const lockoutUntil = Date.now() + AUTH_RATE_LIMIT.LOCKOUT_SECONDS * 1000;
      await cacheManager.set(lockoutKey, lockoutUntil.toString(), AUTH_RATE_LIMIT.LOCKOUT_SECONDS);
      logger.warn({ ip, attempts }, 'Auth rate limit exceeded - IP locked out');
    }
  } catch (err) {
    logger.warn({ err, ip }, 'Failed to record auth attempt');
  }
}

/**
 * Verify webhook secret for admin/internal endpoints
 * FIX H11: Added brute force protection
 */
export async function verifyWebhookSecret(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const ip = getClientIP(request);

  // Check rate limit before validating
  const rateCheck = await checkAuthRateLimit(ip);
  if (!rateCheck.allowed) {
    logger.warn({ requestId: request.id, ip }, 'Auth attempt blocked - rate limited');
    reply.header('Retry-After', rateCheck.retryAfter?.toString() || '900');
    return reply.status(429).send({
      success: false,
      error: 'Too many failed authentication attempts. Please try again later.',
    });
  }

  const webhookSecret = request.headers[HEADERS.WEBHOOK_SECRET];

  // FIX R3: Use constant-time comparison to prevent timing attacks
  // This ensures attackers can't determine secret by measuring response times
  const secretValid =
    typeof webhookSecret === 'string' &&
    config.webhookSecret &&
    safeCompare(webhookSecret, config.webhookSecret);

  if (!secretValid) {
    // Record failed attempt
    await recordFailedAttempt(ip);
    logger.warn({ requestId: request.id, ip }, 'Unauthorized request - invalid webhook secret');
    Errors.unauthorized(reply);
    return;
  }
}

/**
 * Create a preHandler hook for protected routes
 */
export const adminAuthHook = {
  preHandler: verifyWebhookSecret,
};
