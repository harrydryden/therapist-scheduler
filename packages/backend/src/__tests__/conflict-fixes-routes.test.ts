/**
 * Two-sources-of-truth fixes from docs/SYSTEM_REVIEW_2026-09.md §6:
 *   C6  a voucher is validated against its OWN expiry, not the global setting
 *   C8  saving a feedback form keeps each question's maxWords
 *   C10 one shared country validator on every write path; unknown codes rejected
 *   C13 the ATS route enforces the shared therapist-category enums
 * plus the appointment:activity SSE emission from appointment-event.service.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret-key-for-unit-tests',
    webhookSecret: 'test-webhook-secret',
    backendUrl: 'https://backend.test',
    env: 'test',
  },
}));

jest.mock('../middleware/auth', () => ({
  verifyWebhookSecret: jest.fn(async () => undefined),
  checkAdminSecret: jest.fn(),
}));

jest.mock('../utils/database', () => ({
  prisma: {
    user: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    therapist: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    feedbackFormConfig: { upsert: jest.fn(), findUnique: jest.fn() },
    therapistConversation: { findFirst: jest.fn() },
    voucherTracking: { findUnique: jest.fn() },
  },
}));

jest.mock('../utils/redis', () => ({ cacheManager: { eval: jest.fn(), getStrict: jest.fn(), getString: jest.fn() } }));
jest.mock('../services/audit-event.service', () => ({ auditEventService: { log: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn().mockResolvedValue(true) },
}));
jest.mock('../services/knowledge.service', () => ({ knowledgeService: {} }));
jest.mock('../services/therapist-booking-status.service', () => ({ therapistBookingStatusService: {} }));
jest.mock('../services/justin-time.service', () => ({ JustinTimeService: jest.fn() }));
jest.mock('../domain/scheduling/availability/agent/service', () => ({
  supersedeActiveTherapistConversationInTx: jest.fn(),
  AvailabilityAgentService: { instance: jest.fn() },
}));
jest.mock('../utils/unique-id', () => ({
  getOrCreateUser: jest.fn(),
  getOrCreateTherapist: jest.fn(),
}));
jest.mock('../services/tracking-code.service', () => ({ getOrCreateTrackingCode: jest.fn() }));
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
  getSettingValues: jest.fn(async () => new Map()),
}));

import Fastify, { FastifyInstance } from 'fastify';
import {
  getDefaultTimezone,
  parseCountryCode,
} from '@therapist-scheduler/shared';
import { prisma } from '../utils/database';
import { getOrCreateTherapist } from '../utils/unique-id';
import { signTimestampedToken } from '../utils/hmac-token';
import { generateVoucherToken, getVoucherExpiresAt, validateVoucherToken } from '../utils/voucher-token';
import { sseService } from '../services/sse.service';
import { recordAppointmentEvent, notifyAppointmentActivity } from '../services/appointment-event.service';
import { adminContentRoutes } from '../routes/admin-content.routes';
import { adminUserRoutes } from '../routes/admin-users.routes';
import { adminTherapistRoutes } from '../routes/admin-therapists.routes';
import { atsIntegrationRoutes } from '../routes/ats-integration.routes';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

async function buildApp(plugin: (f: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(plugin);
  return app;
}

describe('C6: voucher expiry is the voucher\'s own', () => {
  it('a 30-day voucher is still valid on day 20 even when the global setting is 14 days', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    const { token, expiresAt } = generateVoucherToken('jamie@example.com', 30);
    expect(expiresAt.toISOString()).toBe('2026-10-01T12:00:00.000Z');

    jest.setSystemTime(new Date('2026-09-21T12:00:00Z'));
    const result = validateVoucherToken(token, 14);
    expect(result).toMatchObject({ valid: true, expired: false, email: 'jamie@example.com' });

    jest.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    expect(validateVoucherToken(token, 60)).toMatchObject({ valid: false, expired: true });
  });

  it('a legacy token (no signed validity) still uses the global setting', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    const legacy = signTimestampedToken({ context: 'voucher-token-v1', version: 'v1', payload: 'jamie@example.com' });
    jest.setSystemTime(new Date(Date.parse('2026-09-01T12:00:00Z') + 10 * DAY));
    expect(validateVoucherToken(legacy, 14)).toMatchObject({ valid: true, email: 'jamie@example.com' });
    expect(validateVoucherToken(legacy, 7)).toMatchObject({ valid: false, expired: true });
    expect(getVoucherExpiresAt(legacy, 14)?.toISOString()).toBe('2026-09-15T12:00:00.000Z');
  });

  it('the signed validity cannot be edited', () => {
    const { token } = generateVoucherToken('jamie@example.com', 7);
    const [v, ts, , sig] = token.split(':');
    const forged = [v, ts, Buffer.from('jamie@example.com\n365').toString('base64url'), sig].join(':');
    expect(validateVoucherToken(forged, 14)).toMatchObject({ valid: false, email: null });
  });
});

describe('C8: feedback form save keeps maxWords', () => {
  it('passes maxWords through to the stored questions', async () => {
    (prisma.feedbackFormConfig.upsert as jest.Mock).mockImplementation(async ({ update }) => update);
    const app = await buildApp(adminContentRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/forms/feedback',
      payload: {
        questions: [{ id: 'q1', type: 'text', question: 'Anything else?', required: false, maxWords: 150 }],
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const saved = (prisma.feedbackFormConfig.upsert as jest.Mock).mock.calls[0][0].update.questions;
    expect(saved[0].maxWords).toBe(150);
  });
});

describe('C10: one country validator', () => {
  it('normalises supported codes and rejects everything else', () => {
    expect(parseCountryCode(' us ')).toBe('US');
    expect(parseCountryCode('UK')).toBe('UK');
    expect(parseCountryCode('USA')).toBeNull();
    expect(parseCountryCode('GB')).toBeNull();
    expect(parseCountryCode('')).toBeNull();
    expect(parseCountryCode(42)).toBeNull();
  });

  it('an unknown code no longer resolves to London time', () => {
    expect(getDefaultTimezone('USA')).toBeNull();
    expect(getDefaultTimezone('XX')).toBeNull();
    // A missing code keeps the legacy UK default (column default).
    expect(getDefaultTimezone(null)).toBe('Europe/London');
    expect(getDefaultTimezone('')).toBe('Europe/London');
    expect(getDefaultTimezone('IE')).toBe('Europe/Dublin');
  });

  it('admin user PATCH rejects an unknown code and normalises a known one', async () => {
    const app = await buildApp(adminUserRoutes);
    const bad = await app.inject({ method: 'PATCH', url: '/api/admin/users/u1', payload: { country: 'USA' } });
    expect(bad.statusCode).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', email: 'a@example.com', subscribed: true });
    (prisma.user.update as jest.Mock).mockResolvedValue({ id: 'u1', email: 'a@example.com', country: 'US', subscribed: true });
    await app.inject({ method: 'PATCH', url: '/api/admin/users/u1', payload: { country: 'us' } });
    await app.close();
    expect((prisma.user.update as jest.Mock).mock.calls[0][0].data.country).toBe('US');
  });

  it('admin therapist PATCH rejects an unknown code', async () => {
    const app = await buildApp(adminTherapistRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/therapists/t1', payload: { country: 'Narnia' } });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(prisma.therapist.update).not.toHaveBeenCalled();
  });
});

describe('C13 + C10: ATS therapist ingestion', () => {
  const base = { externalId: 'ext-1', name: 'Dr Rivers', email: 'rivers@example.com' };

  it('rejects a category outside the shared enum', async () => {
    const app = await buildApp(atsIntegrationRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ats/therapists',
      payload: { ...base, approach: ['Vibes-Based Therapy'] },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(getOrCreateTherapist).not.toHaveBeenCalled();
  });

  it('rejects an unknown country and stores a known one', async () => {
    const app = await buildApp(atsIntegrationRoutes);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/ats/therapists', payload: { ...base, country: 'USA' } });
    expect(bad.statusCode).toBe(400);

    (prisma.therapist.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.therapistConversation.findFirst as jest.Mock).mockResolvedValue({ id: 'already-onboarding' });
    const now = new Date();
    (getOrCreateTherapist as jest.Mock).mockResolvedValue({
      id: 't1', odId: '1', notionId: 'ext-1', name: 'Dr Rivers', email: 'rivers@example.com', createdAt: now, updatedAt: now,
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/ats/therapists',
      payload: { ...base, country: 'us', approach: ['Mindfulness'] },
    });
    await app.close();
    expect(ok.statusCode).toBe(201);
    expect(getOrCreateTherapist).toHaveBeenCalledWith('ext-1', 'rivers@example.com', 'Dr Rivers', 'US');
  });
});

describe('appointment:activity SSE emission', () => {
  it('recordAppointmentEvent tells open dashboards the appointment changed', async () => {
    const emit = jest.spyOn(sseService, 'emitActivity');
    await recordAppointmentEvent({ appointmentId: 'apt-1', type: 'chase_sent', actor: 'system' });
    expect(emit).toHaveBeenCalledWith('apt-1', 'chase_sent');
  });

  it('notifyAppointmentActivity never throws', () => {
    jest.spyOn(sseService, 'emitActivity').mockImplementation(() => {
      throw new Error('bus down');
    });
    expect(() => notifyAppointmentActivity('apt-1', 'admin_message')).not.toThrow();
  });
});
