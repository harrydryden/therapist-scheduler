/**
 * Messages deferred because their appointment is under human control.
 *
 * A reply that arrives while an admin holds control is handed to the agent
 * once (it logs "[Received while paused]" into the conversation for the
 * admin) and deliberately left UNMARKED so it is replayed to the agent
 * after release. Without a record of that, every 3-minute poll re-ran the
 * whole pipeline for it — Gmail fetch, classification, closure
 * auto-dismiss, the agent's audit event and special-handling Slack alert —
 * for as long as control lasted (E10).
 *
 * `recordPausedDeferral` remembers the message → appointment pair (Redis
 * key with a TTL, plus a durable DB row for when Redis is down), and
 * `skipIfDeferredWhilePaused` — called before any Gmail work — skips the
 * message while that appointment is still paused. Once control is
 * released the record is cleared and the message runs normally (the
 * release-control replay and the scanner re-drive it).
 *
 * The DB row lives in `ProcessedGmailMessage` under its own id namespace
 * (`deferred:<messageId>`, context `deferred-paused:<appointmentId>`), so
 * it never counts as the message's dedup record.
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { redis } from '../../../utils/redis';

/** Longer than any poll window (3 days) — after that nothing re-polls it. */
export const PAUSED_DEFERRAL_TTL_SECONDS = 7 * 24 * 60 * 60;

const REDIS_PREFIX = 'gmail:deferred-paused:';
const DB_ID_PREFIX = 'deferred:';
const DB_CONTEXT_PREFIX = 'deferred-paused:';

export async function recordPausedDeferral(messageId: string, appointmentId: string): Promise<void> {
  const context = `${DB_CONTEXT_PREFIX}${appointmentId}`;
  await Promise.all([
    redis
      .set(`${REDIS_PREFIX}${messageId}`, appointmentId, 'EX', PAUSED_DEFERRAL_TTL_SECONDS)
      .catch((err) => logger.debug({ messageId, err }, 'Failed to record paused deferral in Redis')),
    prisma.processedGmailMessage
      .upsert({
        where: { id: `${DB_ID_PREFIX}${messageId}` },
        create: { id: `${DB_ID_PREFIX}${messageId}`, context },
        update: { context, processedAt: new Date() },
      })
      .catch((err) => logger.warn({ messageId, err }, 'Failed to record paused deferral in DB')),
  ]);
}

async function getDeferredAppointmentId(messageId: string): Promise<string | null> {
  const cached = await redis.get(`${REDIS_PREFIX}${messageId}`);
  if (cached) return cached;

  const row = await prisma.processedGmailMessage.findUnique({
    where: { id: `${DB_ID_PREFIX}${messageId}` },
    select: { context: true, processedAt: true },
  });
  if (!row || !row.context.startsWith(DB_CONTEXT_PREFIX)) return null;
  if (Date.now() - row.processedAt.getTime() > PAUSED_DEFERRAL_TTL_SECONDS * 1000) return null;
  return row.context.slice(DB_CONTEXT_PREFIX.length);
}

export async function clearPausedDeferral(messageId: string): Promise<void> {
  await Promise.all([
    redis.del(`${REDIS_PREFIX}${messageId}`).catch(() => undefined),
    prisma.processedGmailMessage
      .deleteMany({ where: { id: `${DB_ID_PREFIX}${messageId}` } })
      .catch((err) => logger.warn({ messageId, err }, 'Failed to clear paused deferral row')),
  ]);
}

/** True when the appointment is (still) under human control. */
export async function isUnderHumanControl(appointmentId: string): Promise<boolean> {
  const row = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentId },
    select: { humanControlEnabled: true },
  });
  return row?.humanControlEnabled === true;
}

/**
 * True when `messageId` was deferred for a paused appointment that is
 * still paused — the caller skips it without touching Gmail. When the
 * appointment has been released (or no longer exists) the record is
 * cleared and false is returned, so the message is processed normally.
 */
export async function skipIfDeferredWhilePaused(messageId: string, traceId: string): Promise<boolean> {
  const appointmentId = await getDeferredAppointmentId(messageId);
  if (!appointmentId) return false;

  if (await isUnderHumanControl(appointmentId)) {
    logger.debug(
      { traceId, messageId, appointmentId },
      'Message deferred while appointment is under human control — skipping until release',
    );
    return true;
  }

  await clearPausedDeferral(messageId);
  logger.info(
    { traceId, messageId, appointmentId },
    'Human control released — re-running message deferred while paused',
  );
  return false;
}
