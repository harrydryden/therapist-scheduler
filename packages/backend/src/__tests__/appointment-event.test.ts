/**
 * Tests for recordAppointmentEvent.
 * Verifies that every event always writes an audit log entry, that Slack
 * is fire-and-forget (doesn't throw on failure), and that omitting the
 * slack option silently skips the notification.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../services/audit-event.service', () => ({
  auditEventService: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn().mockResolvedValue(true),
  },
}));

import { recordAppointmentEvent } from '../services/appointment-event.service';
import { auditEventService } from '../services/audit-event.service';
import { slackNotificationService } from '../services/slack-notification.service';

describe('recordAppointmentEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes an audit event whose eventType matches event.type', async () => {
    await recordAppointmentEvent({
      appointmentId: 'apt-1',
      type: 'chase_sent',
      actor: 'system',
      reason: 'inactive 72h',
      payload: { target: 'therapist', inactiveHours: 72 },
    });

    // The event type is now passed through directly as the audit row's
    // eventType — previously every appointment event masqueraded as
    // 'checkpoint_update' with payload.action carrying the real type.
    expect(auditEventService.log).toHaveBeenCalledWith(
      'apt-1',
      'chase_sent',
      'system',
      expect.objectContaining({
        action: 'chase_sent',
        reason: 'inactive 72h',
        target: 'therapist',
        inactiveHours: 72,
      }),
    );
  });

  it('fires a Slack alert when slack option is provided', async () => {
    await recordAppointmentEvent({
      appointmentId: 'apt-1',
      type: 'closure_recommended',
      actor: 'system',
      slack: {
        title: 'Closure recommended',
        severity: 'high',
        details: 'No response from therapist',
        additionalFields: { Foo: 'bar' },
      },
    });

    expect(slackNotificationService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Closure recommended',
        severity: 'high',
        appointmentId: 'apt-1',
        details: 'No response from therapist',
        additionalFields: { Foo: 'bar' },
      }),
    );
  });

  it('skips Slack when slack option is omitted', async () => {
    await recordAppointmentEvent({
      appointmentId: 'apt-1',
      type: 'closure_dismissed',
      actor: 'admin',
    });

    expect(slackNotificationService.sendAlert).not.toHaveBeenCalled();
  });

  it('does not throw if Slack delivery fails (fire-and-forget)', async () => {
    (slackNotificationService.sendAlert as jest.Mock).mockRejectedValueOnce(
      new Error('Slack down')
    );

    await expect(
      recordAppointmentEvent({
        appointmentId: 'apt-1',
        type: 'chase_sent',
        actor: 'system',
        slack: { title: 't', severity: 'low', details: 'd' },
      }),
    ).resolves.toBeUndefined();
  });

  it('omits reason from payload when not provided', async () => {
    await recordAppointmentEvent({
      appointmentId: 'apt-1',
      type: 'closure_dismissed_auto',
      actor: 'system',
    });

    const payload = (auditEventService.log as jest.Mock).mock.calls[0][3];
    expect(payload).not.toHaveProperty('reason');
    expect(payload.action).toBe('closure_dismissed_auto');
  });

  it('maps the actor to the audit event correctly for each source', async () => {
    await recordAppointmentEvent({ appointmentId: 'a', type: 'closure_dismissed', actor: 'admin' });
    await recordAppointmentEvent({ appointmentId: 'a', type: 'closure_dismissed_auto', actor: 'system' });
    await recordAppointmentEvent({ appointmentId: 'a', type: 'chase_sent', actor: 'system' });

    const calls = (auditEventService.log as jest.Mock).mock.calls;
    expect(calls[0][2]).toBe('admin');
    expect(calls[1][2]).toBe('system');
    expect(calls[2][2]).toBe('system');
  });
});
