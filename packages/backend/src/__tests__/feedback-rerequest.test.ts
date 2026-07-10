/**
 * Tests for reRequestFeedback — the discard-and-resend recovery flow.
 *
 * Locks down the composed behaviour:
 *   - existing submission(s) are deleted (scoped to the appointment)
 *   - appointments at/past feedback_requested are walked back to session_held
 *     before the fresh request (so the forward transition can re-fire)
 *   - appointments at confirmed/session_held are NOT walked back
 *   - a tokened email is sent and the appointment transitions to
 *     feedback_requested
 *   - validation failures (not found / no tracking code / ineligible status)
 *     short-circuit before any deletion
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const mockFindUnique = jest.fn();
const mockDeleteMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    feedbackSubmission: { deleteMany: (...a: unknown[]) => mockDeleteMany(...a) },
  },
}));

const mockAdminForceUpdate = jest.fn();
const mockTransitionToFeedbackRequested = jest.fn();
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: {
    adminForceUpdate: (...a: unknown[]) => mockAdminForceUpdate(...a),
    transitionToFeedbackRequested: (...a: unknown[]) => mockTransitionToFeedbackRequested(...a),
  },
}));

const mockSendEmail = jest.fn();
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: { sendEmail: (...a: unknown[]) => mockSendEmail(...a) },
}));

const mockBuildPayload = jest.fn();
jest.mock('../services/feedback-email.helper', () => ({
  buildFeedbackEmailPayload: (...a: unknown[]) => mockBuildPayload(...a),
}));

import { reRequestFeedback } from '../services/feedback-rerequest.service';
import { AppointmentNotFoundError } from '../errors';

const baseAppt = {
  id: 'apt-1',
  userName: 'Emma',
  userEmail: 'emma@test.com',
  therapistName: 'Nicola Barker',
  trackingCode: 'SPL-1-2-3',
  gmailThreadId: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteMany.mockResolvedValue({ count: 1 });
  mockBuildPayload.mockResolvedValue({ to: 'emma@test.com', subject: 's', body: 'b' });
  mockAdminForceUpdate.mockResolvedValue({ success: true });
  mockTransitionToFeedbackRequested.mockResolvedValue({ success: true });
});

describe('reRequestFeedback', () => {
  it('session_held: deletes submissions, sends email, transitions — no walk-back', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'session_held' });

    const res = await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { appointmentRequestId: 'apt-1' } });
    expect(mockAdminForceUpdate).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockTransitionToFeedbackRequested).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'apt-1', source: 'admin', adminId: 'admin:test' }),
    );
    expect(res).toMatchObject({
      deletedSubmissions: 1,
      previousStatus: 'session_held',
      newStatus: 'feedback_requested',
      emailSentTo: 'emma@test.com',
    });
  });

  it('completed: walks status back to session_held before re-sending', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'completed' });

    await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    expect(mockAdminForceUpdate).toHaveBeenCalledWith(
      'apt-1',
      expect.objectContaining({ newStatus: 'session_held', bypassStateMachine: true, adminId: 'admin:test' }),
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockTransitionToFeedbackRequested).toHaveBeenCalledTimes(1);
  });

  it('feedback_requested: also walks status back to session_held', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'feedback_requested' });

    await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    expect(mockAdminForceUpdate).toHaveBeenCalledWith(
      'apt-1',
      expect.objectContaining({ newStatus: 'session_held' }),
    );
  });

  it('confirmed with no prior submission: no walk-back, still sends', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'confirmed' });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const res = await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    expect(mockAdminForceUpdate).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(res.deletedSubmissions).toBe(0);
  });

  it('throws AppointmentNotFoundError and touches nothing when the appointment is missing', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(reRequestFeedback({ appointmentId: 'x', adminId: 'a' })).rejects.toBeInstanceOf(
      AppointmentNotFoundError,
    );
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects (no tracking code) before deleting anything', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, trackingCode: null, status: 'session_held' });

    await expect(
      reRequestFeedback({ appointmentId: 'apt-1', adminId: 'a' }),
    ).rejects.toMatchObject({ code: 'FEEDBACK_NO_TRACKING_CODE', statusCode: 400 });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('rejects (ineligible status) before deleting anything', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'negotiating' });

    await expect(
      reRequestFeedback({ appointmentId: 'apt-1', adminId: 'a' }),
    ).rejects.toMatchObject({ code: 'FEEDBACK_INELIGIBLE_STATUS', statusCode: 400 });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
