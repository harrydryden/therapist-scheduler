/**
 * Tests for the terminal-appointment inbound guard.
 *
 * Product decision: when an inbound email matches a CANCELLED or COMPLETED
 * appointment, the booking agent must not auto-respond — it alerts an admin
 * and skips the loop. These pin (a) which statuses count as terminal and
 * (b) that the alert is fire-and-forget with the expected shape.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const runBackgroundTaskMock = jest.fn((fn: () => unknown) => {
  // Execute synchronously so the inner sendAlert call is observable.
  void fn();
});
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (...args: unknown[]) => (runBackgroundTaskMock as (...a: unknown[]) => void)(...args),
}));

const sendAlertMock = jest.fn();
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...args: unknown[]) => sendAlertMock(...args) },
}));

import {
  TERMINAL_AGENT_STATUSES,
  isTerminalAppointmentStatus,
  alertTerminalAppointmentInbound,
} from '../services/terminal-appointment-guard';

beforeEach(() => jest.clearAllMocks());

describe('isTerminalAppointmentStatus', () => {
  it('is true for cancelled and completed', () => {
    expect(isTerminalAppointmentStatus('cancelled')).toBe(true);
    expect(isTerminalAppointmentStatus('completed')).toBe(true);
    expect([...TERMINAL_AGENT_STATUSES].sort()).toEqual(['cancelled', 'completed']);
  });

  it('is false for every active/in-flight status', () => {
    for (const status of [
      'pending',
      'contacted',
      'negotiating',
      'confirmed',
      'session_held',
      'feedback_requested',
    ]) {
      expect(isTerminalAppointmentStatus(status)).toBe(false);
    }
  });
});

describe('alertTerminalAppointmentInbound', () => {
  it('fires a fire-and-forget Slack alert with the appointment + sender context', () => {
    alertTerminalAppointmentInbound({
      appointmentRequestId: 'apt-1',
      status: 'cancelled',
      therapistName: 'Dr Taylor',
      sender: 'client',
      traceId: 'trace-1',
    });

    expect(runBackgroundTaskMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const alert = sendAlertMock.mock.calls[0][0];
    expect(alert).toMatchObject({
      severity: 'medium',
      appointmentId: 'apt-1',
      therapistName: 'Dr Taylor',
      additionalFields: { Sender: 'client', Status: 'cancelled' },
    });
    expect(alert.details).toMatch(/cancelled/);
    expect(alert.details).toMatch(/client/);
  });

  it('labels the sender as therapist when the therapist replied', () => {
    alertTerminalAppointmentInbound({
      appointmentRequestId: 'apt-2',
      status: 'completed',
      therapistName: 'Dr Taylor',
      sender: 'therapist',
      traceId: 'trace-2',
    });

    const alert = sendAlertMock.mock.calls[0][0];
    expect(alert.additionalFields).toEqual({ Sender: 'therapist', Status: 'completed' });
  });
});
