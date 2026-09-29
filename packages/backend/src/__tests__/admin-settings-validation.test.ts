/**
 * Admin settings write validation (review §4.7).
 *
 * The PATCH endpoints only range-checked numbers (after Number() coercion)
 * and checked enums. A boolean setting accepted the string "false", which
 * is stored as a JSON string and read back truthy — e.g. switching
 * weeklyMailing.enabled ON. Numbers accepted numeric strings, and every
 * template, agent.fromName, general.timezone and weeklyMailing.webAppUrl
 * accepted "" or garbage.
 */

import Fastify, { FastifyInstance } from 'fastify';

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../middleware/auth', () => ({
  verifyWebhookSecret: async () => undefined,
}));
jest.mock('../services/admin-notification.service', () => ({ adminNotificationService: {} }));

const publishMock = jest.fn();
jest.mock('../utils/settings-pubsub', () => ({
  publishSettingsInvalidation: (...a: unknown[]) => publishMock(...a),
}));
jest.mock('../utils/redis', () => ({ cacheManager: { delete: jest.fn() } }));

const upsertMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    systemSetting: {
      upsert: (...a: unknown[]) => upsertMock(...a),
      delete: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));

jest.mock('../services/settings.service', () => ({
  SETTING_DEFINITIONS: jest.requireActual('../config/setting-definitions').SETTING_DEFINITIONS,
  getSettingValue: jest.fn(),
  getSettingValues: jest.fn(),
  getCategorySettings: jest.fn(),
  memoryCacheInvalidate: jest.fn(),
}));

import { adminSettingsRoutes, validateSettingValue } from '../routes/admin-settings.routes';
import { SETTING_DEFINITIONS } from '../config/setting-definitions';

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  upsertMock.mockImplementation(async ({ where, create }: { where: { id: string }; create: { value: string } }) => ({
    id: where.id, value: create.value, updatedAt: new Date(), updatedBy: 'admin',
  }));
  app = Fastify();
  await app.register(adminSettingsRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const patch = (key: string, value: unknown) =>
  app.inject({ method: 'PATCH', url: `/api/admin/settings/${key}`, payload: { value, adminId: 'admin' } });

describe('PATCH /api/admin/settings/:key validation', () => {
  it('rejects the string "false" for a boolean setting', async () => {
    const res = await patch('weeklyMailing.enabled', 'false');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/boolean/);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('accepts a real boolean', async () => {
    const res = await patch('weeklyMailing.enabled', false);

    expect(res.statusCode).toBe(200);
    expect(upsertMock.mock.calls[0][0].update.value).toBe('false');
  });

  it('rejects a numeric string for a number setting', async () => {
    const res = await patch('chase.afterStaleHours', '48');

    expect(res.statusCode).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('still enforces number bounds', async () => {
    const { minValue } = SETTING_DEFINITIONS['postBooking.feedbackFormDelayHours'];
    const res = await patch('postBooking.feedbackFormDelayHours', (minValue ?? 1) - 1);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least/);
  });

  it.each([
    ['email.weeklyMailingSubject', '   '],
    ['email.clientConfirmationBody', ''],
    ['agent.fromName', ''],
    ['agent.fromName', 'Justin\r\nBcc: someone@example.com'],
    ['general.timezone', 'Mars/Olympus_Mons'],
    ['general.timezone', ''],
    ['weeklyMailing.webAppUrl', 'not a url'],
    ['weeklyMailing.webAppUrl', 'javascript:alert(1)'],
  ])('rejects %s = %j', async (key, value) => {
    const res = await patch(key, value);

    expect(res.statusCode).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it.each([
    ['general.timezone', 'America/New_York'],
    ['weeklyMailing.webAppUrl', 'https://free.spill.app/book?ref=weekly'],
    ['agent.fromName', 'Justin Time'],
    ['agent.languageStyle', 'US'],
  ])('accepts %s = %j', async (key, value) => {
    const res = await patch(key, value);

    expect(res.statusCode).toBe(200);
  });

  it('still rejects a value outside an enum', async () => {
    const res = await patch('agent.languageStyle', 'AU');

    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/admin/settings (bulk) validation', () => {
  it('applies the same rules and rejects the whole batch atomically', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      payload: {
        adminId: 'admin',
        settings: [
          { key: 'chase.enabled', value: 'false' },
          { key: 'general.timezone', value: 'Europe/London' },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([{ key: 'chase.enabled', error: expect.stringMatching(/boolean/) }]);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/settings/:key/reset', () => {
  it('tells peer instances to drop their cached value', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/settings/chase.enabled/reset' });

    expect(res.statusCode).toBe(200);
    expect(publishMock).toHaveBeenCalledWith(['chase.enabled']);
  });
});

describe('validateSettingValue', () => {
  it('allows an empty string where blank is legitimate (not a template)', () => {
    expect(validateSettingValue('frontend.therapistPageIntro', SETTING_DEFINITIONS['frontend.therapistPageIntro'], '')).toBeNull();
  });
});
