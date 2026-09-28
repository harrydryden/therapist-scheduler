/**
 * Slack retry queue (review §4.7).
 *
 *   - processQueue used to return early while the Slack breaker was OPEN,
 *     but only execute() moves OPEN → HALF_OPEN and the drain bypassed it,
 *     so after an outage the queue froze until some new alert was sent.
 *   - Items were dropped after three flat 30-second tries (~90s).
 *   - Persistence was a non-atomic get-push-set on a JSON blob.
 * Also covers the group-scoped dedup used by circuit-breaker alerts and the
 * breaker → Slack alert wiring.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const setNXMock = jest.fn();
const evalMock = jest.fn();
const lrangeMock = jest.fn();
const getJsonMock = jest.fn();
const setJsonMock = jest.fn();
jest.mock('../utils/redis', () => ({
  cacheManager: {
    setNX: (...a: unknown[]) => setNXMock(...a),
    eval: (...a: unknown[]) => evalMock(...a),
    lrange: (...a: unknown[]) => lrangeMock(...a),
    delete: jest.fn(),
    getJson: (...a: unknown[]) => getJsonMock(...a),
    setJson: (...a: unknown[]) => setJsonMock(...a),
  },
}));

type SlackModule = typeof import('../services/slack-notification.service');
type BreakerModule = typeof import('../utils/circuit-breaker');

let slack: SlackModule['slackNotificationService'];
let breakerModule: BreakerModule;
let now = 10_000_000;
const fetchMock = jest.fn();
const flush = () => new Promise((r) => setImmediate(r));

const ok = () => Promise.resolve({ ok: true, text: async () => '' });
const serverError = () => Promise.resolve({ ok: false, status: 500, text: async () => 'boom' });

beforeEach(() => {
  jest.clearAllMocks();
  now = 10_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/abc';
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  setNXMock.mockResolvedValue('OK');
  evalMock.mockResolvedValue(null);
  lrangeMock.mockResolvedValue([]);
  // Fresh module graph per test: a clean queue and breaker registry.
  jest.isolateModules(() => {
    slack = require('../services/slack-notification.service').slackNotificationService;
    breakerModule = require('../utils/circuit-breaker');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.SLACK_WEBHOOK_URL;
});

async function alert(title: string) {
  await slack.sendAlert({ title, severity: 'medium', details: `details for ${title}` });
  await flush();
}

describe('Slack retry queue', () => {
  it('drains through the breaker once its reset timeout passes, even though it is OPEN', async () => {
    fetchMock.mockImplementation(serverError);
    for (let i = 0; i < 5; i++) await alert(`A${i}`); // 5 failures → breaker OPEN
    expect(slack.getCircuitStats().state).toBe('OPEN');
    expect(slack.getQueueStats().inMemory).toBe(5);

    fetchMock.mockImplementation(ok);
    now += 31_000; // past the 30s reset timeout

    const result = await slack.processQueue();

    expect(result).toEqual({ processed: 5, failed: 0 });
    expect(slack.getQueueStats().inMemory).toBe(0);
    expect(slack.getCircuitStats().state).toBe('CLOSED');
  });

  it('a breaker rejection does not use up an item\'s retry budget', async () => {
    fetchMock.mockImplementation(serverError);
    for (let i = 0; i < 5; i++) await alert(`B${i}`);
    fetchMock.mockClear();

    // Still inside the reset timeout: the breaker rejects without calling Slack.
    const result = await slack.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(slack.getQueueStats().inMemory).toBe(5);
  });

  it('backs off exponentially and keeps an item well past three failed attempts', async () => {
    fetchMock.mockImplementation(serverError);
    await alert('C'); // initial send fails → queued
    fetchMock.mockClear();

    let delay = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      now += delay;
      await slack.processQueue();
      expect(fetchMock).toHaveBeenCalledTimes(attempt);

      // Not retried again before the (growing) back-off elapses.
      delay = 30_000 * 2 ** (attempt - 1);
      now += delay - 1;
      await slack.processQueue();
      expect(fetchMock).toHaveBeenCalledTimes(attempt);
      delay = 1;
    }

    // Four failed attempts in: the old queue dropped items after three.
    expect(slack.getQueueStats().inMemory).toBe(1);

    fetchMock.mockImplementation(ok);
    now += 30 * 60_000;
    await expect(slack.processQueue()).resolves.toEqual({ processed: 1, failed: 0 });
  });

  it('drops an item after the maximum number of attempts', async () => {
    fetchMock.mockImplementation(serverError);
    await alert('D');
    for (let i = 0; i < 10; i++) {
      now += 31 * 60_000; // beyond any back-off
      await slack.processQueue();
    }
    expect(slack.getQueueStats().inMemory).toBe(0);
  });

  it('persists with an atomic RPUSH/LTRIM script, not a get-push-set blob', async () => {
    fetchMock.mockImplementation(serverError);
    await alert('E');

    const appendCall = evalMock.mock.calls.find((c) => String(c[0]).includes('RPUSH'));
    expect(appendCall).toBeDefined();
    expect(String(appendCall![0])).toContain('LTRIM');
    expect(appendCall![2]).toBe('slack:notification:queue:list');
    expect(JSON.parse(appendCall![3] as string).message.text).toContain('E');
    expect(getJsonMock).not.toHaveBeenCalled();
    expect(setJsonMock).not.toHaveBeenCalled();
  });

  it('restores queued items from the Redis list on startup', async () => {
    lrangeMock.mockResolvedValue([
      JSON.stringify({
        message: { text: 'queued before restart' },
        useUrgentChannel: false,
        queuedAt: new Date(now).toISOString(),
        attempts: 2,
        nextAttemptAt: now,
      }),
    ]);

    await expect(slack.loadPersistedQueue()).resolves.toBe(1);
    expect(slack.getQueueStats().inMemory).toBe(1);

    fetchMock.mockImplementation(ok);
    await expect(slack.processQueue()).resolves.toEqual({ processed: 1, failed: 0 });
  });
});

describe('group-scoped dedup (alerts without an appointment)', () => {
  // SWAP semantics: return the previous title stored for the group.
  let groupState: string | null;
  beforeEach(() => {
    groupState = null;
    evalMock.mockImplementation(async (script: string, _n: number, _key: string, title: string) => {
      if (!script.includes("redis.call('GET'")) return null;
      const previous = groupState;
      groupState = title;
      return previous;
    });
    fetchMock.mockImplementation(ok);
  });

  const breakerAlert = (title: string, details: string) =>
    slack.sendAlert({ title, severity: 'high', details, dedupGroup: 'circuit-breaker:gmail-api' });

  it('suppresses a repeat of the same alert in a group', async () => {
    await breakerAlert('Circuit Breaker Opened', 'instance 1');
    await breakerAlert('Circuit Breaker Opened', 'instance 2');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never suppresses a state change (recovered → opened again)', async () => {
    await breakerAlert('Circuit Breaker Opened', 'x');
    await breakerAlert('Circuit Breaker Recovered', 'x');
    await breakerAlert('Circuit Breaker Opened', 'x again');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('circuit breaker → Slack wiring', () => {
  it('forwards breaker open alerts to sendAlert with the breaker dedupGroup', async () => {
    const sendAlertSpy = jest.spyOn(slack, 'sendAlert').mockResolvedValue(true);
    const cb = new breakerModule.CircuitBreaker({
      name: 'claude-api', failureThreshold: 1, resetTimeout: 1000, successThreshold: 1,
    });

    await cb.execute(() => Promise.reject(new Error('x'))).catch(() => undefined);
    await flush();

    expect(sendAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Circuit Breaker Opened', dedupGroup: 'circuit-breaker:claude-api' }),
    );
  });

  it('does not alert about its own Slack webhook breaker', async () => {
    const sendAlertSpy = jest.spyOn(slack, 'sendAlert');
    fetchMock.mockImplementation(serverError);
    for (let i = 0; i < 5; i++) await alert(`F${i}`);
    await flush();

    expect(slack.getCircuitStats().state).toBe('OPEN');
    // Only our five alerts — no "Circuit Breaker Opened" for slack-webhook.
    expect(sendAlertSpy).toHaveBeenCalledTimes(5);
  });
});
