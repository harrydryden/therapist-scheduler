/**
 * Unit tests for the `isGmail404` type guard.
 *
 * The guard is shared across all Gmail / googleapis callsites in the
 * inbound + outbound pipelines, the admin reprocess-thread route,
 * and the email-ingest stale-thread checker. A bug here would either
 * silently drop genuine 404s (causing the spurious "Message
 * Processing Failed" Slack alert this helper was added to fix) or
 * incorrectly swallow non-404 errors (masking real failures).
 */

import { isGmail404 } from '../utils/gmail-errors';

describe('isGmail404', () => {
  it('matches errors with code === 404', () => {
    expect(isGmail404({ code: 404, message: 'Requested entity was not found.' })).toBe(true);
  });

  it('matches errors with status === 404 (some SDK versions / retry wrappers)', () => {
    expect(isGmail404({ status: 404, message: 'Requested entity was not found.' })).toBe(true);
  });

  it('matches errors with both code and status set', () => {
    expect(isGmail404({ code: 404, status: 404 })).toBe(true);
  });

  it('does NOT match other HTTP codes', () => {
    expect(isGmail404({ code: 401 })).toBe(false);
    expect(isGmail404({ code: 403 })).toBe(false);
    expect(isGmail404({ code: 429 })).toBe(false);
    expect(isGmail404({ code: 500 })).toBe(false);
    expect(isGmail404({ status: 401 })).toBe(false);
  });

  it('does NOT match non-numeric code/status', () => {
    expect(isGmail404({ code: '404' })).toBe(false);
    expect(isGmail404({ status: '404' })).toBe(false);
  });

  it('returns false for null / undefined / non-objects', () => {
    expect(isGmail404(null)).toBe(false);
    expect(isGmail404(undefined)).toBe(false);
    expect(isGmail404('Requested entity was not found.')).toBe(false);
    expect(isGmail404(404)).toBe(false);
    expect(isGmail404(new Error('not found'))).toBe(false);
  });

  it('returns false for plain Error objects (no code/status property)', () => {
    const err = new Error('something failed');
    expect(isGmail404(err)).toBe(false);
  });
});
