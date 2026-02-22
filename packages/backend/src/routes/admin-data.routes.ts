/**
 * Admin Data Routes
 * Sync operations, backfill utilities, and data migration tools.
 * Split from admin-dashboard.routes.ts (FIX #10).
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { notionSyncManager } from '../services/notion-sync-manager.service';
import { notionService } from '../services/notion.service';
import { notionUsersService } from '../services/notion-users.service';
import { backfillMissingTrackingCodes, fixDuplicateTrackingCodes, migrateLegacyTrackingCodes } from '../utils/tracking-code';
import { backfillUsers, backfillTherapists, linkAppointmentsToEntities, getOrCreateTherapist, getOrCreateUser } from '../utils/unique-id';
import { verifyWebhookSecret } from '../middleware/auth';

export async function adminDataRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * POST /api/admin/dashboard/trigger-feedback-sync
   * Manually trigger the feedback sync process
   */
  fastify.post(
    '/api/admin/dashboard/trigger-feedback-sync',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 60000, // 1 minute
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      try {
        logger.info({ requestId }, 'Manual feedback sync triggered');

        const result = await notionSyncManager.triggerAppointmentLifecycleTick();

        logger.info(
          { requestId, synced: result.synced, errors: result.errors },
          'Manual feedback sync completed'
        );

        return reply.send({
          success: true,
          data: {
            transitioned: result.synced,
            errors: result.errors,
            message: `Sync completed: ${result.synced} appointments transitioned`,
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to trigger feedback sync');
        return reply.status(500).send({
          success: false,
          error: 'Failed to trigger feedback sync',
        });
      }
    }
  );

  /**
   * POST /api/admin/dashboard/fix-tracking-codes
   * Fix tracking code issues: backfill missing, fix duplicates, migrate legacy
   */
  fastify.post(
    '/api/admin/dashboard/fix-tracking-codes',
    {
      config: {
        rateLimit: {
          max: 2,
          timeWindow: 60000, // 1 minute
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      logger.info({ requestId }, 'Running tracking code fix operation');

      try {
        // Step 1: Migrate legacy tracking codes (SPL123) to new format (SPL-1234-5678-1)
        const migrateResult = await migrateLegacyTrackingCodes();

        // Step 2: Backfill missing tracking codes
        const backfillResult = await backfillMissingTrackingCodes();

        // Step 3: Fix duplicate tracking codes
        const fixResult = await fixDuplicateTrackingCodes();

        logger.info(
          {
            requestId,
            migrated: migrateResult.migrated,
            migrateErrors: migrateResult.errors.length,
            backfilled: backfillResult.updated,
            backfillErrors: backfillResult.errors.length,
            duplicatesFound: fixResult.duplicatesFound,
            duplicatesFixed: fixResult.fixed,
            fixErrors: fixResult.errors.length,
          },
          'Tracking code fix operation complete'
        );

        return reply.send({
          success: true,
          data: {
            migration: {
              appointmentsMigrated: migrateResult.migrated,
              errors: migrateResult.errors,
            },
            backfill: {
              appointmentsUpdated: backfillResult.updated,
              errors: backfillResult.errors,
            },
            duplicateFix: {
              duplicatesFound: fixResult.duplicatesFound,
              appointmentsFixed: fixResult.fixed,
              errors: fixResult.errors,
            },
            message: `Migrated ${migrateResult.migrated} legacy codes, backfilled ${backfillResult.updated} appointments, fixed ${fixResult.fixed} duplicate codes`,
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fix tracking codes');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fix tracking codes',
        });
      }
    }
  );

  /**
   * POST /api/admin/dashboard/backfill-entities
   * Backfill User and Therapist entities from existing appointments
   */
  fastify.post(
    '/api/admin/dashboard/backfill-entities',
    {
      config: {
        rateLimit: {
          max: 2,
          timeWindow: 60000, // 1 minute
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      logger.info({ requestId }, 'Running entity backfill operation');

      try {
        // Step 1: Backfill users
        const userResult = await backfillUsers();

        // Step 2: Backfill therapists
        const therapistResult = await backfillTherapists();

        // Step 3: Link appointments to entities
        const linkResult = await linkAppointmentsToEntities();

        logger.info(
          {
            requestId,
            usersCreated: userResult.created,
            usersSkipped: userResult.skipped,
            therapistsCreated: therapistResult.created,
            therapistsSkipped: therapistResult.skipped,
            appointmentsLinked: linkResult.linked,
          },
          'Entity backfill operation complete'
        );

        return reply.send({
          success: true,
          data: {
            users: {
              created: userResult.created,
              skipped: userResult.skipped,
              errors: userResult.errors,
            },
            therapists: {
              created: therapistResult.created,
              skipped: therapistResult.skipped,
              errors: therapistResult.errors,
            },
            appointments: {
              linked: linkResult.linked,
              errors: linkResult.errors,
            },
            message: `Created ${userResult.created} users, ${therapistResult.created} therapists, linked ${linkResult.linked} appointments`,
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to backfill entities');
        return reply.status(500).send({
          success: false,
          error: 'Failed to backfill entities',
        });
      }
    }
  );

  /**
   * POST /api/admin/dashboard/sync-notion-ids
   * Sync unique IDs (odId) to Notion databases
   */
  fastify.post(
    '/api/admin/dashboard/sync-notion-ids',
    {
      config: {
        rateLimit: {
          max: 2,
          timeWindow: 60000, // 1 minute
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      logger.info({ requestId }, 'Syncing unique IDs to Notion databases');

      try {
        // Step 1: Fetch ALL users from Notion database
        const allNotionUsers = await notionUsersService.fetchAllUsers();

        let usersCreated = 0;
        let usersSynced = 0;
        let usersSkipped = 0;
        const userErrors: string[] = [];

        // OPTIMIZATION: Prefetch all existing users by email to avoid N+1 queries
        const notionUserEmails = allNotionUsers
          .filter(u => u.email)
          .map(u => u.email!.toLowerCase());

        const existingUsers = await prisma.user.findMany({
          where: { email: { in: notionUserEmails } },
        });
        const usersByEmail = new Map(existingUsers.map(u => [u.email.toLowerCase(), u]));

        // Step 2: For each Notion user, ensure they exist in PostgreSQL with an ID
        for (const notionUser of allNotionUsers) {
          try {
            if (!notionUser.email) {
              userErrors.push(`User ${notionUser.name} has no email - skipping`);
              continue;
            }

            // Check if user exists in PostgreSQL (from prefetched map)
            let dbUser = usersByEmail.get(notionUser.email.toLowerCase());

            if (!dbUser) {
              // Create user in PostgreSQL with unique ID
              dbUser = await getOrCreateUser(notionUser.email, notionUser.name);
              // Add to map so subsequent iterations can find it if needed
              usersByEmail.set(notionUser.email.toLowerCase(), dbUser);
              usersCreated++;
              logger.info(
                { email: notionUser.email, odId: dbUser.odId, name: notionUser.name },
                'Created user in PostgreSQL'
              );
            }

            // Sync ID to Notion if missing
            if (!notionUser.odId && dbUser.odId) {
              await notionUsersService.updateUser(notionUser.pageId, {
                odId: dbUser.odId,
              });
              usersSynced++;
              logger.info(
                { email: notionUser.email, odId: dbUser.odId },
                'Synced user ID to Notion'
              );
            } else {
              usersSkipped++;
            }
          } catch (err) {
            const errorMsg = `Failed to sync user ${notionUser.email}: ${err instanceof Error ? err.message : 'Unknown error'}`;
            userErrors.push(errorMsg);
            logger.error({ err, email: notionUser.email }, 'Failed to sync user ID to Notion');
          }
        }

        // Step 3: Sync all therapist IDs to Notion
        const allNotionTherapists = await notionService.fetchTherapists();

        let therapistsSynced = 0;
        let therapistsCreated = 0;
        let therapistsSkipped = 0;
        const therapistErrors: string[] = [];

        // OPTIMIZATION: Prefetch all existing therapists by notionId to avoid N+1 queries
        const notionTherapistIds = allNotionTherapists.map(t => t.id);
        const existingTherapists = await prisma.therapist.findMany({
          where: { notionId: { in: notionTherapistIds } },
        });
        const therapistsByNotionId = new Map(existingTherapists.map(t => [t.notionId, t]));

        for (const notionTherapist of allNotionTherapists) {
          try {
            // Check if therapist exists in PostgreSQL (from prefetched map)
            let dbTherapist = therapistsByNotionId.get(notionTherapist.id);

            if (!dbTherapist) {
              // Create therapist in PostgreSQL with unique ID
              dbTherapist = await getOrCreateTherapist(
                notionTherapist.id,
                notionTherapist.email,
                notionTherapist.name
              );
              // Add to map so subsequent iterations can find it if needed
              therapistsByNotionId.set(notionTherapist.id, dbTherapist);
              therapistsCreated++;
              logger.info(
                { notionId: notionTherapist.id, odId: dbTherapist.odId, name: notionTherapist.name },
                'Created therapist in PostgreSQL'
              );
            }

            // Sync ID to Notion if missing
            if (!notionTherapist.odId && dbTherapist.odId) {
              await notionService.updateTherapistId(notionTherapist.id, dbTherapist.odId);
              therapistsSynced++;
              logger.info(
                { notionId: notionTherapist.id, odId: dbTherapist.odId },
                'Synced therapist ID to Notion'
              );
            } else {
              therapistsSkipped++;
            }
          } catch (err) {
            const errorMsg = `Failed to sync therapist ${notionTherapist.name}: ${err instanceof Error ? err.message : 'Unknown error'}`;
            therapistErrors.push(errorMsg);
            logger.error({ err, notionId: notionTherapist.id }, 'Failed to sync therapist ID to Notion');
          }
        }

        logger.info(
          {
            requestId,
            usersTotal: allNotionUsers.length,
            usersCreated,
            usersSynced,
            therapistsTotal: allNotionTherapists.length,
            therapistsCreated,
            therapistsSynced,
          },
          'Notion ID sync complete'
        );

        const totalUsersSynced = usersCreated + usersSynced;

        return reply.send({
          success: true,
          data: {
            users: {
              total: allNotionUsers.length,
              created: usersCreated,
              synced: usersSynced,
              skipped: usersSkipped,
              errors: userErrors,
            },
            therapists: {
              total: allNotionTherapists.length,
              created: therapistsCreated,
              synced: therapistsSynced,
              skipped: therapistsSkipped,
              errors: therapistErrors,
            },
            message: `Synced ${totalUsersSynced} users and ${therapistsSynced + therapistsCreated} therapists to Notion`,
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to sync IDs to Notion');
        return reply.status(500).send({
          success: false,
          error: 'Failed to sync IDs to Notion',
        });
      }
    }
  );
}
