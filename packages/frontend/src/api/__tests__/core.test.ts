/**
 * fetchAdminApi / fetchApi request construction.
 *
 * Guards two bugs:
 *  - Body-less admin mutations (setting reset, Slack test / circuit reset,
 *    weekly-mailing send, work-report generate) were sent with
 *    `Content-Type: application/json` and no body, which Fastify 4 rejects
 *    with 400 FST_ERR_CTP_EMPTY_JSON_BODY.
 *  - `...options` was spread after the merged `headers`, so a caller
 *    passing its own headers dropped the defaults, including the admin
 *    secret.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAdminApi,
  fetchApi,
  verifyAdminSecret,
  AuthError,
  ApiError,
  ADMIN_AUTH_FAILED_EVENT,
  type AdminAuthFailureDetail,
} from '../core';
import { HEADERS } from '../../config/constants';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
}

function okResponse(body: unknown = { success: true, data: { ok: true } }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function lastRequest(): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => okResponse());
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('sessionStorage', memoryStorage({ admin_secret: 's3cret' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAdminApi request body', () => {
  it('sends "{}" for a POST with no body (Fastify rejects empty JSON bodies)', async () => {
    await fetchAdminApi('/admin/slack/test', { method: 'POST' });

    const { init, headers } = lastRequest();
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get(HEADERS.WEBHOOK_SECRET)).toBe('s3cret');
  });

  it('sends "{}" for other body-less mutations too (PATCH / DELETE)', async () => {
    await fetchAdminApi('/admin/x', { method: 'PATCH' });
    expect(lastRequest().init.body).toBe('{}');

    await fetchAdminApi('/admin/x', { method: 'DELETE' });
    expect(lastRequest().init.body).toBe('{}');
  });

  it('leaves an explicit body untouched', async () => {
    const body = JSON.stringify({ reason: 'test' });
    await fetchAdminApi('/admin/x', { method: 'POST', body });
    expect(lastRequest().init.body).toBe(body);
  });

  it('does not add a body to GET requests', async () => {
    await fetchAdminApi('/admin/settings');
    const { init } = lastRequest();
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });
});

describe('fetchAdminApi header merging', () => {
  it('keeps the admin secret and Content-Type when the caller passes its own headers', async () => {
    await fetchAdminApi('/admin/x', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'X-Request-Source': 'test' },
    });

    const { headers } = lastRequest();
    expect(headers.get('X-Request-Source')).toBe('test');
    expect(headers.get(HEADERS.WEBHOOK_SECRET)).toBe('s3cret');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('lets a caller override a default header (e.g. verifying a candidate secret)', async () => {
    await fetchAdminApi('/admin/alerts/count', {
      headers: { [HEADERS.WEBHOOK_SECRET]: 'candidate' },
    });
    expect(lastRequest().headers.get(HEADERS.WEBHOOK_SECRET)).toBe('candidate');
  });

  it('accepts a Headers instance from the caller', async () => {
    await fetchAdminApi('/admin/x', { method: 'POST', headers: new Headers({ 'X-Foo': 'bar' }) });
    const { headers } = lastRequest();
    expect(headers.get('X-Foo')).toBe('bar');
    expect(headers.get(HEADERS.WEBHOOK_SECRET)).toBe('s3cret');
  });
});

describe('fetchApi (public)', () => {
  it('sends "{}" for a body-less POST and merges caller headers', async () => {
    await fetchApi('/public/x', { method: 'POST', headers: { 'X-Foo': 'bar' } });
    const { init, headers } = lastRequest();
    expect(init.body).toBe('{}');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Foo')).toBe('bar');
  });
});

describe('verifyAdminSecret', () => {
  it('sends the candidate secret (not the stored one) and resolves on 200', async () => {
    await expect(verifyAdminSecret('candidate')).resolves.toBeUndefined();
    const { url, headers } = lastRequest();
    expect(url).toBe('/api/admin/alerts/count');
    expect(headers.get(HEADERS.WEBHOOK_SECRET)).toBe('candidate');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong secret with AuthError(401) without retrying or touching the stored secret', async () => {
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener(ADMIN_AUTH_FAILED_EVENT, listener);
    vi.stubGlobal('window', target);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }));

    const err = await verifyAdminSecret('typo').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('admin_secret')).toBe('s3cret');
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a lockout with retryAfter from the Retry-After header', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: 'Too many failed authentication attempts. Please try again later.' }),
      { status: 429, headers: { 'Retry-After': '240' } }
    ));

    const err = await verifyAdminSecret('x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(429);
    expect((err as AuthError).retryAfter).toBe(240);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns a network failure into a readable ApiError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await verifyAdminSecret('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toMatch(/could not reach the server/i);
  });
});

describe('fetchAdminApi auth failures', () => {
  it('clears the secret and dispatches admin-auth-failed with status/retryAfter detail on lockout', async () => {
    const target = new EventTarget();
    const events: CustomEvent<AdminAuthFailureDetail>[] = [];
    target.addEventListener(ADMIN_AUTH_FAILED_EVENT, (e) => events.push(e as CustomEvent<AdminAuthFailureDetail>));
    vi.stubGlobal('window', target);
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: 'Too many failed authentication attempts. Please try again later.' }),
      { status: 429, headers: { 'Retry-After': '120' } }
    ));

    await expect(fetchAdminApi('/admin/settings')).rejects.toBeInstanceOf(AuthError);

    expect(sessionStorage.getItem('admin_secret')).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ status: 429, retryAfter: 120 });
  });

  it('dispatches a 401 detail when the stored secret is rejected', async () => {
    const target = new EventTarget();
    const events: CustomEvent<AdminAuthFailureDetail>[] = [];
    target.addEventListener(ADMIN_AUTH_FAILED_EVENT, (e) => events.push(e as CustomEvent<AdminAuthFailureDetail>));
    vi.stubGlobal('window', target);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }));

    await expect(fetchAdminApi('/admin/settings')).rejects.toBeInstanceOf(AuthError);
    expect(events[0].detail).toMatchObject({ status: 401 });
  });
});
