/**
 * Settings reads fall back to the last known good value (review §4.7).
 *
 * On a DB/Redis read failure getSettingValue used to return the hard-coded
 * default. Kill switches whose default is true (chase.enabled,
 * therapistNudge.enabled, notifications.email.*) therefore flipped back ON
 * during a database blip, after an admin had turned them off.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../utils/settings-pubsub', () => ({ subscribeToSettingsInvalidation: jest.fn() }));
jest.mock('../utils/redis', () => ({
  cacheManager: { getJson: jest.fn().mockResolvedValue(null), setJson: jest.fn() },
}));

const findUniqueMock = jest.fn();
const findManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    systemSetting: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      findMany: (...a: unknown[]) => findManyMock(...a),
    },
  },
}));

import { getSettingValue, getSettingValues, memoryCacheInvalidate } from '../services/settings.service';
import { SETTING_DEFINITIONS } from '../config/setting-definitions';

const dbDown = () => Promise.reject(new Error('connection terminated'));

beforeEach(() => {
  jest.clearAllMocks();
  memoryCacheInvalidate('chase.enabled');
  memoryCacheInvalidate('therapistNudge.enabled');
  memoryCacheInvalidate('voucher.required');
});

describe('getSettingValue during a read failure', () => {
  it('returns the last value it read, not the default, so a kill switch stays off', async () => {
    expect(SETTING_DEFINITIONS['chase.enabled'].defaultValue).toBe(true);
    findUniqueMock.mockResolvedValueOnce({ id: 'chase.enabled', value: 'false' });
    await expect(getSettingValue('chase.enabled')).resolves.toBe(false);

    memoryCacheInvalidate('chase.enabled'); // memory cache expired
    findUniqueMock.mockImplementationOnce(dbDown);

    await expect(getSettingValue('chase.enabled')).resolves.toBe(false);
  });

  it('falls back to the default only when it has never read the key', async () => {
    findUniqueMock.mockImplementationOnce(dbDown);

    await expect(getSettingValue('voucher.required')).resolves.toBe(
      SETTING_DEFINITIONS['voucher.required'].defaultValue,
    );
  });
});

describe('getSettingValues during a read failure', () => {
  it('returns last known good values for the batch', async () => {
    findManyMock.mockResolvedValueOnce([{ id: 'therapistNudge.enabled', value: 'false' }]);
    const first = await getSettingValues(['therapistNudge.enabled']);
    expect(first.get('therapistNudge.enabled')).toBe(false);

    memoryCacheInvalidate('therapistNudge.enabled');
    findManyMock.mockImplementationOnce(dbDown);

    const second = await getSettingValues(['therapistNudge.enabled']);
    expect(second.get('therapistNudge.enabled')).toBe(false);
  });

  it('shares the last known good value with getSettingValue', async () => {
    findManyMock.mockResolvedValueOnce([{ id: 'chase.enabled', value: 'false' }]);
    await getSettingValues(['chase.enabled']);

    memoryCacheInvalidate('chase.enabled');
    findUniqueMock.mockImplementationOnce(dbDown);

    await expect(getSettingValue('chase.enabled')).resolves.toBe(false);
  });
});
