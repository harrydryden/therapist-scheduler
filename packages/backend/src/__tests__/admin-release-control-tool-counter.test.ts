/**
 * Regression test for lifecycle audit L9 — "single release-control leaves
 * ceiling-tripped appointments at the ceiling".
 *
 * The per-appointment tool counter keeps its value (≥ PER_APPOINTMENT_LIMIT)
 * with a 30-day TTL. Only the BULK ceiling-tripped release reset it; the
 * single POST /release-control did not, so the replayed message's first
 * non-pure tool call peeked a count ≥ the limit, flagged the appointment for
 * human review again, and it stayed paused until the key expired.
 *
 * Uses the real appointment-tool-counter helpers against a mocked Redis so
 * the assertion is on the actual key the dispatch pre-flight peeks.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisDelMock = jest.fn().mockResolvedValue(1);
const redisGetMock = jest.fn();
jest.mock('../utils/redis', () => ({
  redis: {
    del: (...a: unknown[]) => redisDelMock(...a),
    get: (...a: unknown[]) => redisGetMock(...a),
    incr: jest.fn(),
    expire: jest.fn(),
  },
}));

const appointmentUpdateMock = jest.fn();
const appointmentFindManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      update: (...a: unknown[]) => appointmentUpdateMock(...a),
      findMany: (...a: unknown[]) => appointmentFindManyMock(...a),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: { appendConversationMessage: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { log: jest.fn() },
}));
jest.mock('../services/sse.service', () => ({
  sseService: { emitHumanControl: jest.fn() },
}));
jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: { checkThreadForUnprocessedReplies: jest.fn() },
}));
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: jest.fn(),
}));

import Fastify, { FastifyInstance } from 'fastify';
import { humanControlRoutes } from '../routes/admin/appointments/human-control';
import { peekAppointmentToolCount } from '../services/appointment-tool-counter';
import { TOOL_EXECUTION } from '../constants';

const APPOINTMENT_ID = 'apt-ceiling';
const COUNTER_KEY = `${TOOL_EXECUTION.COUNT_PREFIX}${APPOINTMENT_ID}`;

describe('POST /release-control — resets the per-appointment tool counter (L9)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = Fastify();
    await app.register(humanControlRoutes);
    appointmentUpdateMock.mockResolvedValue({
      id: APPOINTMENT_ID,
      gmailThreadId: 'thread-u',
      therapistGmailThreadId: null,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('deletes the counter key so the next tool call does not re-trip the ceiling', async () => {
    // Counter sitting at the ceiling, as flagForHumanReview left it.
    let counter: string | null = String(TOOL_EXECUTION.PER_APPOINTMENT_LIMIT);
    redisGetMock.mockImplementation(async (key: string) => (key === COUNTER_KEY ? counter : null));
    redisDelMock.mockImplementation(async (key: string) => {
      if (key === COUNTER_KEY) counter = null;
      return 1;
    });
    expect(await peekAppointmentToolCount(APPOINTMENT_ID)).toBeGreaterThanOrEqual(
      TOOL_EXECUTION.PER_APPOINTMENT_LIMIT,
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/dashboard/appointments/${APPOINTMENT_ID}/release-control`,
    });

    expect(res.statusCode).toBe(200);
    expect(redisDelMock).toHaveBeenCalledWith(COUNTER_KEY);
    // The dispatch pre-flight peek now sees a fresh budget.
    expect(await peekAppointmentToolCount(APPOINTMENT_ID)).toBe(0);
  });

  it('resets the counter before flipping humanControlEnabled off (no window to re-trip)', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/admin/dashboard/appointments/${APPOINTMENT_ID}/release-control`,
    });

    expect(redisDelMock).toHaveBeenCalledTimes(1);
    expect(appointmentUpdateMock).toHaveBeenCalledTimes(1);
    expect(redisDelMock.mock.invocationCallOrder[0]).toBeLessThan(
      appointmentUpdateMock.mock.invocationCallOrder[0],
    );
    expect(appointmentUpdateMock.mock.calls[0][0]).toMatchObject({
      where: { id: APPOINTMENT_ID },
      data: { humanControlEnabled: false },
    });
  });

  it('still releases control when Redis is unavailable (counter reset falls open)', async () => {
    redisDelMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/dashboard/appointments/${APPOINTMENT_ID}/release-control`,
    });

    expect(res.statusCode).toBe(200);
    expect(appointmentUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('bulk ceiling-tripped release still resets each counter (unchanged)', async () => {
    appointmentFindManyMock.mockResolvedValue([
      { id: 'apt-a', gmailThreadId: null, therapistGmailThreadId: null },
      { id: 'apt-b', gmailThreadId: null, therapistGmailThreadId: null },
    ]);
    appointmentUpdateMock.mockResolvedValue({ id: 'x' });

    const res = await app.inject({ method: 'POST', url: '/api/admin/dashboard/release-ceiling-tripped' });

    expect(res.statusCode).toBe(200);
    expect(redisDelMock).toHaveBeenCalledWith(`${TOOL_EXECUTION.COUNT_PREFIX}apt-a`);
    expect(redisDelMock).toHaveBeenCalledWith(`${TOOL_EXECUTION.COUNT_PREFIX}apt-b`);
  });
});
