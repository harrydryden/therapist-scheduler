/**
 * DELETE /api/admin/dashboard/appointments/:id — review §3 #4.
 *
 * Pins:
 *   - ANY post-booking status (confirmed, session_held, feedback_requested,
 *     completed) needs `force: true` AND a non-empty reason. It used to
 *     guard `confirmed` only, so a completed booking could be deleted with
 *     one click (and, while graduation was counted from appointment rows,
 *     that put the therapist back on the finder).
 *   - The completed-client record is never touched.
 *   - Every delete leaves a tombstone outside the database (structured
 *     warn log + high-severity Slack alert) because the audit trail
 *     cascades with the row. The tombstone carries a hash of the client
 *     email, never the address.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const findUniqueMock = jest.fn();
const deleteMock = jest.fn();
const completedClientDeleteMany = jest.fn();
const completedClientDelete = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      delete: (...a: unknown[]) => deleteMock(...a),
    },
    therapistCompletedClient: {
      deleteMany: (...a: unknown[]) => completedClientDeleteMany(...a),
      delete: (...a: unknown[]) => completedClientDelete(...a),
    },
  },
}));

const sendAlertMock = jest.fn().mockResolvedValue(true);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => sendAlertMock(...a) },
}));

import Fastify, { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { deleteRoute } from '../routes/admin/appointments/delete';

function appointment(status: string) {
  return {
    id: 'apt-1',
    status,
    userName: 'Alice Smith',
    userEmail: 'Alice@Example.com',
    therapistName: 'Dr T',
    therapistHandle: 'dr-t',
    therapistId: 'ther-1',
    trackingCode: 'SPL-1-2-3',
    confirmedDateTime: 'Tue 3pm',
    confirmedAt: new Date('2026-09-01T10:00:00Z'),
    createdAt: new Date('2026-08-30T10:00:00Z'),
    transitionGeneration: 7,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  deleteMock.mockResolvedValue({ id: 'apt-1' });
  app = Fastify();
  await app.register(deleteRoute);
});

afterEach(async () => {
  await app.close();
});

function del(body: Record<string, unknown>) {
  return app.inject({
    method: 'DELETE',
    url: '/api/admin/dashboard/appointments/apt-1',
    payload: body,
  });
}

describe.each(['confirmed', 'session_held', 'feedback_requested', 'completed'])(
  'post-booking status %s',
  (status) => {
    beforeEach(() => findUniqueMock.mockResolvedValue(appointment(status)));

    it('is refused without force', async () => {
      const res = await del({ adminId: 'admin-1', reason: 'duplicate' });
      expect(res.statusCode).toBe(400);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('is refused with force but no (or a blank) reason', async () => {
      expect((await del({ adminId: 'admin-1', force: true })).statusCode).toBe(400);
      expect((await del({ adminId: 'admin-1', force: true, reason: '   ' })).statusCode).toBe(400);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('is deleted with force + reason, leaving completed-client rows untouched', async () => {
      const res = await del({ adminId: 'admin-1', force: true, reason: 'Test booking' });
      expect(res.statusCode).toBe(200);
      expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'apt-1' } });
      expect(completedClientDeleteMany).not.toHaveBeenCalled();
      expect(completedClientDelete).not.toHaveBeenCalled();
    });
  },
);

it('still accepts the deprecated forceDeleteConfirmed flag as force (current dashboard)', async () => {
  findUniqueMock.mockResolvedValue(appointment('completed'));
  const res = await del({ adminId: 'admin-1', forceDeleteConfirmed: true, reason: 'Test booking' });
  expect(res.statusCode).toBe(200);
});

it('pre-booking and cancelled rows can be deleted without force', async () => {
  for (const status of ['pending', 'negotiating', 'cancelled']) {
    findUniqueMock.mockResolvedValue(appointment(status));
    const res = await del({ adminId: 'admin-1' });
    expect(res.statusCode).toBe(200);
  }
  expect(deleteMock).toHaveBeenCalledTimes(3);
});

it('writes a tombstone log (hashed email, no address) and a high-severity Slack alert', async () => {
  findUniqueMock.mockResolvedValue(appointment('completed'));

  await del({ adminId: 'admin-1', force: true, reason: 'Erasure request' });

  const tombstoneCall = (logger.warn as jest.Mock).mock.calls.find(
    ([ctx]) => ctx?.event === 'appointment_deleted',
  );
  expect(tombstoneCall).toBeDefined();
  const { tombstone } = tombstoneCall![0];
  expect(tombstone).toMatchObject({
    appointmentId: 'apt-1',
    status: 'completed',
    trackingCode: 'SPL-1-2-3',
    therapistHandle: 'dr-t',
    therapistId: 'ther-1',
    deletedBy: 'admin-1',
    forced: true,
    reason: 'Erasure request',
    transitionGeneration: 7,
    clientEmailHash: createHash('sha256').update('alice@example.com').digest('hex'),
  });
  // No client address anywhere in the tombstone.
  expect(JSON.stringify(tombstoneCall)).not.toMatch(/alice@example\.com/i);

  expect(sendAlertMock).toHaveBeenCalledTimes(1);
  const alert = sendAlertMock.mock.calls[0][0];
  expect(alert).toMatchObject({ severity: 'high', appointmentId: 'apt-1' });
  expect(JSON.stringify(alert)).not.toMatch(/alice@example\.com/i);
  expect(alert.additionalFields.Client).toBe('Alice');
});

it('returns 404 for an unknown appointment and deletes nothing', async () => {
  findUniqueMock.mockResolvedValue(null);
  const res = await del({ adminId: 'admin-1', force: true, reason: 'x' });
  expect(res.statusCode).toBe(404);
  expect(deleteMock).not.toHaveBeenCalled();
  expect(sendAlertMock).not.toHaveBeenCalled();
});
