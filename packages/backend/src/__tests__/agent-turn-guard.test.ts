/**
 * Unit tests for ToolTurnGuard — the per-turn budget + same-hash decision
 * logic shared by the booking and availability tool loops.
 *
 * The e2e wiring (a tripped circuit → flagForHumanReview) is covered by
 * agent-tool-loop-safety-circuits.test.ts for both loops; this file pins the
 * extracted arithmetic in isolation: the pure-tool budget exemption, which
 * paths spend a budget slot, and when each flag trips.
 */

import { ToolTurnGuard } from '../services/agent-turn-guard';

const LIMITS = { budget: 3, sameHashAbortLimit: 3 };
const distinct = (i: number) => ({ n: i });

describe('ToolTurnGuard — budget', () => {
  it('executes up to the budget then skips with turn_budget_exhausted', () => {
    const guard = new ToolTurnGuard(LIMITS);
    expect(guard.evaluate('send_email', distinct(1)).kind).toBe('execute');
    expect(guard.evaluate('send_email', distinct(2)).kind).toBe('execute');
    expect(guard.evaluate('send_email', distinct(3)).kind).toBe('execute');
    expect(guard.toolsThisTurn).toBe(3);

    const decision = guard.evaluate('send_email', distinct(4));
    expect(decision).toMatchObject({ kind: 'skip', bucket: 'turn_budget_exhausted' });
    if (decision.kind === 'skip') {
      expect(decision.content).toMatch(/budget exhausted/i);
    }
    expect(guard.budgetExhausted).toBe(true);
    expect(guard.sameHashAborted).toBe(false);
  });

  it('exempts pure tools from the budget (distinct inputs avoid same-hash)', () => {
    const guard = new ToolTurnGuard({ budget: 1, sameHashAbortLimit: 3 });
    // Many distinct resolve_local_time calls never trip the budget...
    for (let i = 0; i < 10; i++) {
      expect(guard.evaluate('resolve_local_time', distinct(i)).kind).toBe('execute');
    }
    expect(guard.toolsThisTurn).toBe(0);
    expect(guard.budgetExhausted).toBe(false);
    // ...and the single state-changing slot is still available afterwards.
    expect(guard.evaluate('send_email', distinct(99)).kind).toBe('execute');
    expect(guard.evaluate('send_email', distinct(100))).toMatchObject({
      kind: 'skip',
      bucket: 'turn_budget_exhausted',
    });
  });
});

describe('ToolTurnGuard — same-hash', () => {
  it('1st executes, 2nd is blocked with a directive, 3rd aborts', () => {
    const guard = new ToolTurnGuard(LIMITS);
    const input = { note: 'duplicate' };

    expect(guard.evaluate('remember', input).kind).toBe('execute');

    const second = guard.evaluate('remember', input);
    expect(second).toMatchObject({ kind: 'skip', bucket: 'same_hash_blocked', seenCount: 2 });
    if (second.kind === 'skip') expect(second.content).toMatch(/already attempted/i);
    expect(guard.sameHashAborted).toBe(false);

    const third = guard.evaluate('remember', input);
    expect(third).toMatchObject({ kind: 'skip', bucket: 'same_hash_aborted', seenCount: 3 });
    if (third.kind === 'skip') expect(third.content).toMatch(/aborting/i);
    expect(guard.sameHashAborted).toBe(true);
  });

  it('a 2nd-occurrence block spends a budget slot for state-changing tools', () => {
    const guard = new ToolTurnGuard({ budget: 5, sameHashAbortLimit: 3 });
    const input = { note: 'x' };
    expect(guard.evaluate('remember', input).kind).toBe('execute'); // slot 1
    expect(guard.evaluate('remember', input).kind).toBe('skip'); // blocked, slot 2
    expect(guard.toolsThisTurn).toBe(2);
  });

  it('a 2nd-occurrence block does NOT spend a budget slot for pure tools', () => {
    const guard = new ToolTurnGuard({ budget: 5, sameHashAbortLimit: 3 });
    const input = { timezone: 'Europe/London', year: 2026 };
    expect(guard.evaluate('resolve_local_time', input).kind).toBe('execute');
    expect(guard.evaluate('resolve_local_time', input).kind).toBe('skip'); // blocked
    expect(guard.toolsThisTurn).toBe(0);
  });

  it('tracks distinct hashes independently', () => {
    const guard = new ToolTurnGuard(LIMITS);
    expect(guard.evaluate('remember', { a: 1 }).kind).toBe('execute');
    expect(guard.evaluate('remember', { a: 2 }).kind).toBe('execute');
    // Same tool, different input → not a same-hash repeat.
    expect(guard.sameHashAborted).toBe(false);
  });
});

describe('ToolTurnGuard — flags trip at most once and budget wins ties', () => {
  it('returns the budget bucket before computing the hash when the budget is already spent', () => {
    const guard = new ToolTurnGuard({ budget: 1, sameHashAbortLimit: 3 });
    expect(guard.evaluate('send_email', { x: 1 }).kind).toBe('execute');
    // Even a brand-new hash is rejected once the budget is gone.
    const decision = guard.evaluate('send_email', { x: 2 });
    expect(decision).toMatchObject({ kind: 'skip', bucket: 'turn_budget_exhausted', seenCount: 0 });
  });
});
