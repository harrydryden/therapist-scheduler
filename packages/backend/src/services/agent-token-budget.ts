/**
 * Daily Claude token budget for the agent loops.
 *
 * Every Claude call made by the booking and availability tool loops adds
 * its `usage` to a per-UTC-day Redis counter. Before each call the loops
 * check the counter against the `agent.dailyTokenBudget` setting; once it
 * is exhausted they escalate the conversation to human review instead of
 * calling Claude, so a reprocessing storm or a runaway conversation can't
 * run up an unbounded bill overnight. A Slack alert fires once per day at
 * 80% and once at 100%.
 *
 * What counts: input + cache-creation + cache-read + output tokens, i.e.
 * every token the API processed for us. That over-weights cache reads
 * (billed at ~0.1x) on purpose — the budget is a runaway guard, and a
 * simple, explainable number beats a cost model admins can't check
 * against the console.
 *
 * Failure policy: a Redis outage must not pause every conversation, so an
 * unreadable counter reads as 0 (fail open) and a failed increment is
 * logged and dropped. The per-turn guards in agent-tool-loop.ts still
 * bound spend per conversation.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import { redis, cacheManager } from '../utils/redis';
import { getSettingValue } from './settings.service';

/** Matches the `agent.dailyTokenBudget` definition's default. */
export const DEFAULT_DAILY_TOKEN_BUDGET = 50_000_000;

const KEY_PREFIX = 'agent:token-budget:';
/** Counters and alert guards outlive their day by a day, then expire. */
const KEY_TTL_SECONDS = 2 * 24 * 60 * 60;
/** Fractions of the budget at which a one-per-day Slack alert fires. */
const ALERT_THRESHOLDS = [0.8, 1] as const;

// INCRBY + EXPIRE in one round-trip, atomically, so a crash between the
// two can't leave a counter that never expires.
const INCRBY_WITH_EXPIRY = `
local total = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return total
`;

export interface DailyTokenBudgetStatus {
  exhausted: boolean;
  used: number;
  /** 0 = budget disabled. */
  budget: number;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function counterKey(now: Date): string {
  return `${KEY_PREFIX}${utcDay(now)}`;
}

/** Tokens a response consumed, as counted against the budget. */
export function tokensUsed(usage: Anthropic.Usage | null | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

async function readBudget(): Promise<number> {
  try {
    const value = await getSettingValue<number>('agent.dailyTokenBudget');
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_DAILY_TOKEN_BUDGET;
  } catch {
    return DEFAULT_DAILY_TOKEN_BUDGET;
  }
}

/** Today's usage against the budget. Fails open (used = 0) if Redis can't be read. */
export async function getDailyTokenBudgetStatus(now: Date = new Date()): Promise<DailyTokenBudgetStatus> {
  const budget = await readBudget();
  if (budget === 0) return { exhausted: false, used: 0, budget };
  let used = 0;
  try {
    used = Number(await redis.get(counterKey(now))) || 0;
  } catch {
    used = 0;
  }
  return { exhausted: used >= budget, used, budget };
}

async function alertOncePerDay(threshold: number, used: number, budget: number, now: Date): Promise<void> {
  const percent = Math.round(threshold * 100);
  try {
    const first = await cacheManager.setNX(`${KEY_PREFIX}alerted:${percent}:${utcDay(now)}`, '1', KEY_TTL_SECONDS);
    if (first !== 'OK') return;
  } catch {
    // No guard → no alert, rather than an alert on every call.
    return;
  }
  const exhausted = threshold >= 1;
  try {
    // Loaded lazily: this module sits in the agent loops' import graph,
    // and the Slack service carries module-level wiring (breaker alert
    // sink, persisted retry queue) that the loops don't otherwise need.
    const { slackNotificationService } = await import('./slack-notification.service');
    await slackNotificationService.sendAlert({
      title: exhausted ? 'Daily Claude token budget exhausted' : `Daily Claude token budget ${percent}% used`,
      severity: exhausted ? 'critical' : 'high',
      details: exhausted
        ? `The agents have used *${used.toLocaleString('en-GB')}* of the *${budget.toLocaleString('en-GB')}* tokens allowed today (UTC). New agent turns are being paused for human review until the budget resets at midnight UTC — raise \`agent.dailyTokenBudget\` to resume sooner.`
        : `The agents have used *${used.toLocaleString('en-GB')}* of the *${budget.toLocaleString('en-GB')}* tokens allowed today (UTC). At 100% new agent turns are paused for human review.`,
    });
  } catch (err) {
    logger.warn({ err, percent }, 'Failed to send token-budget alert');
  }
}

/**
 * Add one response's usage to today's counter and alert on crossing a
 * threshold. Never throws — accounting must not fail a turn.
 */
export async function recordTokenUsage(
  usage: Anthropic.Usage | null | undefined,
  meta: { traceId: string; context: string },
  now: Date = new Date(),
): Promise<void> {
  const tokens = tokensUsed(usage);
  if (tokens <= 0) return;

  let total: number;
  try {
    total = Number(await redis.eval(INCRBY_WITH_EXPIRY, 1, counterKey(now), tokens, KEY_TTL_SECONDS));
  } catch (err) {
    logger.warn({ err, traceId: meta.traceId, context: meta.context, tokens }, 'Failed to record Claude token usage against the daily budget');
    return;
  }
  if (!Number.isFinite(total)) return;

  const budget = await readBudget();
  if (budget === 0) return;
  for (const threshold of ALERT_THRESHOLDS) {
    if (total >= budget * threshold) {
      await alertOncePerDay(threshold, total, budget, now);
    }
  }
}
