/**
 * Lightweight end-to-end smoke test of the side-effect harness against
 * a real Postgres. Exercises:
 *   1. Therapist-scoped registration with scopeGeneration -> different
 *      cycles produce distinct rows (Step 1 invariant).
 *   2. Appointment-scoped registration via the unified wrapper
 *      (Step 2 surface).
 *   3. The DB CHECK constraint side_effect_logs_scope_check actually
 *      runs at write time (so a coding error surfaces as a 23514 SQL
 *      error rather than silent corruption).
 *
 * Not part of the test suite — invoked manually:
 *
 *   DATABASE_URL=... npx tsx scripts/smoke-test-side-effects.ts
 */

import { PrismaClient } from '@prisma/client';
import { sideEffectTrackerService } from '../src/services/side-effect-tracker.service';

const prisma = new PrismaClient();

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

async function main(): Promise<void> {
  await prisma.$connect();

  const therapistId = `smoke-ther-${Date.now()}`;
  const appointmentId = `smoke-apt-${Date.now()}`;

  await prisma.therapist.create({
    data: {
      id: therapistId,
      odId: therapistId,
      email: 'smoke@therapist.example',
      name: 'Smoke Therapist',
    },
  });
  await prisma.appointmentRequest.create({
    data: {
      id: appointmentId,
      status: 'pending',
      messageCount: 0,
      transitionGeneration: 0,
      userEmail: 'smoke@user.example',
      userName: 'Smoke User',
      therapistHandle: therapistId,
      therapistEmail: 'smoke@therapist.example',
      therapistName: 'Smoke Therapist',
    },
  });

  console.log('---- 1. Therapist-scoped cycle-keyed registration');
  const [cycle1] = await sideEffectTrackerService.registerTherapistSideEffects(
    therapistId,
    [{ effectType: 'email_therapist_nudge' }],
    1000,
  );
  const [cycle2] = await sideEffectTrackerService.registerTherapistSideEffects(
    therapistId,
    [{ effectType: 'email_therapist_nudge' }],
    2000,
  );
  if (cycle1.idempotencyKey === cycle2.idempotencyKey) {
    fail('Different scopeGeneration should produce different keys');
  }
  console.log(`  cycle1 key: ${cycle1.idempotencyKey}`);
  console.log(`  cycle2 key: ${cycle2.idempotencyKey} (distinct)`);

  console.log('---- 2. Appointment-scoped registration');
  const [aptReg] = await sideEffectTrackerService.registerSideEffects(
    appointmentId,
    'periodic',
    [{ effectType: 'email_chase_user' }],
  );
  console.log(`  apt key: ${aptReg.idempotencyKey}`);

  console.log('---- 3. CHECK constraint rejects both-set rows');
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO side_effect_logs (id, appointment_id, therapist_id, effect_type, transition, idempotency_key)
       VALUES ('smoke-bad-1', $1, $2, 'email_chase_user', 'periodic', 'smoke-bad-key-1')`,
      appointmentId,
      therapistId,
    );
    fail('CHECK constraint should have rejected both-set row');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('side_effect_logs_scope_check')) {
      fail(`Unexpected error type: ${msg}`);
    }
    console.log('  rejected as expected (scope_check)');
  }

  console.log('---- 4. CHECK constraint rejects neither-set rows');
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO side_effect_logs (id, effect_type, transition, idempotency_key)
       VALUES ('smoke-bad-2', 'email_chase_user', 'periodic', 'smoke-bad-key-2')`,
    );
    fail('CHECK constraint should have rejected neither-set row');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('side_effect_logs_scope_check')) {
      fail(`Unexpected error type: ${msg}`);
    }
    console.log('  rejected as expected (scope_check)');
  }

  console.log('---- 5. Cascade-delete clears scoped rows');
  await prisma.therapist.delete({ where: { id: therapistId } });
  const remainingTherapist = await prisma.sideEffectLog.count({
    where: { therapistId },
  });
  if (remainingTherapist !== 0) {
    fail(`After therapist delete, ${remainingTherapist} therapist-scoped rows remain`);
  }
  console.log('  therapist-scoped rows cleared');

  await prisma.appointmentRequest.delete({ where: { id: appointmentId } });
  const remainingAppointment = await prisma.sideEffectLog.count({
    where: { appointmentId },
  });
  if (remainingAppointment !== 0) {
    fail(`After appointment delete, ${remainingAppointment} appointment-scoped rows remain`);
  }
  console.log('  appointment-scoped rows cleared');

  console.log('\nALL SMOKE CHECKS PASS');
}

main()
  .catch((err) => {
    console.error('SMOKE TEST CRASHED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
