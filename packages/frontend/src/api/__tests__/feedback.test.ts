import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildFeedbackFormUrl,
  getFeedbackForm,
  submitFeedback,
  isAlreadySubmittedError,
  FeedbackApiError,
} from '../feedback';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildFeedbackFormUrl', () => {
  it('forwards the fk token so the backend can return prefill data', () => {
    expect(buildFeedbackFormUrl('SPL-ABC', 'tok.en+/=')).toBe('/api/feedback/form/SPL-ABC?fk=tok.en%2B%2F%3D');
  });

  it('omits fk when there is no token, and encodes the code', () => {
    expect(buildFeedbackFormUrl('SPL ABC')).toBe('/api/feedback/form/SPL%20ABC');
  });

  it('uses the generic form endpoint without a code', () => {
    expect(buildFeedbackFormUrl(undefined, 'tok')).toBe('/api/feedback/form');
  });
});

describe('getFeedbackForm', () => {
  it('requests the form with ?fk= and unwraps the envelope', async () => {
    const payload = { form: { questions: [] }, prefilled: { therapistName: 'Sam' } };
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: payload }));

    const result = await getFeedbackForm('SPL1', 'signed-token');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/feedback/form/SPL1?fk=signed-token');
    expect(result).toEqual(payload);
  });

  it('surfaces the explicit already-submitted 400 without retrying', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'Feedback already submitted' }, 400));

    const err = await getFeedbackForm('SPL1', 'tok').catch((e: unknown) => e);

    expect(isAlreadySubmittedError(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('submitFeedback errors', () => {
  const body = { trackingCode: 'SPL1', feedbackToken: 'tok', therapistName: 'Sam', responses: { q1: 5 } };

  it('flags only the explicit already-submitted response as terminal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'Feedback already submitted' }, 400));
    const err = await submitFeedback(body).catch((e: unknown) => e);
    expect(isAlreadySubmittedError(err)).toBe(true);
  });

  it('treats validation / rate-limit failures as retryable, not already-submitted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'Invalid form data' }, 400));
    const validation = await submitFeedback(body).catch((e: unknown) => e);
    expect(validation).toBeInstanceOf(FeedbackApiError);
    expect(isAlreadySubmittedError(validation)).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'Too many requests' }, 429));
    const limited = await submitFeedback(body).catch((e: unknown) => e);
    expect(isAlreadySubmittedError(limited)).toBe(false);
  });

  it('turns an HTML 5xx page into a readable error instead of a JSON SyntaxError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const err = await submitFeedback(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedbackApiError);
    expect((err as Error).message).toBe('Server error (502): Bad Gateway');
    expect(isAlreadySubmittedError(err)).toBe(false);
  });

  it('matches an ALREADY_SUBMITTED code if the backend adds one', () => {
    expect(isAlreadySubmittedError(new FeedbackApiError('Duplicate', 409, 'ALREADY_SUBMITTED'))).toBe(true);
    expect(isAlreadySubmittedError(new Error('Feedback already submitted'))).toBe(false);
  });
});
