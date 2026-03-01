/**
 * Script to investigate and recover Alice's missed message.
 *
 * Usage:
 *   DATABASE_URL="..." REDIS_URL="..." npx tsx scripts/recover-alice-message.ts
 *
 * Steps:
 *   1. Finds processed messages around Feb 25 13:00-14:00 UTC
 *   2. Shows matching appointments so you can identify Alice's
 *   3. Prompts you to confirm deletion of the processed record
 *   4. Removes from both database and Redis
 */

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import * as readline from 'readline';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || '');
const PROCESSED_MESSAGES_KEY = 'gmail:processedMessages';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('=== Investigating Alice\'s missed message ===\n');

  // Step 1: Find processed messages around the timeframe
  const messages = await prisma.processedGmailMessage.findMany({
    where: {
      processedAt: {
        gte: new Date('2026-02-25T13:00:00Z'),
        lte: new Date('2026-02-25T14:00:00Z'),
      },
    },
    orderBy: { processedAt: 'asc' },
  });

  console.log(`Found ${messages.length} messages processed Feb 25 13:00-14:00 UTC:`);
  messages.forEach((m, i) => {
    console.log(`  [${i}] id=${m.id}  processed_at=${m.processedAt.toISOString()}`);
  });

  // Step 2: Find appointments active around that time
  const appointments = await prisma.appointmentRequest.findMany({
    where: {
      lastActivityAt: {
        gte: new Date('2026-02-25T12:00:00Z'),
        lte: new Date('2026-02-25T15:00:00Z'),
      },
    },
    select: {
      id: true,
      userName: true,
      gmailThreadId: true,
      therapistGmailThreadId: true,
      status: true,
      lastActivityAt: true,
    },
  });

  console.log(`\nFound ${appointments.length} appointments active around Feb 25:`);
  appointments.forEach((a) => {
    console.log(`  name=${a.userName} status=${a.status} threadId=${a.gmailThreadId} therapistThreadId=${a.therapistGmailThreadId} lastActivity=${a.lastActivityAt?.toISOString()}`);
  });

  // Step 3: Ask which message to recover
  if (messages.length === 0) {
    console.log('\nNo processed messages found in that timeframe.');
    console.log('Try a wider range or check if the message ID is known.');

    const manualId = await ask('\nEnter a Gmail message ID to delete manually (or press Enter to exit): ');
    if (!manualId) {
      console.log('Exiting.');
      return;
    }

    const existing = await prisma.processedGmailMessage.findUnique({ where: { id: manualId } });
    if (!existing) {
      console.log(`Message ${manualId} is NOT in processed_gmail_messages. It was never marked as processed.`);
      return;
    }
    console.log(`Found: id=${existing.id} processed_at=${existing.processedAt.toISOString()}`);
    await deleteMessage(manualId);
    return;
  }

  const choice = await ask('\nEnter the index number of the message to recover (or the full message ID): ');
  const idx = parseInt(choice, 10);
  const messageId = !isNaN(idx) && idx >= 0 && idx < messages.length ? messages[idx].id : choice;

  await deleteMessage(messageId);
}

async function deleteMessage(messageId: string) {
  const confirm = await ask(`\nDelete processed record for message "${messageId}" from DB and Redis? (yes/no): `);
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Aborted.');
    return;
  }

  // Delete from database
  try {
    await prisma.processedGmailMessage.delete({ where: { id: messageId } });
    console.log(`Deleted from processed_gmail_messages table.`);
  } catch (err: any) {
    if (err.code === 'P2025') {
      console.log(`Message ${messageId} was not in the database (already deleted or never existed).`);
    } else {
      throw err;
    }
  }

  // Delete from Redis
  const removed = await redis.zrem(PROCESSED_MESSAGES_KEY, messageId);
  console.log(`Removed from Redis ZSET: ${removed > 0 ? 'yes' : 'not found (already removed or never added)'}`);

  // Also clear any lock
  const lockKey = `gmail:lock:message:${messageId}`;
  const lockRemoved = await redis.del(lockKey);
  console.log(`Cleared Redis lock: ${lockRemoved > 0 ? 'yes' : 'no lock existed'}`);

  console.log('\nDone! The stale thread recovery will pick up the message within ~1 hour.');
  console.log('Or restart the service to trigger an immediate check.');
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
