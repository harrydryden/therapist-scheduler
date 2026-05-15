/**
 * Unit tests for `validateCancellationInitiator` — the cross-table
 * validator that gates which `cancelledBy` values are allowed for
 * each transition `source`.
 *
 * Why pin this in a test: the admin dashboard now lets operators
 * attribute a cancellation to the therapist or client (driving
 * different email copy on the receive side). The validation table
 * had to be expanded to accept those values for source='admin'
 * — a regression that re-tightens it would silently break the
 * "Who cancelled?" UX without any other test catching it.
 */

// Stub out the heavy imports that `cancelled.ts` pulls in at module
// eval time (logger → config; notifications → slack → redis →
// config). The validator under test is pure synchronous code.
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({
  config: { jwtSecret: 'test', frontendUrl: 'https://test', backendUrl: 'https://test' },
}));
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn() },
}));
jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: { notifyCancelled: jest.fn() },
}));
jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: { onCancelled: jest.fn() },
}));

import { validateCancellationInitiator } from '../domain/scheduling/lifecycle/transitions/cancelled';

describe('validateCancellationInitiator', () => {
  describe('source=admin', () => {
    it.each(['admin', 'client', 'therapist'] as const)(
      'accepts cancelledBy=%s',
      (cancelledBy) => {
        expect(() => validateCancellationInitiator('admin', cancelledBy)).not.toThrow();
      },
    );

    it('rejects cancelledBy=system', () => {
      expect(() => validateCancellationInitiator('admin', 'system')).toThrow(
        /Invalid cancelledBy 'system' for source 'admin'/,
      );
    });
  });

  describe('source=agent', () => {
    it.each(['client', 'therapist'] as const)('accepts cancelledBy=%s', (cancelledBy) => {
      expect(() => validateCancellationInitiator('agent', cancelledBy)).not.toThrow();
    });

    it.each(['admin', 'system'] as const)('rejects cancelledBy=%s', (cancelledBy) => {
      expect(() => validateCancellationInitiator('agent', cancelledBy)).toThrow();
    });
  });

  describe('source=system', () => {
    it.each(['system', 'client'] as const)('accepts cancelledBy=%s', (cancelledBy) => {
      expect(() => validateCancellationInitiator('system', cancelledBy)).not.toThrow();
    });

    it.each(['admin', 'therapist'] as const)('rejects cancelledBy=%s', (cancelledBy) => {
      expect(() => validateCancellationInitiator('system', cancelledBy)).toThrow();
    });
  });

  describe('source=feedback_sync', () => {
    it('accepts cancelledBy=system', () => {
      expect(() => validateCancellationInitiator('feedback_sync', 'system')).not.toThrow();
    });

    it.each(['admin', 'client', 'therapist'] as const)(
      'rejects cancelledBy=%s',
      (cancelledBy) => {
        expect(() => validateCancellationInitiator('feedback_sync', cancelledBy)).toThrow();
      },
    );
  });
});
