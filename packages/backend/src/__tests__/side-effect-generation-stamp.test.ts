/**
 * Transition effects carry the appointment's transitionGeneration on the
 * row (side_effect_logs.transition_generation) so the retry runner can
 * supersede one whose transition was overtaken (review §4.4 / L4). Before,
 * the generation existed only inside the idempotency-key hash, where the
 * executor could not compare it.
 *
 * Periodic effects pass a SCOPE generation through the same argument (a
 * lifecycle pass, a chase cycle, a nudge claim timestamp) — that is not a
 * transition generation and must not be stamped.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const createMock = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'row', ...data }));
jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: (...a: unknown[]) => createMock(...(a as [{ data: Record<string, unknown> }])),
    },
  },
}));

import { sideEffectTrackerService } from '../services/side-effect-tracker.service';

beforeEach(() => jest.clearAllMocks());

it('registerSideEffects stamps the generation for a transition effect', async () => {
  await sideEffectTrackerService.registerSideEffects('apt-1', 'confirmed', [{ effectType: 'email_client_confirmation' }], 5);
  expect(createMock.mock.calls[0][0].data.transitionGeneration).toBe(5);
});

it('registerSideEffects does NOT stamp a periodic scope generation', async () => {
  await sideEffectTrackerService.registerSideEffects('apt-1', 'periodic', [{ effectType: 'email_chase_user' }], 1767225600000);
  expect(createMock.mock.calls[0][0].data.transitionGeneration).toBeNull();
});

it('registerSideEffects leaves effects keyed without a generation unstamped', async () => {
  await sideEffectTrackerService.registerSideEffects('apt-1', 'cancelled', [{ effectType: 'therapist_unfreeze_sync' }]);
  expect(createMock.mock.calls[0][0].data.transitionGeneration).toBeNull();
});

it('registerInTransaction stamps the generation on the in-transaction intent row', async () => {
  const upsert = jest.fn(async (args: { create: Record<string, unknown> }) => ({ id: 'r', status: 'pending', ...args.create }));
  const tx = { sideEffectLog: { upsert } } as never;

  await sideEffectTrackerService.registerInTransaction(tx, 'apt-1', 'cancelled', { effectType: 'slack_notify_cancelled' }, 7);

  expect(upsert.mock.calls[0][0].create.transitionGeneration).toBe(7);
});
