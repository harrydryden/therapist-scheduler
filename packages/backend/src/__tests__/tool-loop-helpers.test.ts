/**
 * Unit tests for the pure helpers used by the booking and availability
 * tool loops. Both functions ship behaviour that the loops rely on at
 * critical control points (skip messaging shown to the model on
 * idempotent retries, per-turn hash key for the same-hash guard) so
 * pinning them here protects against silent drift.
 */

import { buildSkipMessage, computeTurnHash } from '../services/tool-loop-helpers';

describe('buildSkipMessage', () => {
  it('names the outcome for idempotent skips and directs the model to the next step', () => {
    const msg = buildSkipMessage('send_email', 'idempotent');
    expect(msg).toContain('already completed earlier');
    expect(msg).toContain('not an error');
    expect(msg).toContain('continue with the next step');
    expect(msg).toContain('flag_for_human_review');
  });

  it('tells the model to stop responding for human-control skips', () => {
    const msg = buildSkipMessage('mark_scheduling_complete', 'human_control');
    expect(msg).toContain('human control');
    expect(msg).toContain('Stop responding');
    expect(msg).toContain('admin will take over');
  });

  it('falls back to the generic message for an unrecognised skipReason', () => {
    const msg = buildSkipMessage('send_email', 'something_new');
    expect(msg).toBe('Tool send_email skipped: something_new');
  });

  it('falls back to "unknown reason" when skipReason is omitted', () => {
    const msg = buildSkipMessage('send_email');
    expect(msg).toBe('Tool send_email skipped: unknown reason');
  });

  it('includes the tool name in every variant', () => {
    expect(buildSkipMessage('cancel_appointment', 'idempotent')).toContain('cancel_appointment');
    expect(buildSkipMessage('cancel_appointment', 'human_control')).toContain('cancel_appointment');
    expect(buildSkipMessage('cancel_appointment', 'other')).toContain('cancel_appointment');
    expect(buildSkipMessage('cancel_appointment')).toContain('cancel_appointment');
  });
});

describe('computeTurnHash', () => {
  it('returns the same hash for the same (name, input)', () => {
    const a = computeTurnHash('send_email', { to: 'x@y', subject: 's', body: 'b' });
    const b = computeTurnHash('send_email', { to: 'x@y', subject: 's', body: 'b' });
    expect(a).toBe(b);
  });

  it('returns different hashes for different tool names with the same input', () => {
    const input = { to: 'x@y' };
    expect(computeTurnHash('send_email', input)).not.toBe(computeTurnHash('mark_scheduling_complete', input));
  });

  it('returns different hashes for the same tool with different input', () => {
    const a = computeTurnHash('send_email', { to: 'a@y', subject: 's', body: 'b' });
    const b = computeTurnHash('send_email', { to: 'b@y', subject: 's', body: 's' });
    expect(a).not.toBe(b);
  });

  it('is sensitive to input key order (JSON.stringify preserves insertion order)', () => {
    // The same-hash guard is a deliberate exact-arguments match; if the
    // model emits the same logical call with different key order JS treats
    // them as distinct hashes. That's the intended behaviour — we'd rather
    // miss a near-duplicate than block a legitimate retry that happens
    // to serialise differently. This test pins that contract so a future
    // "canonicalise input first" change is a conscious choice.
    const a = computeTurnHash('send_email', { to: 'x', subject: 's' });
    const b = computeTurnHash('send_email', { subject: 's', to: 'x' });
    expect(a).not.toBe(b);
  });

  it('handles null and undefined input deterministically', () => {
    expect(computeTurnHash('flag_for_human_review', null)).toBe('flag_for_human_review:null');
    expect(computeTurnHash('flag_for_human_review', undefined)).toBe('flag_for_human_review:undefined');
  });

  it('produces stable strings for nested objects', () => {
    const a = computeTurnHash('record_availability_window', {
      starts_at: '2026-01-01T10:00:00+00:00',
      ends_at: '2026-01-01T11:00:00+00:00',
      status: 'available',
    });
    const b = computeTurnHash('record_availability_window', {
      starts_at: '2026-01-01T10:00:00+00:00',
      ends_at: '2026-01-01T11:00:00+00:00',
      status: 'available',
    });
    expect(a).toBe(b);
    expect(a).toContain('record_availability_window');
    expect(a).toContain('2026-01-01T10:00:00');
  });
});
