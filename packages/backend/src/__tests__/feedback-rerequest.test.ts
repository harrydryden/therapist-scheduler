/**
 * Tests for reRequestFeedback — the discard-and-resend recovery flow.
 *
 * Locks down the composed behaviour:
 *   - existing submission(s) are deleted, scoped to the appointment AND to
 *     anonymous rows sharing its tracking code (historical tokenless links)
 *   - appointments at/past feedback_requested are walked back to session_held
 *     before the fresh request (so the forward transition can re-fire)
 *   - appointments at confirmed/session_held are NOT walked back
 *   - the send is exclusively claimed via a CAS on feedbackFormSentAt BEFORE
 *     the email goes out (mutual exclusion vs the feedback cron and vs a
 *     concurrent re-request); a lost CAS raises ConflictError
 *   - a tokened email is sent and the appointment transitions to
 *     feedback_requested
 *   - validation failures (not found / no tracking code / ineligible status /
 *     future-dated confirmed session) short-circuit before any deletion
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
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
import { AppointmentNotFoundError, ConflictError } from '../errors';

const PAST = new Date('2026-06-01T09:00:00Z');
const FUTURE = new Date('2036-01-01T09:00:00Z');

const baseAppt = {
  id: 'apt-1',
  userName: 'Emma',
  userEmail: 'emma@test.com',
  therapistName: 'Nicola Barker',
  trackingCode: 'SPL-1-2-3',
  gmailThreadId: null,
  confirmedDateTimeParsed: PAST,
  feedbackFormSentAt: null as Date | null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteMany.mockResolvedValue({ count: 1 });
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockBuildPayload.mockResolvedValue({ to: 'emma@test.com', subject: 's', body: 'b' });
  mockAdminForceUpdate.mockResolvedValue({ success: true });
  mockTransitionToFeedbackRequested.mockResolvedValue({ success: true });
});

describe('reRequestFeedback', () => {
  it('session_held: deletes linked + anonymous submissions, claims, sends, transitions — no walk-back', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'session_held' });

    const res = await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { appointmentRequestId: 'apt-1' },
          { trackingCode: 'SPL-1-2-3', appointmentRequestId: null },
        ],
      },
    });
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

  it('claims the sentinel via CAS BEFORE sending the email', async () => {
    const sentAt = new Date('2026-06-02T10:00:00Z');
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'session_held', feedbackFormSentAt: sentAt });

    await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    // CAS expects the value we read (no walk-back happened) and writes a claim.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'apt-1', feedbackFormSentAt: sentAt },
      data: { feedbackFormSentAt: expect.any(Date) },
    });
    // Ordering: claim strictly before the send.
    const claimOrder = mockUpdateMany.mock.invocationCallOrder[0];
    const sendOrder = mockSendEmail.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('completed: walks status back to session_held, then CAS expects a NULL sentinel', async () => {
    mockFindUnique.mockResolvedValue({
      ...baseAppt,
      status: 'completed',
      feedbackFormSentAt: new Date('2026-06-02T10:00:00Z'),
    });

    await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    expect(mockAdminForceUpdate).toHaveBeenCalledWith(
      'apt-1',
      expect.objectContaining({ newStatus: 'session_held', bypassStateMachine: true, adminId: 'admin:test' }),
    );
    // Walk-back nulled the sentinel, so the claim must expect null.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'apt-1', feedbackFormSentAt: null },
      data: { feedbackFormSentAt: expect.any(Date) },
    });
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

  it('raises ConflictError and sends nothing when the CAS claim loses', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'session_held' });
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockTransitionToFeedbackRequested).not.toHaveBeenCalled();
  });

  it('confirmed with a PAST session and no prior submission: no walk-back, still sends', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'confirmed' });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const res = await reRequestFeedback({ appointmentId: 'apt-1', adminId: 'admin:test' });

    expect(mockAdminForceUpdate).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(res.deletedSubmissions).toBe(0);
  });

  it('rejects a confirmed appointment whose session is in the FUTURE, before deleting anything', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'confirmed', confirmedDateTimeParsed: FUTURE });

    await expect(
      reRequestFeedback({ appointmentId: 'apt-1', adminId: 'a' }),
    ).rejects.toMatchObject({ code: 'FEEDBACK_SESSION_NOT_HELD', statusCode: 400 });
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
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

  it('leaves the claim in place when the email send fails (no cron-eligible state)', async () => {
    mockFindUnique.mockResolvedValue({ ...baseAppt, status: 'completed' });
    mockSendEmail.mockRejectedValue(new Error('gmail down'));

    await expect(
      reRequestFeedback({ appointmentId: 'apt-1', adminId: 'a' }),
    ).rejects.toThrow('gmail down');

    // The claim was written (updateMany called once) and never rolled back —
    // the row stays invisible to the feedback cron, and a retry re-claims.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockTransitionToFeedbackRequested).not.toHaveBeenCalled();
  });
});
