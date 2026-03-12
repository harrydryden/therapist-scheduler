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

// Custom error class to carry API error details
export class ApiError extends Error {
  code?: string;
  details?: ApiErrorDetails;

  constructor(message: string, code?: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
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

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
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

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>> {
  // FIX M3: Use request deduplication for GET requests
  return fetchWithDedup<ApiResponse<T>>(endpoint, options, async () => {
    const response = await fetchWithRetry(
      `${API_BASE}${endpoint}`,
      {
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        ...options,
      },
      TIMEOUTS.DEFAULT_MS
    );

    const data = await safeParseJson(response);

    if (!response.ok) {
      const errorData = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      throw new ApiError(
        (errorData.error as string) || 'An error occurred',
        errorData.code as string | undefined,
        errorData.details as ApiError['details']
      );
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
        {
          headers: {
            'Content-Type': 'application/json',
            [HEADERS.WEBHOOK_SECRET]: getAdminSecret(),
            ...options?.headers,
          },
          ...options,
        },
        timeoutMs
      );

      const data = await safeParseJson(response);

      // Handle auth failures: clear stored secret and throw AuthError
      // so React Query stops retrying and AdminLayout shows login screen
      if (response.status === 401 || response.status === 403) {
        clearAdminSecret();
        window.dispatchEvent(new Event('admin-auth-failed'));
        const errorData = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        throw new AuthError(
          (errorData.error as string) || 'Authentication failed. Please re-enter your admin secret.',
          response.status
        );
      }

      const errorData = data && typeof data === 'object' ? data as Record<string, unknown> : {};

      if (response.status === 429) {
        const errorMsg = (errorData.error as string) || '';
        if (errorMsg.toLowerCase().includes('authentication')) {
          // Auth lockout - clear secret so user can re-enter after lockout expires
          clearAdminSecret();
          window.dispatchEvent(new Event('admin-auth-failed'));
          const retryAfter = response.headers.get('Retry-After');
          throw new AuthError(
            errorMsg || 'Too many failed attempts. Please try again later.',
            429,
            retryAfter ? parseInt(retryAfter, 10) : undefined
          );
        }
      }

      if (!response.ok) {
        throw new Error((errorData.error as string) || 'An error occurred');
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid API response format');
      }

      return data as unknown as ApiResponse<T> & { pagination?: PaginationInfo; total?: number };
    }
  );
}
