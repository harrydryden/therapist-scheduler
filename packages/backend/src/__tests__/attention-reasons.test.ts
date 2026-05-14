/**
 * Unit tests for the "Why this needs attention" reason builder.
 *
 * Every red HealthFactor (and the closure-recommended signal) must
 * produce exactly one AttentionReason with a concrete suggestion.
 * Yellow / green factors must NOT produce reasons (would dilute the
 * banner).
 *
 * Ordering is also tested — operators rely on the top-of-list reason
 * being the most-urgent / most-explicit-admin-prompt one.
 */

import { deriveAttentionReasons } from '../utils/attention-reasons';
import type {
  ConversationHealth,
  HealthFactor,
} from '../services/conversation-health.service';

function factor(overrides: Partial<HealthFactor> & { name: string; status: 'red' | 'yellow' | 'green' }): HealthFactor {
  return {
    value: '',
    threshold: undefined,
    description: '',
    ...overrides,
  };
}

function health(factors: HealthFactor[]): ConversationHealth {
  return {
    status: factors.some((f) => f.status === 'red') ? 'red' : 'green',
    score: 50,
    factors,
    summary: '',
  };
}

describe('deriveAttentionReasons', () => {
  it('returns empty when nothing is flagged', () => {
    expect(
      deriveAttentionReasons({
        health: health([]),
        closureRecommendedAt: null,
        closureRecommendedReason: null,
        closureRecommendationActioned: false,
      }),
    ).toEqual([]);
  });

  it('returns empty when health is null (terminal status)', () => {
    expect(
      deriveAttentionReasons({
        health: null,
        closureRecommendedAt: null,
        closureRecommendedReason: null,
        closureRecommendationActioned: false,
      }),
    ).toEqual([]);
  });

  it('skips yellow factors (only red gets a reason)', () => {
    const reasons = deriveAttentionReasons({
      health: health([
        factor({ name: 'Inactivity', status: 'yellow', value: '20h', threshold: '24h' }),
        factor({ name: 'Progress', status: 'green', value: 'on track' }),
      ]),
      closureRecommendedAt: null,
      closureRecommendedReason: null,
      closureRecommendationActioned: false,
    });
    expect(reasons).toEqual([]);
  });

  it('maps each known red factor name to a kind', () => {
    const reasons = deriveAttentionReasons({
      health: health([
        factor({ name: 'Inactivity', status: 'red', value: '50h', threshold: '48h' }),
        factor({ name: 'Progress', status: 'red', value: '51h', threshold: '48h' }),
        factor({ name: 'Thread Integrity', status: 'red' }),
        factor({ name: 'Tool Execution', status: 'red', value: 'send_email failed' }),
        factor({ name: 'Automation', status: 'red' }),
      ]),
      closureRecommendedAt: null,
      closureRecommendedReason: null,
      closureRecommendationActioned: false,
    });
    expect(reasons.map((r) => r.kind).sort()).toEqual([
      'human_control',
      'inactivity',
      'stall',
      'thread_divergence',
      'tool_failure',
    ]);
  });

  it('ignores unknown factor names', () => {
    const reasons = deriveAttentionReasons({
      health: health([factor({ name: 'NewFactorWeHaventMappedYet', status: 'red' })]),
      closureRecommendedAt: null,
      closureRecommendedReason: null,
      closureRecommendationActioned: false,
    });
    expect(reasons).toEqual([]);
  });

  describe('closure_recommended signal', () => {
    it('surfaces an unactioned closure recommendation', () => {
      const reasons = deriveAttentionReasons({
        health: null,
        closureRecommendedAt: new Date(),
        closureRecommendedReason: 'Client requested cancellation.',
        closureRecommendationActioned: false,
      });
      expect(reasons).toHaveLength(1);
      expect(reasons[0].kind).toBe('closure_recommended');
      expect(reasons[0].detail).toContain('Client requested cancellation.');
    });

    it('omits an actioned recommendation', () => {
      expect(
        deriveAttentionReasons({
          health: null,
          closureRecommendedAt: new Date(),
          closureRecommendedReason: 'Client cancelled.',
          closureRecommendationActioned: true,
        }),
      ).toEqual([]);
    });

    it('truncates very long reasons', () => {
      const reasons = deriveAttentionReasons({
        health: null,
        closureRecommendedAt: new Date(),
        closureRecommendedReason: 'a'.repeat(500),
        closureRecommendationActioned: false,
      });
      // 200-char limit + ellipsis ⇒ at most ~204 chars after the
      // `Reason: "..."` wrapper. Asserting the truncation happened
      // is what matters, not the exact count.
      expect(reasons[0].detail).toContain('…');
      expect(reasons[0].detail.length).toBeLessThan(220);
    });

    it('handles missing reason text gracefully', () => {
      const reasons = deriveAttentionReasons({
        health: null,
        closureRecommendedAt: new Date(),
        closureRecommendedReason: null,
        closureRecommendationActioned: false,
      });
      expect(reasons[0].detail).toBe('The agent flagged this for admin review.');
    });
  });

  describe('ordering', () => {
    it('closure_recommended comes first when both present', () => {
      const reasons = deriveAttentionReasons({
        health: health([
          factor({ name: 'Inactivity', status: 'red', value: '50h', threshold: '48h' }),
          factor({ name: 'Automation', status: 'red' }),
        ]),
        closureRecommendedAt: new Date(),
        closureRecommendedReason: 'cancel',
        closureRecommendationActioned: false,
      });
      expect(reasons[0].kind).toBe('closure_recommended');
    });

    it('orders red factors by triage priority', () => {
      // Spec order: thread_divergence > tool_failure > stall > inactivity > human_control
      const reasons = deriveAttentionReasons({
        health: health([
          factor({ name: 'Automation', status: 'red' }),
          factor({ name: 'Inactivity', status: 'red', value: '50h' }),
          factor({ name: 'Tool Execution', status: 'red' }),
          factor({ name: 'Thread Integrity', status: 'red' }),
          factor({ name: 'Progress', status: 'red', value: '51h' }),
        ]),
        closureRecommendedAt: null,
        closureRecommendedReason: null,
        closureRecommendationActioned: false,
      });
      expect(reasons.map((r) => r.kind)).toEqual([
        'thread_divergence',
        'tool_failure',
        'stall',
        'inactivity',
        'human_control',
      ]);
    });
  });

  it('every reason has a title, detail, and suggestion', () => {
    const reasons = deriveAttentionReasons({
      health: health([
        factor({ name: 'Inactivity', status: 'red', value: '50h', threshold: '48h' }),
        factor({ name: 'Progress', status: 'red', value: '51h', threshold: '48h' }),
        factor({ name: 'Thread Integrity', status: 'red' }),
        factor({ name: 'Tool Execution', status: 'red', value: 'send_email failed' }),
        factor({ name: 'Automation', status: 'red' }),
      ]),
      closureRecommendedAt: new Date(),
      closureRecommendedReason: 'cancel',
      closureRecommendationActioned: false,
    });
    for (const r of reasons) {
      expect(r.title).toBeTruthy();
      expect(r.detail).toBeTruthy();
      expect(r.suggestion).toBeTruthy();
    }
  });
});
