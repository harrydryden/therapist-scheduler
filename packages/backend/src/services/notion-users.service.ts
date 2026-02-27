/**
 * Notion Users Service
 *
 * Manages a Notion database of users (clients) with their appointment history.
 * Tracks:
 * - Name
 * - Email address
 * - Upcoming appointments (list of therapist names)
 * - Previous appointments (list of therapist names)
 *
 * The database is kept in sync with the PostgreSQL appointment data.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { APPOINTMENT_STATUS } from '../constants';
import { getOrCreateUser } from '../utils/unique-id';
// FIX #22: Use shared Notion client with rate limiting instead of creating a separate instance
import { notionClientManager } from '../utils/notion-client';

export interface NotionUser {
  pageId: string;
  odId: string | null; // Unique 10-digit user ID
  name: string;
  email: string;
  subscribed: boolean;
  upcomingTherapists: string[];
  previousTherapists: string[];
}

class NotionUsersService {
  // FIX #22: Use shared rate-limited client instead of independent instance
  private get notion() { return notionClientManager.getClient(); }
  private databaseId: string | null;

  constructor() {
    this.databaseId = config.notionUsersDatabaseId || null;
  }

  /**
   * Check if the service is configured
   */
  isConfigured(): boolean {
    return !!this.databaseId;
  }

  /**
   * Find a user by email in the Notion database
   */
  async findUserByEmail(email: string): Promise<NotionUser | null> {
    if (!this.databaseId) {
      logger.debug('Notion users database not configured');
      return null;
    }

    try {
      const response = await this.notion.databases.query({
        database_id: this.databaseId,
        filter: {
          property: 'Email',
          email: {
            equals: email.toLowerCase(),
          },
        },
        page_size: 1,
      });

      if (response.results.length === 0) {
        return null;
      }

      return this.parseUserFromPage(response.results[0]);
    } catch (error) {
      logger.error({ error, email }, 'Failed to find user in Notion');
      throw error;
    }
  }

  /**
   * Create a new user in the Notion database
   */
  async createUser(params: {
    name: string;
    email: string;
    odId?: string; // 10-digit unique user ID
    upcomingTherapists: string[];
    previousTherapists: string[];
  }): Promise<NotionUser> {
    if (!this.databaseId) {
      throw new Error('Notion users database not configured');
    }

    try {
      const properties: Record<string, any> = {
        Name: {
          title: [{ text: { content: params.name || 'Unknown' } }],
        },
        Email: {
          email: params.email.toLowerCase(),
        },
        Subscribed: {
          checkbox: true, // Auto-subscribe new users to weekly mailing list
        },
        'Upcoming Appointments': {
          multi_select: params.upcomingTherapists.map((name) => ({ name })),
        },
        'Previous Appointments': {
          multi_select: params.previousTherapists.map((name) => ({ name })),
        },
      };

      // Include the 10-digit unique ID if provided
      if (params.odId) {
        properties.ID = {
          rich_text: [{ text: { content: params.odId } }],
        };
      }

      const response = await this.notion.pages.create({
        parent: { database_id: this.databaseId },
        properties,
      });

      logger.info(
        { email: params.email, pageId: response.id, odId: params.odId },
        'Created new user in Notion (auto-subscribed to mailing list)'
      );

      return this.parseUserFromPage(response);
    } catch (error) {
      logger.error({ error, email: params.email }, 'Failed to create user in Notion');
      throw error;
    }
  }

  /**
   * Update an existing user in the Notion database
   * FIX H6: Added subscribed parameter to allow atomic update of all fields
   * in a single API call, preventing lost updates if a separate call fails.
   */
  async updateUser(
    pageId: string,
    params: {
      name?: string;
      odId?: string; // 10-digit unique user ID
      upcomingTherapists?: string[];
      previousTherapists?: string[];
      subscribed?: boolean; // FIX H6: Allow atomic subscription update
    }
  ): Promise<void> {
    if (!this.databaseId) {
      throw new Error('Notion users database not configured');
    }

    try {
      const properties: Record<string, any> = {};

      if (params.name !== undefined) {
        properties.Name = {
          title: [{ text: { content: params.name } }],
        };
      }

      // Include the 10-digit unique ID if provided
      if (params.odId !== undefined) {
        properties.ID = {
          rich_text: [{ text: { content: params.odId } }],
        };
      }

      if (params.upcomingTherapists !== undefined) {
        properties['Upcoming Appointments'] = {
          multi_select: params.upcomingTherapists.map((name) => ({ name })),
        };
      }

      if (params.previousTherapists !== undefined) {
        properties['Previous Appointments'] = {
          multi_select: params.previousTherapists.map((name) => ({ name })),
        };
      }

      // FIX H6: Include subscription in same API call for atomicity
      if (params.subscribed !== undefined) {
        properties.Subscribed = {
          checkbox: params.subscribed,
        };
      }

      await this.notion.pages.update({
        page_id: pageId,
        properties,
      });

      logger.info({ pageId, odId: params.odId, subscribed: params.subscribed }, 'Updated user in Notion');
    } catch (error) {
      logger.error({ error, pageId }, 'Failed to update user in Notion');
      throw error;
    }
  }

  /**
   * Ensure a user exists in Notion when they make their first booking request.
   * Creates the user if they don't exist, does nothing if they do.
   * This is called immediately when a booking request is created.
   */
  async ensureUserExists(params: { email: string; name: string }): Promise<void> {
    if (!this.databaseId) {
      logger.debug('Notion users database not configured, skipping user creation');
      return;
    }

    try {
      // Check if user already exists
      const existingUser = await this.findUserByEmail(params.email);
      if (existingUser) {
        logger.debug({ email: params.email }, 'User already exists in Notion');
        return;
      }

      // Create new user with empty appointment lists
      await this.createUser({
        name: params.name,
        email: params.email,
        upcomingTherapists: [],
        previousTherapists: [],
      });

      logger.info(
        { email: params.email, name: params.name },
        'Created new user in Notion on first booking request'
      );
    } catch (error) {
      // Don't throw - this is a non-critical operation
      logger.error({ error, email: params.email }, 'Failed to ensure user exists in Notion');
    }
  }

  /**
   * Sync a user's appointment data from PostgreSQL to Notion
   * Creates the user if they don't exist, updates if they do
   * Also syncs the user's unique 10-digit ID (odId)
   */
  async syncUser(email: string): Promise<void> {
    if (!this.databaseId) {
      logger.debug('Notion users database not configured, skipping sync');
      return;
    }

    try {
      // Get user's odId from PostgreSQL (or create user if doesn't exist)
      const userEntity = await getOrCreateUser(email);
      const userOdId = userEntity.odId;

      // Get all appointments for this user from PostgreSQL
      const appointments = await prisma.appointmentRequest.findMany({
        where: {
          userEmail: { equals: email, mode: 'insensitive' },
        },
        select: {
          userName: true,
          therapistName: true,
          status: true,
          confirmedDateTimeParsed: true,
        },
      });

      if (appointments.length === 0) {
        logger.debug({ email }, 'No appointments found for user, skipping sync');
        return;
      }

      // Determine the user's name (use most recent non-null name)
      const userName = appointments
        .filter((a) => a.userName)
        .map((a) => a.userName)
        .pop() || 'Unknown';

      // Calculate upcoming vs previous appointments
      // - Upcoming: confirmed appointments with future datetime
      // - Previous: session_held, feedback_requested, completed, OR confirmed with past datetime
      const now = new Date();
      const upcomingTherapists = new Set<string>();
      const previousTherapists = new Set<string>();

      // Post-booking statuses indicate session has occurred
      const postBookingStatuses = [
        APPOINTMENT_STATUS.SESSION_HELD,
        APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
        APPOINTMENT_STATUS.COMPLETED,
      ];

      for (const apt of appointments) {
        // Skip cancelled and pre-booking statuses (pending, contacted, negotiating)
        const activeStatuses = [
          APPOINTMENT_STATUS.CONFIRMED,
          ...postBookingStatuses,
        ];
        if (!activeStatuses.includes(apt.status as any)) {
          continue;
        }

        // Post-booking statuses are always "previous" - session has occurred
        if (postBookingStatuses.includes(apt.status as any)) {
          previousTherapists.add(apt.therapistName);
          continue;
        }

        // Confirmed appointments: check datetime to determine upcoming vs previous
        if (apt.confirmedDateTimeParsed) {
          if (apt.confirmedDateTimeParsed > now) {
            upcomingTherapists.add(apt.therapistName);
          } else {
            previousTherapists.add(apt.therapistName);
          }
        } else {
          // If no parsed datetime, treat as upcoming (conservative)
          upcomingTherapists.add(apt.therapistName);
        }
      }

      // FIX ISSUE #5: TOCTOU race condition in user sync
      // Previously: findUser → create/update had a gap where concurrent syncs could
      // both find no user and both create duplicates.
      // Now: Use optimistic concurrency - try to find, create if not found, retry if
      // another process created in the meantime.
      let existingUser = await this.findUserByEmail(email);
      let retried = false;

      if (!existingUser) {
        try {
          // Try to create new user with unique ID
          await this.createUser({
            name: userName,
            email,
            odId: userOdId,
            upcomingTherapists: Array.from(upcomingTherapists),
            previousTherapists: Array.from(previousTherapists),
          });
        } catch (createError: any) {
          // If creation fails, another process may have created the user
          // Re-fetch and update instead
          logger.info(
            { email, error: createError?.message },
            'User creation failed - checking if created by concurrent process'
          );
          existingUser = await this.findUserByEmail(email);

          if (!existingUser) {
            // Still not found - real error, re-throw
            throw createError;
          }
          retried = true;
          logger.info({ email }, 'Found user created by concurrent process - will update');
        }
      }

      if (existingUser) {
        // FIX H6: Combine user update and subscription update into single atomic API call
        // Previously: two separate calls where second could fail after first succeeded
        // Now: single call updates all fields atomically
        const shouldResubscribe = upcomingTherapists.size > 0 && !existingUser.subscribed;

        // Also sync the odId if it's missing in Notion
        const shouldSyncOdId = !existingUser.odId && userOdId;

        await this.updateUser(existingUser.pageId, {
          name: userName,
          odId: shouldSyncOdId ? userOdId : undefined,
          upcomingTherapists: Array.from(upcomingTherapists),
          previousTherapists: Array.from(previousTherapists),
          // Include subscription update in same call for atomicity
          subscribed: shouldResubscribe ? true : undefined,
        });

        if (shouldResubscribe) {
          logger.info(
            { email, pageId: existingUser.pageId },
            'Re-subscribed user to mailing list (new upcoming appointment)'
          );
        }

        if (retried) {
          logger.info({ email }, 'Successfully handled concurrent user creation');
        }
      }

      logger.info(
        {
          email,
          upcomingCount: upcomingTherapists.size,
          previousCount: previousTherapists.size,
        },
        'User synced to Notion'
      );
    } catch (error) {
      logger.error({ error, email }, 'Failed to sync user to Notion');
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Sync all users with booked appointments (confirmed or post-booking)
   * Useful for initial population or periodic full sync
   */
  async syncAllUsers(): Promise<{ synced: number; failed: number }> {
    if (!this.databaseId) {
      logger.warn('Notion users database not configured, skipping full sync');
      return { synced: 0, failed: 0 };
    }

    try {
      // Get all unique user emails with booked appointments (confirmed or post-booking)
      const users = await prisma.appointmentRequest.groupBy({
        by: ['userEmail'],
        where: {
          status: {
            in: [
              APPOINTMENT_STATUS.CONFIRMED,
              APPOINTMENT_STATUS.SESSION_HELD,
              APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
              APPOINTMENT_STATUS.COMPLETED,
            ],
          },
        },
      });

      let synced = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await this.syncUser(user.userEmail);
          synced++;
        } catch (error) {
          logger.error({ error, email: user.userEmail }, 'Failed to sync user');
          failed++;
        }
      }

      logger.info({ synced, failed, total: users.length }, 'Full user sync complete');
      return { synced, failed };
    } catch (error) {
      logger.error({ error }, 'Failed to run full user sync');
      throw error;
    }
  }

  /**
   * Parse a Notion page into a NotionUser object
   */
  private parseUserFromPage(page: any): NotionUser {
    const properties = page.properties;

    // Extract name
    const nameProperty = properties.Name;
    const name = nameProperty?.title?.[0]?.plain_text || 'Unknown';

    // Extract email
    const emailProperty = properties.Email;
    const email = emailProperty?.email || '';

    // Extract subscribed status (checkbox) - default to true for opt-out model
    const subscribedProperty = properties.Subscribed;
    const subscribed = subscribedProperty?.checkbox ?? true;

    // Extract upcoming appointments (multi-select)
    const upcomingProperty = properties['Upcoming Appointments'];
    const upcomingTherapists = upcomingProperty?.multi_select?.map((s: any) => s.name) || [];

    // Extract previous appointments (multi-select)
    const previousProperty = properties['Previous Appointments'];
    const previousTherapists = previousProperty?.multi_select?.map((s: any) => s.name) || [];

    // Extract ID (10-digit unique user ID)
    const idProperty = properties.ID;
    const odId = idProperty?.rich_text?.[0]?.plain_text || null;

    return {
      pageId: page.id,
      odId,
      name,
      email,
      subscribed,
      upcomingTherapists,
      previousTherapists,
    };
  }

  /**
   * Update a user's subscription status
   */
  async updateSubscription(pageId: string, subscribed: boolean): Promise<void> {
    if (!this.databaseId) {
      throw new Error('Notion users database not configured');
    }

    try {
      await this.notion.pages.update({
        page_id: pageId,
        properties: {
          Subscribed: {
            checkbox: subscribed,
          },
        },
      });

      logger.info({ pageId, subscribed }, 'Updated user subscription status in Notion');
    } catch (error) {
      logger.error({ error, pageId }, 'Failed to update user subscription in Notion');
      throw error;
    }
  }

  /**
   * Fetch ALL users from the Notion database
   * Used for syncing IDs to all users, not just those with appointments
   */
  async fetchAllUsers(): Promise<NotionUser[]> {
    if (!this.databaseId) {
      logger.debug('Notion users database not configured');
      return [];
    }

    const MAX_PAGES = 100;
    const users: NotionUser[] = [];
    let hasMore = true;
    let startCursor: string | undefined;
    let pageCount = 0;

    try {
      while (hasMore) {
        pageCount++;
        if (pageCount > MAX_PAGES) {
          logger.warn({ pageCount, usersFound: users.length }, 'Pagination limit reached');
          break;
        }

        const response = await this.notion.databases.query({
          database_id: this.databaseId,
          start_cursor: startCursor,
          page_size: 100,
        });

        for (const page of response.results) {
          const user = this.parseUserFromPage(page);
          users.push(user);
        }

        hasMore = response.has_more;
        startCursor = response.next_cursor || undefined;
      }

      logger.info({ count: users.length }, 'Fetched all users from Notion');
      return users;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch all users from Notion');
      throw error;
    }
  }

  /**
   * Sync users FROM Notion TO PostgreSQL.
   *
   * Detects users that were added directly in the Notion database (i.e. they
   * have an email but no odId) and ensures they exist in Postgres. The
   * generated odId is written back to the Notion page so both systems stay
   * in sync.
   *
   * Users that already exist in Postgres (matched by email) will simply have
   * their odId back-filled into Notion if it's missing there.
   */
  async syncNotionUsersToPostgres(): Promise<{ synced: number; skipped: number; failed: number }> {
    if (!this.databaseId) {
      logger.warn('Notion users database not configured, skipping Notion→Postgres sync');
      return { synced: 0, skipped: 0, failed: 0 };
    }

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    try {
      // 1. Fetch every user from the Notion database
      const notionUsers = await this.fetchAllUsers();

      // 2. Identify users that need syncing (have email but missing odId)
      const usersNeedingSync = notionUsers.filter(u => u.email && !u.odId);

      if (usersNeedingSync.length === 0) {
        logger.debug('All Notion users already have IDs – nothing to sync');
        return { synced: 0, skipped: notionUsers.length, failed: 0 };
      }

      // 3. Process each user that needs an ID
      for (const notionUser of usersNeedingSync) {
        try {
          const normalizedEmail = notionUser.email.toLowerCase().trim();

          // getOrCreateUser handles both the "already exists" and "create
          // with new odId" cases atomically in Postgres.
          const pgUser = await getOrCreateUser(normalizedEmail, notionUser.name || null);

          // 5. Write the odId back to the Notion page
          await this.updateUser(notionUser.pageId, { odId: pgUser.odId });

          synced++;
          logger.info(
            { email: normalizedEmail, odId: pgUser.odId, pageId: notionUser.pageId },
            'Synced Notion user to Postgres and back-filled odId'
          );
        } catch (error) {
          failed++;
          logger.error(
            { error, email: notionUser.email, pageId: notionUser.pageId },
            'Failed to sync Notion user to Postgres'
          );
        }
      }

      skipped = notionUsers.length - usersNeedingSync.length;
      logger.info(
        { synced, skipped, failed, total: notionUsers.length },
        'Notion→Postgres user sync complete'
      );
    } catch (error) {
      logger.error({ error }, 'Notion→Postgres user sync failed');
    }

    return { synced, skipped, failed };
  }

  /**
   * Get all subscribed users who don't have upcoming appointments
   * Used for weekly mailing list
   *
   * FIX N1: Added pagination safety limits to prevent infinite loops
   * - Maximum page limit prevents runaway loops if API misbehaves
   * - Duplicate cursor detection catches stuck pagination
   * - Memory limit prevents OOM if user count unexpectedly huge
   */
  async getEligibleMailingListUsers(): Promise<NotionUser[]> {
    if (!this.databaseId) {
      logger.debug('Notion users database not configured');
      return [];
    }

    // FIX N1: Pagination safety limits
    const MAX_PAGES = 100; // Max pages to fetch (100 * 100 = 10,000 users max)
    const MAX_USERS = 10000; // Memory safety limit

    try {
      const users: NotionUser[] = [];
      let hasMore = true;
      let startCursor: string | undefined;
      let previousCursor: string | undefined;
      let pageCount = 0;

      while (hasMore) {
        // FIX N1: Prevent infinite loops
        pageCount++;
        if (pageCount > MAX_PAGES) {
          logger.warn(
            { pageCount, usersFound: users.length },
            'Pagination safety limit reached - stopping early'
          );
          break;
        }

        const response = await this.notion.databases.query({
          database_id: this.databaseId,
          filter: {
            property: 'Subscribed',
            checkbox: {
              equals: true,
            },
          },
          start_cursor: startCursor,
          page_size: 100,
        });

        for (const page of response.results) {
          // FIX N1: Memory safety limit
          if (users.length >= MAX_USERS) {
            logger.warn(
              { usersFound: users.length, maxUsers: MAX_USERS },
              'User count safety limit reached - stopping early'
            );
            hasMore = false;
            break;
          }

          const user = this.parseUserFromPage(page);
          // Only include users with no upcoming appointments
          if (user.upcomingTherapists.length === 0) {
            users.push(user);
          }
        }

        hasMore = response.has_more;
        const nextCursor = response.next_cursor || undefined;

        // FIX N1: Detect stuck pagination (same cursor returned twice)
        if (nextCursor && nextCursor === previousCursor) {
          logger.error(
            { cursor: nextCursor, pageCount },
            'Pagination stuck - same cursor returned twice'
          );
          break;
        }

        previousCursor = startCursor;
        startCursor = nextCursor;
      }

      logger.info(
        { count: users.length, pagesProcessed: pageCount },
        'Retrieved eligible mailing list users from Notion'
      );
      return users;
    } catch (error) {
      logger.error({ error }, 'Failed to get eligible mailing list users from Notion');
      throw error;
    }
  }
}

export const notionUsersService = new NotionUsersService();
