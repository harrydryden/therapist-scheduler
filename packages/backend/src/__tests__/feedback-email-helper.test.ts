/**
 * Tests for the shared feedback-email helper.
 *
 * The whole reason this helper exists is to guarantee every feedback link
 * carries a valid `?fk=` HMAC token — a tokenless link produces anonymous
 * submissions that never complete the appointment. These tests lock that in:
 * the built URL must round-trip through `validateFeedbackToken`, and the
 * rendered email body must embed the tokened URL.
 */

jest.mock('../config', () => ({
  config: { jwtSecret: 'test-secret-for-feedback-tokens' },
}));
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) =>
    key === 'weeklyMailing.webAppUrl' ? 'https://app.test/' : '',
  ),
}));
jest.mock('../utils/email-templates', () => ({
  getEmailSubject: jest.fn(async () => 'Your feedback'),
  getEmailBody: jest.fn(
    async (_type: string, vars: { feedbackFormUrl: string }) => `Please fill this in: ${vars.feedbackFormUrl}`,
  ),
}));

import { buildFeedbackFormUrl, buildFeedbackEmailPayload } from '../services/feedback-email.helper';
import { validateFeedbackToken } from '../utils/feedback-token';

describe('feedback-email helper', () => {
  it('builds a tokened URL that round-trips to the originating appointment id', async () => {
    const url = await buildFeedbackFormUrl({ id: 'apt-123', trackingCode: 'SPL-1-2-3' });

    expect(url.startsWith('https://app.test/feedback/SPL-1-2-3?fk=')).toBe(true);

    const fk = new URL(url).searchParams.get('fk');
    expect(fk).toBeTruthy();
    const payload = validateFeedbackToken(fk!);
    expect(payload?.appointmentId).toBe('apt-123');
    expect(payload?.expired).toBe(false);
  });

  it('throws when the appointment has no tracking code', async () => {
    await expect(buildFeedbackFormUrl({ id: 'apt-1', trackingCode: null })).rejects.toThrow(
      /tracking code/i,
    );
  });

  it('embeds the tokened URL in the rendered email body and addresses the user', async () => {
    const payload = await buildFeedbackEmailPayload({
      id: 'apt-9',
      userName: 'Emma',
      userEmail: 'emma@test.com',
      therapistName: 'Nicola Barker',
      trackingCode: 'SPL-9-9-9',
      gmailThreadId: 'thread-1',
    });

    expect(payload.to).toBe('emma@test.com');
    expect(payload.threadId).toBe('thread-1');
    expect(payload.body).toContain('SPL-9-9-9');
    expect(payload.body).toContain('?fk=');
  });
});
