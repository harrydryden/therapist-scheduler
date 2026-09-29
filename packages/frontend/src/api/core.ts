import type {
  ApiResponse,
  PaginationInfo,
} from '../types';
import { API_BASE, getAdminSecret, clearAdminSecret } from '../config/env';
import { HEADERS, TIMEOUTS } from '../config/constants';

export const EMPTY_PAGINATION: PaginationInfo = { page: 1, limit: 20, total: 0, totalPages: 0 };

// Known API error detail shapes — avoids catch-all index signature
interface ThreadLimitDetails {
  maxAllowed: number;
  activeCount: number;
}

interface ValidationErrorDetails {
  field?: string;
  reason?: string;
}

export type ApiErrorDetails = ThreadLimitDetails | ValidationErrorDetails | Record<string, unknown>;

/** Extra fields some error responses carry. */
export interface ApiErrorExtras {
  /** HTTP status of the response (undefined for network/format errors). */
  status?: number;
  /** Seconds until a rate limit lifts (Retry-After header or body `retryAfter`). */
  retryAfter?: number;
  /** Corrected address for a likely typo, e.g. "jamie@gmail.com". */
  suggestedEmail?: string | null;
}

// Custom error class to carry API error details
export class ApiError extends Error {
  code?: string;
  details?: ApiErrorDetails;
  status?: number;
  retryAfter?: number;
  suggestedEmail?: string | null;

  constructor(message: string, code?: string, details?: ApiErrorDetails, extras: ApiErrorExtras = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.status = extras.status;
    this.retryAfter = extras.retryAfter;
    this.suggestedEmail = extras.suggestedEmail;
  }

  /** A rate-limit rejection (HTTP 429). */
  isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Type guard: check if this is a thread limit error with known detail shape */
  isThreadLimit(): this is ApiError & { details: ThreadLimitDetails } {
    return this.code === 'USER_THREAD_LIMIT' && this.details != null &&
      'maxAllowed' in this.details && 'activeCount' in this.details;
  }
}

/**
 * Error class for authentication failures (401, 429 auth lockout).
 * Used to signal that the admin secret is wrong or the IP is locked out,
 * so React Query and retry logic can skip retries.
 */
export class AuthError extends Error {
  status: number;
  retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Window event fired when an admin request is rejected for auth reasons. */
export const ADMIN_AUTH_FAILED_EVENT = 'admin-auth-failed';

/** `detail` of the ADMIN_AUTH_FAILED_EVENT CustomEvent. */
export interface AdminAuthFailureDetail {
  status: number;
  message: string;
  /** Seconds until an auth lockout (429) lifts, from Retry-After. */
  retryAfter?: number;
}

function notifyAdminAuthFailed(detail: AdminAuthFailureDetail): void {
  clearAdminSecret();
  window.dispatchEvent(new CustomEvent<AdminAuthFailureDetail>(ADMIN_AUTH_FAILED_EVENT, { detail }));
}

function parseRetryAfter(response: Response, body?: Record<string, unknown>): number | undefined {
  const header = response.headers.get('Retry-After');
  const raw = header ?? (body && (typeof body.retryAfter === 'number' || typeof body.retryAfter === 'string') ? String(body.retryAfter) : null);
  if (!raw) return undefined;
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** "45 seconds", "3 minutes", "2 hours" — for "please wait …" copy. */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const minutes = Math.ceil(s / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Build the ApiError for a failed public/admin response, keeping the
 * status, Retry-After and typo suggestion the backend sends.
 */
function toApiError(response: Response, data: unknown): ApiError {
  const errorData = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const retryAfter = response.status === 429 ? parseRetryAfter(response, errorData) : undefined;
  let message = (errorData.error as string) || 'An error occurred';
  if (response.status === 429 && !errorData.error) {
    message = retryAfter
      ? `Too many requests. Please wait ${formatWait(retryAfter)} and try again.`
      : 'Too many requests. Please wait a moment and try again.';
  } else if (response.status === 429 && retryAfter && !/wait/i.test(message)) {
    message = `${message.replace(/\.?$/, '.')} Please wait ${formatWait(retryAfter)} and try again.`;
  }
  return new ApiError(
    message,
    errorData.code as string | undefined,
    errorData.details as ApiError['details'],
    {
      status: response.status,
      retryAfter,
      suggestedEmail: typeof errorData.suggestedEmail === 'string' ? errorData.suggestedEmail : null,
    }
  );
}

/**
 * Fetch with timeout using AbortController
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = TIMEOUTS.DEFAULT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Forward the caller's abort signal (e.g. from React useEffect cleanup)
  // so that both external cancellation and our timeout trigger the same controller.
  const externalSignal = options.signal;
  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // If the external signal triggered the abort, re-throw as AbortError
      // (not a timeout) so the caller can distinguish cancellation from timeout.
      if (externalSignal?.aborted) {
        throw error;
      }
      throw new Error('Request timed out. Please try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    // Clean up the listener to prevent memory leaks
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// Exponential backoff for retries
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);

      // Never retry auth failures - these won't succeed on retry
      if (response.status === 401 || response.status === 403) {
        return response;
      }

      // If rate limited (429), check if it's an auth lockout before retrying
      if (response.status === 429) {
        // Clone the response to peek at the body without consuming it
        const cloned = response.clone();
        try {
          const body = await cloned.json();
          // Auth lockout responses should not be retried
          if (body?.error?.includes?.('authentication')) {
            return response;
          }
        } catch {
          // If we can't parse the body, fall through to normal 429 handling
        }

        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 10000); // Max 10 seconds

        if (attempt < maxRetries - 1) {
          await sleep(waitTime);
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');

      // Only retry on network errors, not on other errors
      if (attempt < maxRetries - 1 && error instanceof TypeError) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 5000));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

/**
 * Safely parse JSON response, handling non-JSON error pages
 */
export async function safeParseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // If server returned non-JSON (e.g., HTML error page), create a structured error
    if (!response.ok) {
      return { error: `Server error (${response.status}): ${response.statusText}` };
    }
    throw new Error('Invalid response format from server');
  }
}

/**
 * FIX M3: Request deduplication to prevent concurrent duplicate requests
 * Stores pending promises by request key to coalesce identical concurrent requests
 */
const pendingRequests = new Map<string, Promise<unknown>>();

function getRequestKey(method: string, endpoint: string): string {
  // For GET requests, use method:endpoint to deduplicate
  // For mutations (POST, PUT, DELETE), return empty to skip deduplication
  if (method === 'GET') {
    return `GET:${endpoint}`;
  }
  // For mutations, we don't deduplicate - each should be sent
  return '';
}

async function fetchWithDedup<T>(
  endpoint: string,
  options: RequestInit & { timeoutMs?: number } = {},
  fetchFn: () => Promise<T>
): Promise<T> {
  const method = options.method || 'GET';
  const key = getRequestKey(method, endpoint);

  // Only deduplicate GET requests
  if (!key) {
    return fetchFn();
  }

  // If there's already a pending request for this key, return its promise
  const pending = pendingRequests.get(key);
  if (pending) {
    return pending as Promise<T>;
  }

  // Create new request and store its promise
  const promise = fetchFn().finally(() => {
    // Clean up after request completes
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, promise);
  return promise;
}

/** Methods that never carry a request body. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/**
 * Build the RequestInit for a JSON API call.
 *
 * - Caller headers are merged OVER `defaultHeaders` rather than replacing
 *   them. (Previously `...options` was spread after `headers`, so any
 *   caller passing its own `headers` silently dropped the defaults —
 *   including the admin secret.)
 * - A mutation with no body gets an empty JSON object (`'{}'`). The
 *   backend (Fastify 4) rejects `Content-Type: application/json` with an
 *   empty body as 400 FST_ERR_CTP_EMPTY_JSON_BODY, which broke every
 *   body-less admin POST (setting reset, Slack test/reset, weekly
 *   mailing send, work-report generate).
 * - A FormData body drops the JSON Content-Type so the browser can set
 *   the multipart boundary itself.
 */
export function buildJsonRequestInit(
  options: RequestInit | undefined,
  defaultHeaders: Record<string, string>
): RequestInit {
  const headers = new Headers(defaultHeaders);
  if (options?.headers) {
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  }

  const method = (options?.method || 'GET').toUpperCase();
  const init: RequestInit = { ...options, method, headers };

  if (!BODYLESS_METHODS.has(method) && (options?.body === undefined || options.body === null)) {
    init.body = '{}';
  }
  if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
    headers.delete('Content-Type');
  }
  return init;
}

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>> {
  // FIX M3: Use request deduplication for GET requests
  return fetchWithDedup<ApiResponse<T>>(endpoint, options, async () => {
    const method = (options?.method || 'GET').toUpperCase();
    // Only GETs are retried (and sleep through a 429). A public POST
    // (booking, signup, feedback) used to wait out Retry-After — up to a
    // minute of "Submitting…" — and resend; now it fails fast so the form
    // can say "please wait N seconds".
    const init = buildJsonRequestInit(options, { 'Content-Type': 'application/json' });
    const response = method === 'GET'
      ? await fetchWithRetry(`${API_BASE}${endpoint}`, init, TIMEOUTS.DEFAULT_MS)
      : await fetchWithTimeout(`${API_BASE}${endpoint}`, init, TIMEOUTS.DEFAULT_MS);

    const data = await safeParseJson(response);

    if (!response.ok) {
      throw toApiError(response, data);
    }

    // Validate response is an object with expected structure
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ApiError('Invalid API response format');
    }

    return data as unknown as ApiResponse<T>;
  });
}

// Admin Dashboard API functions
//
// FIX #3: Admin secret is now read from sessionStorage at runtime via getAdminSecret(),
// instead of being baked into the production JS bundle from VITE_ADMIN_SECRET.
// The AdminLayout prompts the admin to enter the secret on first visit.
// TODO: Implement proper session-based authentication for admin routes:
// 1. Add /admin/login endpoint with password/OAuth
// 2. Use httpOnly cookies for session tokens
// 3. Remove x-webhook-secret header from frontend

export async function fetchAdminApi<T>(endpoint: string, options?: RequestInit, timeoutMs: number = TIMEOUTS.DEFAULT_MS): Promise<ApiResponse<T> & { pagination?: PaginationInfo; total?: number }> {
  // FIX M3: Use request deduplication for GET requests
  return fetchWithDedup<ApiResponse<T> & { pagination?: PaginationInfo; total?: number }>(
    endpoint,
    options,
    async () => {
      const method = options?.method || 'GET';
      // Use retry logic for GET requests (safe to retry), direct fetch for mutations
      const fetchFn = method === 'GET' ? fetchWithRetry : fetchWithTimeout;
      const response = await fetchFn(
        `${API_BASE}${endpoint}`,
        buildJsonRequestInit(options, {
          'Content-Type': 'application/json',
          [HEADERS.WEBHOOK_SECRET]: getAdminSecret(),
        }),
        timeoutMs
      );

      const data = await safeParseJson(response);

      // Handle auth failures: clear stored secret and throw AuthError
      // so React Query stops retrying and AdminLayout shows login screen
      if (response.status === 401 || response.status === 403) {
        const errorData = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const message = (errorData.error as string) || 'Authentication failed. Please re-enter your admin secret.';
        notifyAdminAuthFailed({ status: response.status, message });
        throw new AuthError(message, response.status);
      }

      const errorData = data && typeof data === 'object' ? data as Record<string, unknown> : {};

      if (response.status === 429) {
        const errorMsg = (errorData.error as string) || '';
        if (errorMsg.toLowerCase().includes('authentication')) {
          // Auth lockout - clear secret so user can re-enter after lockout expires
          const retryAfter = parseRetryAfter(response);
          const message = errorMsg || 'Too many failed attempts. Please try again later.';
          notifyAdminAuthFailed({ status: 429, message, retryAfter });
          throw new AuthError(message, 429, retryAfter);
        }
      }

      if (!response.ok) {
        // Throw ApiError (not plain Error) so callers can inspect code/details
        // consistently with fetchApi. Previously only fetchApi threw ApiError,
        // which meant admin pages lost access to structured error metadata.
        throw toApiError(response, data);
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ApiError('Invalid API response format');
      }

      return data as unknown as ApiResponse<T> & { pagination?: PaginationInfo; total?: number };
    }
  );
}

/**
 * Check a candidate admin secret against the backend before storing it.
 *
 * Uses GET /admin/alerts/count — the lightest authenticated admin endpoint
 * (three COUNT queries, no payload). Deliberately bypasses fetchAdminApi:
 * no GET de-duplication (which is keyed by endpoint, not secret), no retry
 * (each wrong attempt counts toward the backend's per-IP lockout), and no
 * `admin-auth-failed` side effects for a secret that was never stored.
 *
 * Resolves when the secret is accepted; throws AuthError (401/403, or 429
 * with `retryAfter` seconds for a lockout) or ApiError otherwise.
 */
export async function verifyAdminSecret(secret: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${API_BASE}/admin/alerts/count`,
      { method: 'GET', headers: { [HEADERS.WEBHOOK_SECRET]: secret } },
      TIMEOUTS.DEFAULT_MS
    );
  } catch (error) {
    throw new ApiError(
      error instanceof TypeError
        ? 'Could not reach the server. Check your connection and try again.'
        : getErrorMessage(error, 'Could not reach the server.')
    );
  }

  if (response.ok) return;

  let serverMessage = '';
  try {
    const data = await safeParseJson(response);
    if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
      serverMessage = (data as { error: string }).error;
    }
  } catch {
    // Non-JSON body; fall back to the status-based messages below.
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError('That admin secret is not correct.', response.status);
  }
  if (response.status === 429) {
    throw new AuthError(
      serverMessage || 'Too many attempts. Please try again later.',
      429,
      parseRetryAfter(response)
    );
  }
  throw new ApiError(serverMessage || `Could not verify the admin secret (HTTP ${response.status}).`);
}

/**
 * Unwrap an ApiResponse, returning `data` or throwing an ApiError if missing.
 *
 * Eliminates the repetitive `if (!response.data) throw new Error(...)` pattern
 * from every API function. Pass a resource name for clearer error messages.
 *
 * @example
 *   const response = await fetchAdminApi<Entry>('/admin/entry/123');
 *   return unwrap(response, 'entry');
 */
export function unwrap<T>(response: ApiResponse<T>, resource = 'resource'): T {
  if (response.data == null) {
    throw new ApiError(`No ${resource} returned from server`);
  }
  return response.data;
}

/**
 * Extract a user-facing message from any thrown value.
 * Returns the fallback if the value is not an Error or has no message.
 */
export function getErrorMessage(error: unknown, fallback = 'An unexpected error occurred'): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
