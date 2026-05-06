/**
 * Tests for the invitation lifecycle operations on signup-invitation.service:
 *   - findInvitationsNeedingReminder
 *   - sendInvitationReminder (atomic claim, send, no double-fire)
 *   - archiveOldInvitations
 *
 * These don't exercise the InvitationLifecycleService wrapper directly
 * because that's just a thin scheduler — the interesting behaviour is in
 * the service operations the tick calls.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    backendUrl: 'https://backend.test',
  },
}));

const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    signupInvitation: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
  },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValues: jest.fn().mockResolvedValue(
    new Map([
      ['email.invitationReminderSubject', 'Reminder for {recipientName}'],
      [
        'email.invitationReminderBody',
        'Hi {recipientName}, expires in {daysRemaining} days ({expiryDate}).',
      ],
    ]),
  ),
}));

jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

import {
  findInvitationsNeedingReminder,
  sendInvitationReminder,
  archiveOldInvitations,
} from '../services/signup-invitation.service';
import { emailProcessingService } from '../services/email-processing.service';

beforeEach(() => {
  jest.clearAllMocks();
});

interface RowOverrides {
  id?: string;
  email?: string;
  name?: string | null;
  expiresAt?: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  archivedAt?: Date | null;
  reminderSentAt?: Date | null;
  invitedBy?: string;
  lastSentAt?: Date;
  sendCount?: number;
  acceptedUserId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  tokenHash?: string;
}
function makeRow(overrides: RowOverrides = {}) {
  const now = new Date();
  return {
    id: 'inv-1',
    email: 'jamie@example.com',
    name: 'Jamie',
    tokenHash: 'a'.repeat(64),
    invitedBy: 'admin',
    expiresAt: new Date(now.getTime() + 14 * 86400000),
    acceptedAt: null,
    acceptedUserId: null,
    revokedAt: null,
    archivedAt: null,
    reminderSentAt: null,
    lastSentAt: now,
    sendCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('findInvitationsNeedingReminder', () => {
  it('returns nothing when reminderDaysBefore is 0', async () => {
    const result = await findInvitationsNeedingReminder(0);
    expect(result).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('queries within the reminder window with all required preconditions', async () => {
    mockFindMany.mockResolvedValue([]);

    await findInvitationsNeedingReminder(3);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      acceptedAt: null,
      revokedAt: null,
      archivedAt: null,
      reminderSentAt: null,
      expiresAt: { gt: expect.any(Date), lte: expect.any(Date) },
    });
    // The window upper bound should be ~3 days from now
    const windowMs = call.where.expiresAt.lte.getTime() - call.where.expiresAt.gt.getTime();
    expect(windowMs).toBeGreaterThan(2.9 * 86400000);
    expect(windowMs).toBeLessThan(3.1 * 86400000);
  });

  it('respects the take limit', async () => {
    mockFindMany.mockResolvedValue([]);
    await findInvitationsNeedingReminder(3, 10);
    expect(mockFindMany.mock.calls[0][0].take).toBe(10);
  });
});

describe('sendInvitationReminder', () => {
  it('sends the email and atomically claims via updateMany', async () => {
    mockFindUnique.mockResolvedValue(makeRow());
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const sent = await sendInvitationReminder('inv-1');

    expect(sent).toBe(true);
    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);

    // The updateMany must include reminderSentAt: null in the where so
    // a concurrent second tick can't double-send.
    const claimCall = mockUpdateMany.mock.calls[0][0];
    expect(claimCall.where).toMatchObject({
      id: 'inv-1',
      acceptedAt: null,
      revokedAt: null,
      archivedAt: null,
      reminderSentAt: null,
    });
    expect(claimCall.data.reminderSentAt).toBeInstanceOf(Date);
  });

  it('skips when the invitation is already reminded', async () => {
    mockFindUnique.mockResolvedValue(makeRow({ reminderSentAt: new Date() }));

    const sent = await sendInvitationReminder('inv-1');

    expect(sent).toBe(false);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
  });

  it('skips when the invitation is no longer pending', async () => {
    mockFindUnique.mockResolvedValue(makeRow({ acceptedAt: new Date() }));

    const sent = await sendInvitationReminder('inv-1');

    expect(sent).toBe(false);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('skips when claim returns count=0 (concurrent tick won the race)', async () => {
    mockFindUnique.mockResolvedValue(makeRow());
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const sent = await sendInvitationReminder('inv-1');

    expect(sent).toBe(false);
    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
  });

  it('returns false when send fails after claim (no retry)', async () => {
    mockFindUnique.mockResolvedValue(makeRow());
    mockUpdateMany.mockResolvedValue({ count: 1 });
    (emailProcessingService.sendEmail as jest.Mock).mockRejectedValueOnce(new Error('SMTP'));

    const sent = await sendInvitationReminder('inv-1');

    expect(sent).toBe(false);
  });
});

describe('archiveOldInvitations', () => {
  it('matches expired and revoked rows older than the cutoff but skips accepted', async () => {
    mockUpdateMany.mockResolvedValue({ count: 4 });

    const count = await archiveOldInvitations(90);

    expect(count).toBe(4);
    const call = mockUpdateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      archivedAt: null,
      acceptedAt: null,
      OR: expect.arrayContaining([
        expect.objectContaining({ revokedAt: { lt: expect.any(Date) } }),
        expect.objectContaining({ revokedAt: null, expiresAt: { lt: expect.any(Date) } }),
      ]),
    });
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });

  it('returns 0 when nothing matches', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const count = await archiveOldInvitations(90);
    expect(count).toBe(0);
  });
});
