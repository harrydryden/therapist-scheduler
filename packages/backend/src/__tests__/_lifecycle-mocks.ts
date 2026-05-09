/**
 * Shared mock factories and helpers for lifecycle/appointment tests.
 *
 * Jest hoists `jest.mock(...)` calls to the top of each test file, so
 * this module can't call them itself — the imports wouldn't have run
 * yet. Instead each test file does:
 *
 *   jest.mock('../utils/logger', () => require('./_lifecycle-mocks').loggerMock());
 *
 * `require` inside the factory is lazy: it runs when the mock is
 * actually instantiated, after the module graph is settled.
 *
 * The factories cover dependencies tests don't typically assert call
 * counts on (logger, config, redis, audit, ai-conversation, slack).
 * Mocks the test DOES assert on (notifyConfirmed, applyLightTransition,
 * findUnique/update) stay file-local so per-test references work.
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
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
});

export const auditEventMock = () => ({
  auditEventService: { log: jest.fn() },
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
  },
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
