/**
 * Regression test for "therapist replied while human-controlled,
 * conversation stalled after release".
 *
 * Root cause: when justin-time skipped agent processing because
 * `humanControlEnabled === true`, the email pipeline still marked
 * the message as `'successfully-processed'`. The missed-message-
 * scanner then skipped it forever, and after admin bulk-release
 * the paused message never reached the agent.
 *
 * The fix wires `loggedWhilePaused: true` through the agent
 * processor result, and the pipeline (process.ts STEP 16) skips
 * the `markMessageProcessed` call when it's set.
 *
 * This file pins:
 *   - The shape of `AgentProcessorResult.loggedWhilePaused` (type-
 *     level — if a refactor renames the flag, the assignment fails
 *     to compile).
 *   - The branching semantics callers use — i.e. "skip marking
 *     when truthy, mark otherwise". The pipeline's actual
 *     `markMessageProcessed` call is inlined inside `process.ts`
 *     with heavy deps; this test exercises an equivalent decision
 *     helper to lock in the contract.
 */

import type { AgentProcessorResult } from '../domain/scheduling/inbound/agent-processor';

/**
 * The pipeline's logic distilled: "should I mark this message
 * processed?" Returns false iff the agent paused itself. Kept in
 * the test file (rather than imported from process.ts) so a
 * refactor that drops the flag breaks compilation here too.
 */
function shouldMarkProcessed(agentResult: AgentProcessorResult | void): boolean {
  return agentResult?.loggedWhilePaused !== true;
}

describe('AgentProcessorResult.loggedWhilePaused', () => {
  it('is a boolean field on the success-but-paused branch', () => {
    const paused: AgentProcessorResult = {
      success: true,
      message: 'Email logged but agent response skipped',
      loggedWhilePaused: true,
    };
    expect(paused.loggedWhilePaused).toBe(true);
  });

  it('is undefined on the normal success branch', () => {
    const handled: AgentProcessorResult = { success: true, message: 'Processed' };
    expect(handled.loggedWhilePaused).toBeUndefined();
  });
});

describe('pipeline decision: should this message be marked processed?', () => {
  it("does NOT mark when loggedWhilePaused is true (the bug-fix path)", () => {
    expect(
      shouldMarkProcessed({
        success: true,
        message: 'Paused',
        loggedWhilePaused: true,
      }),
    ).toBe(false);
  });

  it('marks when loggedWhilePaused is omitted', () => {
    expect(shouldMarkProcessed({ success: true, message: 'Done' })).toBe(true);
  });

  it('marks when loggedWhilePaused is explicitly false', () => {
    expect(
      shouldMarkProcessed({
        success: true,
        message: 'Done',
        loggedWhilePaused: false,
      }),
    ).toBe(true);
  });

  it('marks when the agent processor returns void (legacy callsite)', () => {
    // The interface allows `void` returns for processors that
    // don't surface a structured result. Pipeline must default
    // to marking in that case — the pre-fix behaviour.
    expect(shouldMarkProcessed(undefined)).toBe(true);
  });

  it('does NOT throw when result is null-ish', () => {
    expect(() => shouldMarkProcessed(undefined)).not.toThrow();
    // The TS signature is `AgentProcessorResult | void`, but in
    // practice some callsites pass null. Optional-chaining in the
    // helper handles it.
    expect(shouldMarkProcessed(null as unknown as undefined)).toBe(true);
  });
});
