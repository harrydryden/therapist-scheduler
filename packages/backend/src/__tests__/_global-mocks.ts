/**
 * Shared mock factories for the unit-test suite.
 *
 * Jest hoists `jest.mock(...)` calls to the top of each test file, so
 * this module can't call them itself — the imports wouldn't have run
 * yet. Instead each test file does:
 *
 *   jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
 *
 * `require` inside the factory is lazy: it runs when the mock is
 * actually instantiated, after the module graph is settled.
 *
 * The factories here cover the dependencies tests don't typically
 * assert call counts on (logger, config, redis, audit, ai-conversation,
 * slack, settings). Mocks the test DOES assert on stay file-local so
 * per-test references work.
 *
 * Adding a new factory? Two rules:
 *   1. Must be a plain function that returns a fresh object on each
 *      call (so per-test isolation is preserved when Jest re-evaluates
 *      the factory).
 *   2. Must shape the returned object the same way the real module
 *      exports — service-name-as-property for class-style services
 *      (e.g. `{ slackNotificationService: ... }`), bare functions for
 *      module-level exports (e.g. `{ getSettingValue }`).
 */

import { Prisma } from '@prisma/client';

export const loggerMock = () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
});

export const configMock = () => ({
  config: {
    jwtSecret: 'test-secret',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
  },
});

export const redisMock = () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  },
});

export const auditEventMock = () => ({
  auditEventService: {
    log: jest.fn(),
    logToolExecuted: jest.fn(),
    logToolFailed: jest.fn(),
    logFactsExtracted: jest.fn(),
  },
});

export const appointmentEventMock = () => ({
  recordAppointmentEvent: jest.fn(),
});

export const aiConversationMock = () => ({
  aiConversationService: { applyCheckpointUpdate: jest.fn() },
  inferRestoredStage: jest.fn(),
});

export const slackNotificationMock = () => ({
  slackNotificationService: {
    sendAlert: jest.fn(),
    notifyAppointmentConfirmed: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
    notifyAppointmentCompleted: jest.fn(),
    notifyHumanReviewFlagged: jest.fn(),
    notifyCancelMatchRecommended: jest.fn(),
  },
});

/**
 * Settings service mock. Tests that need specific settings should
 * write their own factory and pass typed values; this default returns
 * `undefined` for every key, which is the right shape for tests that
 * don't depend on settings content.
 */
export const settingsServiceMock = () => ({
  getSettingValue: jest.fn().mockResolvedValue(undefined),
  getSettingValues: jest.fn().mockResolvedValue(new Map()),
});

/**
 * The exact error Prisma's `update` throws when its where-clause
 * preconditions don't match any row (RecordNotFound). Used to simulate
 * concurrent-write loss in race tests.
 */
export function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'No record was found for an update.',
    { code: 'P2025', clientVersion: 'test' },
  );
}
