/**
 * Public feedback-form API (no auth): load the form (with prefill when the
 * emailed `fk` token verifies) and submit responses.
 */

import { API_BASE } from '../config/env';
import { fetchWithTimeout, safeParseJson } from './core';
import type { FormConfig } from '../types/feedback';

export interface PrefilledData {
  trackingCode: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  appointmentId: string;
}

export interface FeedbackFormResponse {
  form: FormConfig;
  prefilled: PrefilledData | null;
  warning?: string;
}

/** Raw GET body: `{ success, data }` envelope (or, defensively, the bare payload). */
type FeedbackFormEnvelope = Partial<FeedbackFormResponse> & {
  data?: FeedbackFormResponse;
  error?: string;
  code?: string;
};

const FEEDBACK_TIMEOUT_MS = 30000;

const FORM_LOAD_MAX_RETRIES = 3;

/** Error from the public feedback endpoints, carrying the HTTP status. */
export class FeedbackApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'FeedbackApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The backend's explicit "already submitted" response: 400 with
 * `error: 'Feedback already submitted'` (from both the prefill GET and the
 * submit POST), or an `ALREADY_SUBMITTED` code if one is ever added. Only
 * this — not any failure — may show the terminal "Already submitted" state.
 */
export function isAlreadySubmittedError(err: unknown): boolean {
  if (!(err instanceof FeedbackApiError)) return false;
  if (err.code === 'ALREADY_SUBMITTED') return true;
  return err.status === 400 && /already submitted/i.test(err.message);
}

function errorFields(data: unknown): { error?: string; message?: string; code?: string } {
  return data && typeof data === 'object' ? (data as { error?: string; message?: string; code?: string }) : {};
}

/**
 * Build the form GET URL. The `fk` feedback token from the emailed link
 * must be forwarded: the backend only returns `prefilled` (name greeting,
 * therapist name, and the early "already submitted" check) when it can
 * verify that token.
 */
export function buildFeedbackFormUrl(splCode?: string, feedbackToken?: string): string {
  if (!splCode) return `${API_BASE}/feedback/form`;
  const base = `${API_BASE}/feedback/form/${encodeURIComponent(splCode)}`;
  return feedbackToken ? `${base}?fk=${encodeURIComponent(feedbackToken)}` : base;
}

export async function getFeedbackForm(
  splCode?: string,
  feedbackToken?: string,
  signal?: AbortSignal
): Promise<FeedbackFormResponse> {
  const endpoint = buildFeedbackFormUrl(splCode, feedbackToken);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < FORM_LOAD_MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(endpoint, signal ? { signal } : {}, FEEDBACK_TIMEOUT_MS);
      // safeParseJson: an HTML 5xx page yields a readable error instead of a JSON SyntaxError
      const data = errorFields(await safeParseJson(response)) as FeedbackFormEnvelope;

      if (!response.ok) {
        const err = new FeedbackApiError(data.error || 'Failed to load feedback form', response.status, data.code);
        // Don't retry client errors (4xx) — they won't succeed on retry
        if (response.status >= 400 && response.status < 500) throw err;
        lastError = err;
        if (attempt < FORM_LOAD_MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }

      // Backend wraps responses in { success, data } envelope via sendSuccess()
      return data.data ?? (data as FeedbackFormResponse);
    } catch (err) {
      // Don't retry if the component unmounted (external abort)
      if (signal?.aborted) throw err;
      // 4xx (e.g. "Feedback already submitted") is final — surface it as-is
      if (err instanceof FeedbackApiError && err.status >= 400 && err.status < 500) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      // Network error / timeout / 5xx: back off and retry
      if (attempt < FORM_LOAD_MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
    }
  }

  throw lastError || new Error('Failed to load form');
}

export async function submitFeedback(data: {
  trackingCode?: string;
  feedbackToken?: string;
  therapistName: string;
  responses: Record<string, string | number>;
}): Promise<{ success: boolean; submissionId: string; message: string }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${API_BASE}/feedback/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }, FEEDBACK_TIMEOUT_MS);
  } catch (err) {
    // fetch rejects with a bare TypeError ("Failed to fetch") when offline
    if (err instanceof TypeError) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    throw err;
  }

  const result = errorFields(await safeParseJson(response)) as {
    success?: boolean; data?: { submissionId?: string }; message?: string; error?: string; code?: string;
  };

  if (!response.ok) {
    throw new FeedbackApiError(
      result.error || result.message || 'Failed to submit feedback',
      response.status,
      result.code
    );
  }

  // Backend wraps responses in { success, data, message } envelope via sendSuccess()
  return { success: !!result.success, submissionId: result.data?.submissionId ?? '', message: result.message ?? '' };
}
