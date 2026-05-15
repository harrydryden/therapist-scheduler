/**
 * Regression test for the "Turn tool budget exhausted on multi-date
 * therapist reply" incident.
 *
 * Scenario: a therapist replies with N one-off availability windows
 * in a single email. The prompt mandates calling `resolve_local_time`
 * BEFORE every `record_availability_window` (for DST-safe offset
 * computation). Counting both against the per-turn tool budget
 * doubled the budget pressure — a 5-date reply tripped the 8-call
 * budget after just 4 dates, paused the agent for admin review, and
 * required the operator to release control AGAIN.
 *
 * Fix: `resolve_local_time` is now a "pure tool" — it bypasses the
 * turn budget (and was already bypassing the dispatch-layer human-
 * control gate / idempotency mark / ceiling counter). Both layers
 * read from the same `PURE_TOOLS` set so they can't drift.
 *
 * This test pins the contract at the set + predicate level. The
 * loop-level integration would require wiring up the entire
 * Anthropic mock harness — out of scope here. The predicate test
 * fails loudly if a future refactor renames the tool or removes the
 * export, which is the most likely regression path.
 */

import { PURE_TOOLS, isPureTool } from '../core/agent/tools/pure-tools';

describe('PURE_TOOLS contract', () => {
  it('contains resolve_local_time (the budget-bypass + gate-bypass tool)', () => {
    expect(PURE_TOOLS.has('resolve_local_time')).toBe(true);
  });

  it('is a stable shape (changes to this set need explicit review)', () => {
    // Lock the current membership. Adding tools here is fine, but it
    // grants those tools BOTH human-control-gate bypass AND budget
    // bypass — a security-sensitive decision. Updating this snapshot
    // is the "yes I considered the implications" gate.
    expect([...PURE_TOOLS].sort()).toEqual(['resolve_local_time']);
  });
});

describe('isPureTool', () => {
  it('returns true for the resolve_local_time tool', () => {
    expect(isPureTool('resolve_local_time')).toBe(true);
  });

  it('returns false for state-changing tools', () => {
    expect(isPureTool('send_email')).toBe(false);
    expect(isPureTool('record_availability_window')).toBe(false);
    expect(isPureTool('update_therapist_availability')).toBe(false);
    expect(isPureTool('mark_scheduling_complete')).toBe(false);
    expect(isPureTool('cancel_appointment')).toBe(false);
    expect(isPureTool('issue_voucher_code')).toBe(false);
    expect(isPureTool('remember')).toBe(false);
  });

  it('returns false for unknown / typo tool names', () => {
    // Defensive — a misspelled tool name shouldn't accidentally
    // grant bypass.
    expect(isPureTool('resolveLocalTime')).toBe(false);
    expect(isPureTool('resolve-local-time')).toBe(false);
    expect(isPureTool('resolve_local_TIME')).toBe(false);
    expect(isPureTool('')).toBe(false);
  });
});
