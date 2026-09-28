/**
 * transitionToCompleted writes the durable completed-client record
 * (therapist_completed_clients) inside the completion transaction —
 * review §3 #4. The availability rule counts these rows, so they must
 * exist for every completion and survive retention / admin delete of the
 * appointment row.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    getNotificationSettings: jest.fn().mockResolvedValue({ slack: { completed: false } }),
    notifyCompleted: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    onCompleted: jest.fn().mockResolvedValue(undefined),
    onSessionHeld: jest.fn().mockResolvedValue(undefined),
    notifyTransition: jest.fn(),
  },
}));
jest.mock('../domain/scheduling/lifecycle/audit', () => ({
  addAuditMessage: jest.fn().mockResolvedValue(undefined),
  recordStatusChangeEvent: jest.fn().mockResolvedValue(undefined),
}));

const txExecuteRaw = jest.fn().mockResolvedValue(1);
const txTherapistFindFirst = jest.fn();
const txUpsert = jest.fn(async (args: { create: Record<string, unknown> }) => ({ id: 'r', ...args.create }));
let lockedRow: Record<string, unknown>;

jest.mock('../utils/database', () => ({
  prisma: {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: jest.fn(async () => [lockedRow]),
        $executeRaw: (...a: unknown[]) => txExecuteRaw(...a),
        therapist: { findFirst: (...a: unknown[]) => txTherapistFindFirst(...a) },
        appointmentRequest: { update: jest.fn().mockResolvedValue({ id: 'apt-1' }) },
        appointmentAuditEvent: { create: jest.fn().mockResolvedValue(undefined) },
        sideEffectLog: { upsert: (...a: unknown[]) => txUpsert(...(a as [{ create: Record<string, unknown> }])) },
      }),
    ),
    sideEffectLog: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  },
}));

import { createHash } from 'crypto';
import { transitionToCompleted } from '../domain/scheduling/lifecycle/transitions/completed';
import { hashClientEmail } from '../domain/scheduling/lifecycle/completed-clients';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function completedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apt-1',
    status: 'feedback_requested',
    user_name: 'Alice',
    user_email: '  Alice@Example.COM ',
    therapist_name: 'Dr T',
    therapist_handle: 'dr-t',
    therapist_id: 'ther-1',
    notes: null,
    transition_generation: 3,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('hashClientEmail is sha256 of the lowercased, trimmed address (same as the seed migration)', () => {
  expect(hashClientEmail('  Alice@Example.COM ')).toBe(sha('alice@example.com'));
});

it('inserts the completed-client row inside the completion transaction, idempotently', async () => {
  lockedRow = completedRow();

  await transitionToCompleted({ appointmentId: 'apt-1', source: 'system' });

  expect(txExecuteRaw).toHaveBeenCalledTimes(1);
  const [sql, ...values] = txExecuteRaw.mock.calls[0];
  const text = (sql as TemplateStringsArray).join('?');
  expect(text).toMatch(/INSERT INTO "therapist_completed_clients"/);
  expect(text).toMatch(/ON CONFLICT \("therapist_id", "client_email_hash"\) DO NOTHING/);
  expect(values).toContain('ther-1');
  expect(values).toContain(sha('alice@example.com'));
  expect(txTherapistFindFirst).not.toHaveBeenCalled();
});

it('resolves a legacy appointment (no therapist_id) through its handle', async () => {
  lockedRow = completedRow({ therapist_id: null });
  txTherapistFindFirst.mockResolvedValueOnce({ id: 'ther-legacy' });

  await transitionToCompleted({ appointmentId: 'apt-1', source: 'system' });

  expect(txTherapistFindFirst).toHaveBeenCalledWith({
    where: { OR: [{ notionId: 'dr-t' }, { id: 'dr-t' }] },
    select: { id: true },
  });
  expect(txExecuteRaw.mock.calls[0]).toContain('ther-legacy');
});

it('an unresolvable therapist is logged, not thrown — the completion still commits', async () => {
  lockedRow = completedRow({ therapist_id: null, therapist_handle: 'gone' });
  txTherapistFindFirst.mockResolvedValueOnce(null);

  const result = await transitionToCompleted({ appointmentId: 'apt-1', source: 'system' });

  expect(result).toMatchObject({ success: true, newStatus: 'completed' });
  expect(txExecuteRaw).not.toHaveBeenCalled();
});

it('an already-completed appointment (idempotent skip) writes nothing', async () => {
  lockedRow = completedRow({ status: 'completed' });

  const result = await transitionToCompleted({ appointmentId: 'apt-1', source: 'system' });

  expect(result.skipped).toBe(true);
  expect(txExecuteRaw).not.toHaveBeenCalled();
});
