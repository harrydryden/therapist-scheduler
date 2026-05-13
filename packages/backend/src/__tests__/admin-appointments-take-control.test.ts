/**
 * Tests for the POST /api/admin/dashboard/appointments/:id/take-control
 * endpoint's atomic-claim TOCTOU fix.
 *
 * The previous implementation read `humanControlEnabled` then `update`d
 * unconditionally, so two admins clicking simultaneously could both win
 * — second admin's write overwrites the first's, but first admin's UI/SSE
 * would still report they were in control. The fix replaces the read +
 * update with an atomic `updateMany ... where: { id, humanControlEnabled:
 * false }`. Exactly one of two concurrent claims returns count=1; the
 * other gets count=0 and resolves the actual state via a re-fetch.
 *
 * These tests pin the four branches of the resolve-by-state path:
 *   1. count=1 happy path → 200 success
 *   2. count=0 + missing row → 404
 *   3. count=0 + same admin already holds → 200 idempotent
 *   4. count=0 + different admin holds → 409 with their name
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret-key-for-unit-tests',
    webhookSecret: 'test-webhook-secret',
    backendUrl: 'https://backend.test',
    redisUrl: 'redis://localhost:6379',
    env: 'test',
  },
}));

const updateManyMock = jest.fn();
const findUniqueMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      updateMany: (...args: unknown[]) => updateManyMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      // The route file imports findFirst/findMany/count for other endpoints
      // we don't exercise here — provide bare jest.fn() stubs so the
      // route file loads cleanly.
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  },
}));

// The auditEventService.log + sseService.emitHumanControl side effects
// are fire-and-forget; stubbing them no-op so they don't affect assertions.
jest.mock('../services/appointment-event.service', () => ({
  recordAppointmentEvent: jest.fn().mockResolvedValue(undefined),
  auditEventService: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/sse.service', () => ({
  sseService: {
    emitHumanControl: jest.fn(),
    emitStatusChange: jest.fn(),
  },
}));

// Mock all the heavy services pulled in transitively by the route file
// so route registration completes without real I/O.
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: {},
  InvalidTransitionError: class InvalidTransitionError extends Error {},
  ConcurrentModificationError: class ConcurrentModificationError extends Error {},
}));

jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {},
}));

jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: { sendEmail: jest.fn() },
}));

jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: { appendConversationMessage: jest.fn() },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
}));

jest.mock('../services/conversation-checkpoint.service', () => ({
  ConversationStage: {},
  STAGE_COMPLETION_PERCENTAGE: {},
}));

jest.mock('../services/conversation-health.service', () => ({
  toAppointmentForHealth: jest.fn(),
  computeAppointmentHealthMeta: jest.fn(),
  getHealthThresholds: jest.fn(),
}));

import Fastify, { FastifyInstance } from 'fastify';
import { adminAppointmentRoutes } from '../routes/admin-appointments.routes';

const WEBHOOK_SECRET = 'test-webhook-secret';
const APPOINTMENT_ID = 'apt-1';

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(adminAppointmentRoutes);
  return app;
}

function postTakeControl(app: FastifyInstance, adminId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/admin/dashboard/appointments/${APPOINTMENT_ID}/take-control`,
    headers: { 'x-webhook-secret': WEBHOOK_SECRET },
    payload: { adminId, reason: 'manual review' },
  });
}

describe('POST /api/admin/dashboard/appointments/:id/take-control — atomic claim', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('claims atomically and returns 200 when no one currently holds control (count=1)', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const res = await postTakeControl(app, 'alice@spill.test');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: APPOINTMENT_ID,
      humanControlEnabled: true,
      humanControlTakenBy: 'alice@spill.test',
    });

    // Crucial: the where clause MUST include `humanControlEnabled: false`
    // as a precondition. Without it, the atomic-claim is just a check-
    // then-write and two concurrent claims can both win.
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].where).toMatchObject({
      id: APPOINTMENT_ID,
      humanControlEnabled: false,
    });

    // No re-fetch needed when the claim succeeded.
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the appointment row does not exist (count=0, re-fetch null)', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue(null);

    const res = await postTakeControl(app, 'alice@spill.test');

    expect(res.statusCode).toBe(404);
  });

  it('idempotent: returns 200 when the SAME admin already holds control', async () => {
    // Caller retries (e.g. network blip). updateMany returns count=0 because
    // humanControlEnabled is already true; re-fetch shows we're still the
    // owner — surface success rather than a confusing 409.
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      humanControlEnabled: true,
      humanControlTakenBy: 'alice@spill.test',
    });

    const res = await postTakeControl(app, 'alice@spill.test');

    expect(res.statusCode).toBe(200);
    expect(res.json().data.message).toMatch(/already have control/i);
  });

  it('returns 409 when a DIFFERENT admin already holds control', async () => {
    // The race we explicitly fixed: alice and bob click simultaneously,
    // bob wins the updateMany, alice's claim returns count=0; the
    // re-fetch resolves the actual owner and we report it.
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      humanControlEnabled: true,
      humanControlTakenBy: 'bob@spill.test',
    });

    const res = await postTakeControl(app, 'alice@spill.test');

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('bob@spill.test');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/dashboard/appointments/${APPOINTMENT_ID}/take-control`,
      payload: { adminId: 'alice@spill.test' },
    });

    expect(res.statusCode).toBe(401);
    // Crucial: must not have hit the DB if auth failed.
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
