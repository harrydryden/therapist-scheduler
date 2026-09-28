/**
 * SSE connection tickets (review §3 #6): the dashboard no longer puts the
 * admin secret in the EventSource URL. An authenticated POST mints a
 * 60-second single-use ticket; the stream accepts ?ticket= (consumed on
 * use) and still accepts the deprecated ?secret= for one release.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({ config: { webhookSecret: 'test-secret', env: 'test' } }));

jest.mock('../utils/redis', () => ({
  cacheManager: { eval: jest.fn() },
}));

jest.mock('../middleware/auth', () => ({
  verifyWebhookSecret: jest.fn(async (request: { headers: Record<string, string> }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (request.headers['x-webhook-secret'] !== 'test-secret') {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
  }),
  checkAdminSecret: jest.fn(async (_request: unknown, candidate: unknown) =>
    candidate === 'test-secret' ? { ok: true } : { ok: false, status: 401 },
  ),
}));

jest.mock('../utils/database', () => ({ prisma: {} }));
jest.mock('../services/therapist-booking-status.service', () => ({ therapistBookingStatusService: {} }));
jest.mock('../services/message-queue-health.service', () => ({ messageQueueHealthService: {} }));
jest.mock('../services/side-effect-retry.service', () => ({ sideEffectRetryService: {} }));
jest.mock('../domain/scheduling/lifecycle', () => ({ appointmentLifecycleTickService: {} }));
jest.mock('../services/tracking-code.service', () => ({}));
jest.mock('../utils/unique-id', () => ({}));
jest.mock('../routes/admin/appointments/schemas', () => ({ findIdsWithHealth: jest.fn() }));

import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { cacheManager } from '../utils/redis';
import { logger } from '../utils/logger';
import { sseService, SSE_TICKET_TTL_SECONDS } from '../services/sse.service';
import { adminMonitoringRoutes } from '../routes/admin-monitoring.routes';

const evalMock = cacheManager.eval as jest.Mock;

/** A tiny fake of Redis SET/GET-DEL, as the Lua scripts use it. */
function fakeRedis() {
  const store = new Map<string, string>();
  evalMock.mockImplementation(async (script: string, _n: number, key: string, value?: string) => {
    if (script.includes("'SET'")) {
      store.set(key, value ?? '1');
      return 'OK';
    }
    const v = store.get(key) ?? null;
    store.delete(key);
    return v;
  });
  return store;
}

beforeEach(() => {
  jest.clearAllMocks();
  evalMock.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sseService tickets', () => {
  it('a ticket opens exactly one connection', async () => {
    const store = fakeRedis();
    const { ticket, expiresInSeconds } = await sseService.issueTicket();

    expect(expiresInSeconds).toBe(SSE_TICKET_TTL_SECONDS);
    expect(SSE_TICKET_TTL_SECONDS).toBe(60);
    // Stored hashed with a TTL, never as the raw ticket.
    const [, , key, , ttl] = evalMock.mock.calls[0];
    expect(key).not.toContain(ticket);
    expect(ttl).toBe(60);
    expect(store.size).toBe(1);

    expect(await sseService.consumeTicket(ticket)).toBe(true);
    expect(await sseService.consumeTicket(ticket)).toBe(false);
  });

  it('falls back to memory when Redis is down, still single-use and time-limited', async () => {
    evalMock.mockRejectedValue(new Error('Redis not available'));
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-28T10:00:00Z'));

    const first = await sseService.issueTicket();
    expect(await sseService.consumeTicket(first.ticket)).toBe(true);
    expect(await sseService.consumeTicket(first.ticket)).toBe(false);

    const second = await sseService.issueTicket();
    jest.setSystemTime(new Date('2026-09-28T10:01:01Z'));
    expect(await sseService.consumeTicket(second.ticket)).toBe(false);
  });

  it('rejects malformed tickets without a lookup', async () => {
    expect(await sseService.consumeTicket(undefined)).toBe(false);
    expect(await sseService.consumeTicket('short')).toBe(false);
    expect(await sseService.consumeTicket('x'.repeat(40) + '*')).toBe(false);
    expect(evalMock).not.toHaveBeenCalled();
  });
});

describe('SSE routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    fakeRedis();
    jest.spyOn(sseService, 'addConnection').mockImplementation((reply: FastifyReply) => {
      reply.status(200).send({ connected: true });
      return 'conn-1';
    });
    app = Fastify();
    await app.register(adminMonitoringRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /events/ticket requires the admin header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/dashboard/events/ticket' });
    expect(res.statusCode).toBe(401);
  });

  it('mints a ticket that the stream accepts once', async () => {
    const minted = await app.inject({
      method: 'POST',
      url: '/api/admin/dashboard/events/ticket',
      headers: { 'x-webhook-secret': 'test-secret' },
    });
    expect(minted.statusCode).toBe(200);
    expect(minted.headers['cache-control']).toBe('no-store');
    const { ticket, expiresInSeconds } = minted.json().data;
    expect(expiresInSeconds).toBe(60);

    const first = await app.inject({ method: 'GET', url: `/api/admin/dashboard/events?ticket=${ticket}` });
    expect(first.statusCode).toBe(200);
    expect(sseService.addConnection).toHaveBeenCalledTimes(1);

    const replay = await app.inject({ method: 'GET', url: `/api/admin/dashboard/events?ticket=${ticket}` });
    expect(replay.statusCode).toBe(401);
    expect(sseService.addConnection).toHaveBeenCalledTimes(1);
  });

  it('still accepts the deprecated ?secret= for one release, with a warning', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/dashboard/events?secret=test-secret' });
    expect(res.statusCode).toBe(200);
    expect((logger.warn as jest.Mock).mock.calls.some(([, msg]) => /deprecated \?secret=/.test(String(msg)))).toBe(true);
  });

  it('rejects a wrong secret and a missing credential', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/dashboard/events?secret=nope' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/dashboard/events' })).statusCode).toBe(401);
    expect(sseService.addConnection).not.toHaveBeenCalled();
  });
});
