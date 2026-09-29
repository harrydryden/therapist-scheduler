/**
 * Email identity on write (review §4.5 / §5.1): getOrCreateUser and
 * getOrCreateTherapist store addresses through the canonical normaliser
 * (utils/email-equals normalizeEmail — trimmed, lowercased). `users.email`
 * is a case-sensitive unique, so a legacy mixed-case row must be found and
 * normalised rather than duplicated.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(2),
}));

const user = {
  findUnique: jest.fn(),
  create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'u-new', ...data })),
  update: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ id: where.id ?? 'u', ...data })),
};
const therapist = {
  findUnique: jest.fn(),
  create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 't-new', ...data })),
  update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 't-1', ...data })),
};
const queryRaw = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => user.findUnique(...a),
      create: (...a: unknown[]) => user.create(...(a as [{ data: Record<string, unknown> }])),
      update: (...a: unknown[]) => user.update(...(a as [{ where: Record<string, unknown>; data: Record<string, unknown> }])),
    },
    therapist: {
      findUnique: (...a: unknown[]) => therapist.findUnique(...a),
      create: (...a: unknown[]) => therapist.create(...(a as [{ data: Record<string, unknown> }])),
      update: (...a: unknown[]) => therapist.update(...(a as [{ data: Record<string, unknown> }])),
    },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

import { getOrCreateUser, getOrCreateTherapist } from '../utils/unique-id';

beforeEach(() => {
  jest.clearAllMocks();
  queryRaw.mockResolvedValue([]);
});

describe('getOrCreateUser', () => {
  it('looks up and creates with the normalised address', async () => {
    user.findUnique.mockResolvedValue(null); // exact lookup + odId collision check

    await getOrCreateUser('  Alice@Example.COM ', 'Alice');

    expect(user.findUnique.mock.calls[0][0]).toEqual({ where: { email: 'alice@example.com' } });
    expect(user.create.mock.calls[0][0].data.email).toBe('alice@example.com');
  });

  it('adopts (and normalises) a legacy mixed-case row instead of creating a duplicate user', async () => {
    user.findUnique.mockResolvedValue(null); // no exact normalised row
    queryRaw.mockResolvedValueOnce([{ id: 'u-legacy' }]); // lower(trim(email)) match

    const result = await getOrCreateUser('alice@example.com');

    expect(user.create).not.toHaveBeenCalled();
    expect(user.update).toHaveBeenCalledWith({ where: { id: 'u-legacy' }, data: { email: 'alice@example.com' } });
    expect(result.id).toBe('u-legacy');
    const [sql, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toMatch(/lower\(trim\(email\)\) = \?/);
    expect(values).toEqual(['alice@example.com']);
  });

  it('refuses an empty address rather than creating a user with email ""', async () => {
    await expect(getOrCreateUser('   ')).rejects.toThrow(/non-empty email/);
    expect(user.create).not.toHaveBeenCalled();
  });
});

describe('getOrCreateTherapist', () => {
  it('creates with the normalised address', async () => {
    therapist.findUnique.mockResolvedValue(null);

    await getOrCreateTherapist('notion-1', ' T.Smith@Clinic.org ', 'T Smith');

    expect(therapist.create.mock.calls[0][0].data.email).toBe('t.smith@clinic.org');
  });

  it('normalises a stored mixed-case address on the next write', async () => {
    therapist.findUnique.mockResolvedValue({ id: 't-1', notionId: 'notion-1', email: 'T.Smith@Clinic.org', name: 'T Smith', country: 'UK' });

    await getOrCreateTherapist('notion-1', 'T.Smith@Clinic.org', 'T Smith');

    expect(therapist.update).toHaveBeenCalledWith({ where: { notionId: 'notion-1' }, data: { email: 't.smith@clinic.org' } });
  });
});
