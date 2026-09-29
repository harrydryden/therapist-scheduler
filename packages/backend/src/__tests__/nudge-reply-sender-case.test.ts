/**
 * E14: the nudge-reply sender fallback looked the therapist up with an
 * exact match on the lowercased sender, so a Therapist.email stored with
 * capitals ("Sarah.Jones@Clinic.example") never matched and the nudge reply
 * fell through to appointment matching / unmatched abandonment.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTherapistFindFirst = jest.fn();
const mockAppointmentFindFirst = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    therapist: { findFirst: (...a: unknown[]) => mockTherapistFindFirst(...a) },
    appointmentRequest: { findFirst: (...a: unknown[]) => mockAppointmentFindFirst(...a) },
  },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn().mockResolvedValue(true) },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue('Spill update - still finding you a client'),
}));

import { detectNudgeReplyBySender } from '../domain/scheduling/inbound/nudge-reply';
import type { EmailMessage } from '../utils/email-mime-parser';

const email: EmailMessage = {
  id: 'msg-1',
  threadId: 'thread-new',
  from: 'sarah.jones@clinic.example', // parser output is lowercased
  to: 'scheduler@spill.chat',
  subject: 'Re: Spill update - still finding you a client',
  body: 'Still available on Tuesdays.',
  date: new Date(),
};

beforeEach(() => jest.clearAllMocks());

it('looks the nudged therapist up case-insensitively', async () => {
  mockTherapistFindFirst.mockResolvedValueOnce({
    id: 'th-1',
    name: 'Sarah Jones',
    email: 'Sarah.Jones@Clinic.example',
    notionId: 'notion-1',
  });
  mockAppointmentFindFirst.mockResolvedValueOnce(null);

  const result = await detectNudgeReplyBySender(email, 'trace-1');

  expect(result).toEqual({ id: 'th-1', name: 'Sarah Jones', email: 'Sarah.Jones@Clinic.example' });
  expect(mockTherapistFindFirst.mock.calls[0][0].where.email).toEqual({
    equals: 'sarah.jones@clinic.example',
    mode: 'insensitive',
  });
});
