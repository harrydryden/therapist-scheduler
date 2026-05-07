/**
 * Tests for the settings invalidation pub/sub.
 *
 * The bug being fixed: in multi-instance deployment, an admin updating
 * a setting cleared its own instance's memory cache (30 s TTL) and the
 * Redis cache (60 s TTL), but every other instance kept serving the
 * stale value from its own memory cache for up to 30 s.
 *
 * The pub/sub layer publishes invalidation messages on a Redis channel;
 * each instance subscribes at module load and clears its memory cache
 * for the affected keys on receipt.
 *
 * These tests pin the contract:
 *   1. publish goes through `client.publish` with the right channel + JSON shape
 *   2. publish is a safe no-op when Redis is unavailable
 *   3. subscribe wires the channel correctly and dispatches keys to the handler
 *   4. malformed messages are ignored (don't crash the subscriber)
 *   5. subscribe is a no-op in test env (so other test files importing
 *      settings.service don't accidentally open Redis sockets)
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const publishMock = jest.fn();
const duplicateMock = jest.fn();
const subscribeMock = jest.fn();
const onMock = jest.fn();
const quitMock = jest.fn();

let mockClient: unknown = null;

jest.mock('../utils/redis-client', () => ({
  redisClientManager: {
    get client() {
      return mockClient;
    },
  },
}));

import {
  publishSettingsInvalidation,
  subscribeToSettingsInvalidation,
  _resetSettingsPubsubForTests,
} from '../utils/settings-pubsub';

beforeEach(async () => {
  jest.clearAllMocks();
  await _resetSettingsPubsubForTests();
  // Default: simulate a working ioredis client. `duplicate()` returns a
  // separate handle that registers `subscribe` and `on('message')`
  // callbacks as ioredis does.
  mockClient = {
    publish: publishMock,
    duplicate: duplicateMock.mockImplementation(() => ({
      on: onMock,
      subscribe: subscribeMock,
      quit: quitMock,
    })),
  };
  publishMock.mockResolvedValue(1);
});

describe('publishSettingsInvalidation', () => {
  it('publishes a JSON message with the keys on the settings:invalidate channel', async () => {
    await publishSettingsInvalidation(['voucher.required', 'general.maxBookings']);

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [channel, raw] = publishMock.mock.calls[0];
    expect(channel).toBe('settings:invalidate');
    const parsed = JSON.parse(raw as string);
    expect(parsed.keys).toEqual(['voucher.required', 'general.maxBookings']);
  });

  it('is a no-op when keys is empty', async () => {
    await publishSettingsInvalidation([]);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('is a no-op when Redis is unavailable (test env)', async () => {
    mockClient = null;
    await publishSettingsInvalidation(['x']);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('swallows publish failures (peers will see stale cache for ≤30 s but the local update succeeded)', async () => {
    publishMock.mockRejectedValueOnce(new Error('Redis down'));

    // Must not throw — the local memory-cache invalidation already
    // happened in the calling route, so the admin's request is correct
    // even if peers are briefly stale.
    await expect(publishSettingsInvalidation(['x'])).resolves.toBeUndefined();
  });
});

describe('subscribeToSettingsInvalidation', () => {
  it('subscribes to the settings:invalidate channel and dispatches keys to the handler', () => {
    const handler = jest.fn();

    subscribeToSettingsInvalidation(handler);

    expect(duplicateMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith('settings:invalidate', expect.any(Function));

    // Find the 'message' event handler that was registered on the
    // subscriber connection and simulate an inbound message.
    const messageRegistration = onMock.mock.calls.find((call) => call[0] === 'message');
    expect(messageRegistration).toBeDefined();
    const messageHandler = messageRegistration![1] as (channel: string, raw: string) => void;

    messageHandler('settings:invalidate', JSON.stringify({ keys: ['voucher.required'] }));

    expect(handler).toHaveBeenCalledWith(['voucher.required']);
  });

  it('ignores messages for unrelated channels', () => {
    const handler = jest.fn();
    subscribeToSettingsInvalidation(handler);

    const messageHandler = onMock.mock.calls.find((c) => c[0] === 'message')![1] as (
      channel: string,
      raw: string,
    ) => void;
    messageHandler('some:other:channel', JSON.stringify({ keys: ['x'] }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON messages without crashing', () => {
    const handler = jest.fn();
    subscribeToSettingsInvalidation(handler);

    const messageHandler = onMock.mock.calls.find((c) => c[0] === 'message')![1] as (
      channel: string,
      raw: string,
    ) => void;

    // Each of these would throw inside the handler if not caught.
    expect(() => messageHandler('settings:invalidate', '{not json')).not.toThrow();
    expect(() => messageHandler('settings:invalidate', JSON.stringify({ keys: 'not-an-array' }))).not.toThrow();
    expect(() => messageHandler('settings:invalidate', 'null')).not.toThrow();

    expect(handler).not.toHaveBeenCalled();
  });

  it('is idempotent — second call is a no-op', () => {
    const handler1 = jest.fn();
    const handler2 = jest.fn();
    subscribeToSettingsInvalidation(handler1);
    subscribeToSettingsInvalidation(handler2);

    // Only the first call should have opened a subscriber.
    expect(duplicateMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when Redis is unavailable (test env)', () => {
    mockClient = null;
    const handler = jest.fn();
    subscribeToSettingsInvalidation(handler);
    expect(duplicateMock).not.toHaveBeenCalled();
  });
});
