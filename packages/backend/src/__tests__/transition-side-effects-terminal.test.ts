/**
 * Invariants for terminal-transition side effects (cancel / complete /
 * admin-force terminal):
 *
 * 1. `hasConfirmedBooking` is ALWAYS cleared via unmarkConfirmed, regardless
 *    of the previous status. Gating it on "previous status === confirmed"
 *    stranded the flag when cancellation happened from session_held /
 *    feedback_requested, hiding the therapist from the public finder with no
 *    admin remedy (unmarkConfirmed itself is self-guarding).
 *
 * 2. The therapist's `active` flag (public booking-page visibility) is NEVER
 *    written by lifecycle side effects — it is an admin-only toggle. This
 *    pins the removal of the old auto-archive behaviour.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

// Run tracked side-effect tasks inline so assertions can await them.
jest.mock('../services/side-effect-harness', () => ({
  runTrackedSideEffect: (
    _appointmentId: string,
    _transition: string,
    _effectType: string,
    task: () => Promise<unknown>,
  ) => task(),
}));

const mockUnmarkConfirmed = jest.fn();
const mockMarkConfirmed = jest.fn();
const mockRecalculate = jest.fn();
jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {
    unmarkConfirmed: (...a: unknown[]) => mockUnmarkConfirmed(...a),
    markConfirmed: (...a: unknown[]) => mockMarkConfirmed(...a),
    recalculateUniqueRequestCount: (...a: unknown[]) => mockRecalculate(...a),
  },
}));

const mockTherapistUpdate = jest.fn();
const mockTherapistUpdateMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    therapist: {
      update: (...a: unknown[]) => mockTherapistUpdate(...a),
      updateMany: (...a: unknown[]) => mockTherapistUpdateMany(...a),
    },
  },
}));

jest.mock('../services/sse.service', () => ({
  sseService: { emitStatusChange: jest.fn() },
}));
jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: { notifyAdminForceUpdate: jest.fn() },
}));

import { transitionSideEffectsService } from '../services/transition-side-effects.service';

beforeEach(() => jest.clearAllMocks());

describe('terminal-transition side effects', () => {
  it('onCancelled unmarks the confirmed flag even when the cancel came from session_held (wasConfirmed=false)', async () => {
    await transitionSideEffectsService.onCancelled({
      appointmentId: 'apt-1',
      source: 'admin',
      therapistHandle: 'ther-1',
      wasConfirmed: false,
      userEmail: 'u@test.com',
    });

    expect(mockUnmarkConfirmed).toHaveBeenCalledWith('ther-1');
    expect(mockRecalculate).toHaveBeenCalledWith('ther-1');
  });

  it('onAdminForceUpdate unmarks on force-cancel from session_held (previousStatus !== confirmed)', async () => {
    await transitionSideEffectsService.onAdminForceUpdate({
      appointmentId: 'apt-1',
      source: 'admin',
      adminId: 'admin:test',
      appointment: {
        therapistHandle: 'ther-1',
        therapistName: 'Dr T',
        userName: 'U',
        userEmail: 'u@test.com',
        therapistEmail: 't@test.com',
      },
      previousStatus: 'session_held',
      newStatus: 'cancelled',
      skipNotifications: true,
      confirmedDateTime: null,
    });

    expect(mockUnmarkConfirmed).toHaveBeenCalledWith('ther-1');
  });

  it('never writes the therapist active flag from cancel/complete/force paths', async () => {
    await transitionSideEffectsService.onCancelled({
      appointmentId: 'apt-1',
      source: 'system',
      therapistHandle: 'ther-1',
      wasConfirmed: true,
      userEmail: 'u@test.com',
    });
    await transitionSideEffectsService.onCompleted({
      appointmentId: 'apt-1',
      source: 'system',
      therapistHandle: 'ther-1',
      therapistName: 'Dr T',
      userEmail: 'u@test.com',
      userName: 'U',
      previousStatus: 'feedback_requested',
    });
    await transitionSideEffectsService.onAdminForceUpdate({
      appointmentId: 'apt-1',
      source: 'admin',
      adminId: 'admin:test',
      appointment: {
        therapistHandle: 'ther-1',
        therapistName: 'Dr T',
        userName: 'U',
        userEmail: 'u@test.com',
        therapistEmail: 't@test.com',
      },
      previousStatus: 'confirmed',
      newStatus: 'completed',
      skipNotifications: true,
      confirmedDateTime: null,
    });

    // The admin-only visibility toggle is untouched by every lifecycle path.
    expect(mockTherapistUpdate).not.toHaveBeenCalled();
    expect(mockTherapistUpdateMany).not.toHaveBeenCalled();
  });
});
