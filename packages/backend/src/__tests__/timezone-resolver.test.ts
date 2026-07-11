/**
 * Tests for the DST-aware wall-clock → instant resolver.
 *
 * The resolver underwrites the `resolve_local_time` tool both agents
 * call before record_availability_window, so its DST + non-existent +
 * ambiguous behaviours are load-bearing for correctness. These tests
 * pin the contract.
 */

// Import the wall-clock submodule directly; the `core/timezone` barrel
// transitively pulls in DB + config and isn't needed for a pure-math
// resolver test.
import { resolveWallClock, formatIsoWithOffset, formatInTimezone } from '../core/timezone/wall-clock';

describe('resolveWallClock — happy paths', () => {
  it('encodes a UK winter time with the +00:00 offset', () => {
    const r = resolveWallClock('Europe/London', 2026, 0, 15, 10, 30); // Jan 15
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.offsetMinutes).toBe(0);
      expect(formatIsoWithOffset(r.resolved)).toBe('2026-01-15T10:30:00+00:00');
    }
  });

  it('encodes a UK summer time with the +01:00 offset (BST)', () => {
    const r = resolveWallClock('Europe/London', 2026, 5, 15, 10, 30); // Jun 15
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.offsetMinutes).toBe(60);
      expect(formatIsoWithOffset(r.resolved)).toBe('2026-06-15T10:30:00+01:00');
    }
  });

  it('encodes a New York winter time with -05:00 (EST)', () => {
    const r = resolveWallClock('America/New_York', 2026, 0, 15, 14, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.offsetMinutes).toBe(-5 * 60);
      expect(formatIsoWithOffset(r.resolved)).toBe('2026-01-15T14:00:00-05:00');
    }
  });

  it('encodes a New York summer time with -04:00 (EDT)', () => {
    const r = resolveWallClock('America/New_York', 2026, 5, 15, 14, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.offsetMinutes).toBe(-4 * 60);
      expect(formatIsoWithOffset(r.resolved)).toBe('2026-06-15T14:00:00-04:00');
    }
  });

  it('encodes a Sydney AEST time with +10:00', () => {
    const r = resolveWallClock('Australia/Sydney', 2026, 5, 15, 9, 0); // Jun = AEST
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.offsetMinutes).toBe(10 * 60);
    }
  });
});

describe('resolveWallClock — DST transitions', () => {
  it('rejects a non-existent UK spring-forward wall-clock (01:30 on the cutover Sunday does not exist)', () => {
    // UK 2026 spring forward: Sun 29 March 01:00 → 02:00. 01:30 is skipped.
    const r = resolveWallClock('Europe/London', 2026, 2, 29, 1, 30);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('non_existent');
  });

  it('rejects a non-existent New York spring-forward wall-clock', () => {
    // NY 2026 spring forward: Sun 8 March, 02:00 → 03:00. 02:30 is skipped.
    const r = resolveWallClock('America/New_York', 2026, 2, 8, 2, 30);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('non_existent');
  });

  it('rejects an ambiguous UK fall-back wall-clock (01:30 on the cutover Sunday occurs twice)', () => {
    // UK 2026 fall back: Sun 25 October, 02:00 → 01:00. 01:30 occurs
    // twice in local time (once at +01:00, once at +00:00). The
    // resolver's contract — promised to the agent in the prompt and
    // tool descriptions — is to reject this so the agent can ask
    // which occurrence is meant, not silently pick a side.
    const r = resolveWallClock('Europe/London', 2026, 9, 25, 1, 30);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('ambiguous');
  });

  it('accepts an unambiguous wall-clock on the fall-back day outside the transition hour', () => {
    const r = resolveWallClock('Europe/London', 2026, 9, 25, 9, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.offsetMinutes).toBe(0); // GMT by 9am
  });

  it('resolves a 30-minute-shift zone (Lord Howe) without misreporting non-existence', () => {
    // Australia/Lord_Howe uses +10:30/+11:00 with a 30-minute DST
    // shift — exercises the half-hour neighbour probing.
    const r = resolveWallClock('Australia/Lord_Howe', 2026, 5, 15, 9, 0); // June = LHST +10:30
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.offsetMinutes).toBe(10 * 60 + 30);
  });

  it('rejects an invalid IANA timezone', () => {
    const r = resolveWallClock('Atlantis/Capital', 2026, 5, 15, 10, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_timezone');
  });
});

describe('formatInTimezone', () => {
  it('renders a UTC ISO timestamp in the supplied timezone', () => {
    // 14:00 UTC on a June Tuesday = 15:00 BST in London, 10:00 EDT in NY.
    const iso = '2026-06-16T14:00:00Z';
    expect(formatInTimezone(iso, 'Europe/London')).toMatch(/15:00/);
    expect(formatInTimezone(iso, 'America/New_York')).toMatch(/10:00/);
  });

  it('returns the input unchanged when the timezone is invalid', () => {
    const iso = '2026-06-16T14:00:00Z';
    expect(formatInTimezone(iso, 'Atlantis/Capital')).toBe(iso);
  });
});
