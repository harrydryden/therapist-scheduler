/**
 * E10 — paused (human-control) messages were re-run through the whole
 * inbound pipeline on every 3-minute poll for as long as control lasted.
 * paused-deferral.ts records the message → appointment pair (Redis with a
 * TTL, durable DB row when Redis is down) and skips the message until the
 * appointment is released.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const redisStore = new Map<string, string>();
let redisDown = false;
jest.mock('../utils/redis', () => ({
  redis: {
    get: jest.fn(async (key: string) => (redisDown ? null : redisStore.get(key) ?? null)),
    set: jest.fn(async (key: string, value: string) => {
      if (!redisDown) redisStore.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => { redisStore.delete(key); }),
  },
}));

const rows = new Map<string, { id: string; context: string; processedAt: Date }>();
const appointments = new Map<string, { humanControlEnabled: boolean }>();
jest.mock('../utils/database', () => ({
  prisma: {
    processedGmailMessage: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.id);
        if (existing) Object.assign(existing, update);
        else rows.set(where.id, { ...create, processedAt: new Date() });
      }),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      deleteMany: jest.fn(async ({ where }: any) => ({ count: rows.delete(where.id) ? 1 : 0 })),
    },
    appointmentRequest: {
      findUnique: jest.fn(async ({ where }: any) => appointments.get(where.id) ?? null),
    },
  },
}));

import {
  recordPausedDeferral,
  skipIfDeferredWhilePaused,
  PAUSED_DEFERRAL_TTL_SECONDS,
} from '../domain/scheduling/inbound/paused-deferral';

beforeEach(() => {
  redisStore.clear();
  rows.clear();
  appointments.clear();
  redisDown = false;
});

describe('paused-deferral', () => {
  it('does not skip a message that was never deferred', async () => {
    expect(await skipIfDeferredWhilePaused('msg-1', 't')).toBe(false);
  });

  it('skips a deferred message while its appointment is still paused', async () => {
    appointments.set('apt-1', { humanControlEnabled: true });
    await recordPausedDeferral('msg-1', 'apt-1');

    expect(await skipIfDeferredWhilePaused('msg-1', 't')).toBe(true);
    expect(await skipIfDeferredWhilePaused('msg-1', 't')).toBe(true);
  });

  it('stops skipping — and forgets the deferral — once control is released', async () => {
    appointments.set('apt-1', { humanControlEnabled: true });
    await recordPausedDeferral('msg-1', 'apt-1');

    appointments.set('apt-1', { humanControlEnabled: false });
    expect(await skipIfDeferredWhilePaused('msg-1', 't')).toBe(false);
    expect(redisStore.size).toBe(0);
    expect(rows.size).toBe(0);
  });

  it('works from the DB row when Redis is unavailable', async () => {
    appointments.set('apt-1', { humanControlEnabled: true });
    redisDown = true;
    await recordPausedDeferral('msg-1', 'apt-1');

    expect(rows.get('deferred:msg-1')?.context).toBe('deferred-paused:apt-1');
    expect(await skipIfDeferredWhilePaused('msg-1', 't')).toBe(true);
  });

  it('ignores a DB deferral older than the TTL', async () => {
    appointments.set('apt-1', { humanControlEnabled: true });
    rows.set('deferred:msg-1', {
      id: 'deferred:msg-1',
      context: 'deferred-paused:apt-1',
      processedAt: new Date(Date.now() - (PAUSED_DEFERRAL_TTL_SECONDS + 60) * 1000),
    });

    expect(await skipIfDeferredWhilePaused('msg-1', 't')).toBe(false);
  });

  it('never writes the message\'s own dedup row', async () => {
    await recordPausedDeferral('msg-1', 'apt-1');
    expect(rows.has('msg-1')).toBe(false);
  });
});
