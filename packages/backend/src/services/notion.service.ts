import { Client } from '@notionhq/client';
import { config } from '../config';
import { NOTION_CATEGORY_PROPERTIES, type TherapistCategories } from '../config/therapist-categories';
import { cacheManager, redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { sleep } from '../utils/timeout';
import { circuitBreakerRegistry, CIRCUIT_BREAKER_CONFIGS } from '../utils/circuit-breaker';
// FIX #23: Import shared rate limiter for Notion API calls
import { notionClientManager } from '../utils/notion-client';

// Re-export for consumers that import from notion.service

/**
 * Minimal type for Notion page properties we access.
 * Using Record<string, unknown> is safer than `any` while still
 * allowing optional chaining on Notion's dynamic property structure.
 */
type NotionPage = { id: string; properties: Record<string, any>; cover?: any };

// Get or create the Notion API circuit breaker
const notionCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.NOTION_API);

/**
 * PERFORMANCE FIX: Cache stampede protection constants
 * Prevents thundering herd when cache expires and multiple requests hit simultaneously
 */
const CACHE_LOCK_PREFIX = 'cache:lock:';
const CACHE_LOCK_TTL_SECONDS = 10; // Lock expires after 10 seconds
const CACHE_LOCK_WAIT_MS = 50; // Polling interval while waiting
const CACHE_LOCK_MAX_WAIT_MS = 5000; // Max time to wait for lock

/**
 * Backend-internal Therapist representation with fields not exposed publicly
 * (email, frozen status, odId). The shared Therapist type in @therapist-scheduler/shared
 * represents the public API contract.
 */
export interface InternalTherapist {
  id: string;
  odId: string | null;
  name: string;
  bio: string;
  approach: string[];
  style: string[];
  areasOfFocus: string[];
  email: string;
  active: boolean;
  profileImage: string | null;
  frozen: boolean;
  /** External booking page URL (e.g. Calendly link) from Notion "Booking Link" property */
  bookingLink: string | null;
}

const CACHE_TTL = 300; // 5 minutes for general data
// Shorter TTL for booking-critical fields (active / frozen) so a therapist
// being toggled inactive in Notion stops accepting new bookings within ~60s.
// Availability is no longer cached here — it comes from Postgres directly,
// so staleness on that front is moot.
const CACHE_TTL_BOOKING = 60;
const CACHE_KEY_ALL = 'therapists:all';
const CACHE_KEY_SINGLE = 'therapists:single:';
const NOTION_TIMEOUT_MS = 30000; // 30 seconds timeout for Notion API

class NotionService {
  private notion: Client;

  constructor() {
    this.notion = new Client({
      auth: config.notionApiKey,
      timeoutMs: NOTION_TIMEOUT_MS,
    });
  }

  private async getFromCache<T>(key: string): Promise<T | null> {
    const cached = await cacheManager.getJson<T>(key);
    if (cached) {
      logger.debug({ key }, 'Cache hit');
    }
    return cached;
  }

  private async setCache(key: string, value: unknown, ttl: number = CACHE_TTL): Promise<void> {
    await cacheManager.setJson(key, value, ttl);
    logger.debug({ key, ttl }, 'Cache set');
  }

  private parseTherapistFromPage(page: NotionPage): InternalTherapist {
    const properties = page.properties;

    // Extract name (title property)
    const nameProperty = properties.Name;
    const name = nameProperty?.title?.[0]?.plain_text || 'Unknown';

    // Extract bio (rich text)
    const bioProperty = properties.Bio;
    const bio = bioProperty?.rich_text?.[0]?.plain_text || '';

    // Extract category system (multi-select fields)
    const approachProperty = properties[NOTION_CATEGORY_PROPERTIES.APPROACH];
    const approach = approachProperty?.multi_select?.map((s: { name: string }) => s.name) || [];

    const styleProperty = properties[NOTION_CATEGORY_PROPERTIES.STYLE];
    const style = styleProperty?.multi_select?.map((s: { name: string }) => s.name) || [];

    const areasOfFocusProperty = properties[NOTION_CATEGORY_PROPERTIES.AREAS_OF_FOCUS];
    const areasOfFocus = areasOfFocusProperty?.multi_select?.map((s: { name: string }) => s.name) || [];

    // Extract email
    const emailProperty = properties.Email;
    const email = emailProperty?.email || '';

    // Availability is no longer read from Notion — Postgres
    // (Therapist.availability column) is the source of truth. Callers that
    // need availability look it up via Prisma.

    // Extract active status (checkbox)
    const activeProperty = properties.Active;
    const active = activeProperty?.checkbox ?? false;

    // Extract frozen status (checkbox - synced from booking system, admin can override)
    const frozenProperty = properties.Frozen;
    const frozen = frozenProperty?.checkbox ?? false;

    // Extract profile image (files property or page cover)
    const profileImageProperty = properties['Profile Image'];
    let profileImage: string | null = null;

    // Try to get from property first
    if (profileImageProperty?.files?.[0]) {
      const file = profileImageProperty.files[0];
      profileImage = file.file?.url || file.external?.url || null;
    }
    // Fall back to page cover
    if (!profileImage && page.cover) {
      profileImage = page.cover.file?.url || page.cover.external?.url || null;
    }

    // Extract ID (10-digit unique therapist ID)
    const idProperty = properties.ID;
    const odId = idProperty?.rich_text?.[0]?.plain_text || null;

    // Extract booking link (URL property for external booking pages like Calendly)
    const bookingLinkProperty = properties['Booking Link'];
    const bookingLink = bookingLinkProperty?.url || null;

    return {
      id: page.id,
      odId,
      name,
      bio,
      approach,
      style,
      areasOfFocus,
      email,
      active,
      profileImage,
      frozen,
      bookingLink,
    };
  }

  /**
   * PERFORMANCE FIX: Acquire cache population lock to prevent stampede
   * Returns true if we should fetch, false if another process is fetching
   */
  private async acquireCacheLock(cacheKey: string): Promise<boolean> {
    const lockKey = `${CACHE_LOCK_PREFIX}${cacheKey}`;
    const startTime = Date.now();

    while (Date.now() - startTime < CACHE_LOCK_MAX_WAIT_MS) {
      try {
        const acquired = await redis.acquireLock(lockKey, '1', CACHE_LOCK_TTL_SECONDS);
        if (acquired) {
          return true;
        }

        // Another process is fetching - wait and check cache again
        await sleep(CACHE_LOCK_WAIT_MS);

        // Check if cache was populated while waiting
        const cached = await this.getFromCache<unknown>(cacheKey);
        if (cached) {
          return false; // Cache populated, don't need to fetch
        }
      } catch (err) {
        // Redis unavailable - proceed without lock (best effort)
        logger.warn({ err, cacheKey }, 'Cache lock unavailable - proceeding without lock');
        return true;
      }
    }

    // Timeout - proceed anyway to prevent blocking forever
    logger.warn({ cacheKey }, 'Cache lock wait timeout - proceeding with fetch');
    return true;
  }

  /**
   * Release cache population lock
   */
  private async releaseCacheLock(cacheKey: string): Promise<void> {
    const lockKey = `${CACHE_LOCK_PREFIX}${cacheKey}`;
    try {
      await redis.del(lockKey);
    } catch {
      // Ignore - lock will expire naturally
    }
  }

  async fetchTherapists(): Promise<InternalTherapist[]> {
    // Check cache first
    const cached = await this.getFromCache<InternalTherapist[]>(CACHE_KEY_ALL);
    if (cached) {
      return cached;
    }

    // PERFORMANCE FIX: Acquire lock to prevent cache stampede
    // Only one request will fetch from Notion; others wait and get cached result
    const shouldFetch = await this.acquireCacheLock(CACHE_KEY_ALL);
    if (!shouldFetch) {
      // Another process populated the cache while we waited
      const nowCached = await this.getFromCache<InternalTherapist[]>(CACHE_KEY_ALL);
      if (nowCached) {
        return nowCached;
      }
      // Cache still empty - proceed with fetch anyway
    }

    logger.info('Fetching therapists from Notion');

    try {
      // Fetch all pages with pagination (Notion API max page_size is 100)
      const allResults: NotionPage[] = [];
      let cursor: string | undefined = undefined;

      do {
        const response = await notionCircuitBreaker.execute(() =>
          this.notion.databases.query({
            database_id: config.notionDatabaseId,
            filter: {
              property: 'Active',
              checkbox: {
                equals: true,
              },
            },
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          })
        );

        allResults.push(...(response.results as NotionPage[]));
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
      } while (cursor);

      const therapists = allResults.map((page) => this.parseTherapistFromPage(page));

      // Cache the results
      await this.setCache(CACHE_KEY_ALL, therapists);

      logger.info({ count: therapists.length }, 'Fetched therapists from Notion');
      return therapists;
    } catch (err) {
      logger.error({ err }, 'Failed to fetch therapists from Notion');
      throw err;
    } finally {
      // Always release lock
      await this.releaseCacheLock(CACHE_KEY_ALL);
    }
  }

  async getTherapist(id: string, bypassCache: boolean = false): Promise<InternalTherapist | null> {
    const cacheKey = CACHE_KEY_SINGLE + id;
    if (!bypassCache) {
      const cached = await this.getFromCache<InternalTherapist>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    logger.info({ id }, 'Fetching single therapist from Notion');

    try {
      // Wrap Notion API call with circuit breaker for resilience
      const page = await notionCircuitBreaker.execute(() =>
        this.notion.pages.retrieve({ page_id: id })
      );
      const therapist = this.parseTherapistFromPage(page as NotionPage);

      // Use the shorter booking-critical TTL for single-therapist reads:
      // a therapist toggled inactive/frozen in Notion stops being eligible
      // within ~60s.
      await this.setCache(cacheKey, therapist, CACHE_TTL_BOOKING);

      return therapist;
    } catch (err: any) {
      if (err.code === 'object_not_found') {
        logger.warn({ id }, 'Therapist not found in Notion');
        return null;
      }
      logger.error({ err, id }, 'Failed to fetch therapist from Notion');
      throw err;
    }
  }

  async invalidateCache(): Promise<void> {
    try {
      await cacheManager.deletePattern('therapists:*');
      logger.info('Therapist cache invalidated');
    } catch (err) {
      logger.warn({ err }, 'Failed to invalidate cache');
    }
  }

  /**
   * Update therapist frozen status in Notion
   * @param therapistId - Notion page ID
   * @param frozen - Whether therapist is frozen (true) or available (false)
   */
  async updateTherapistFrozen(
    therapistId: string,
    frozen: boolean
  ): Promise<void> {
    logger.info({ therapistId, frozen }, 'Updating therapist frozen status in Notion');

    try {
      // FIX #23: Route through shared rate limiter to prevent exceeding Notion API limits
      await notionClientManager.executeWithRateLimit(async () => {
        await this.notion.pages.update({
          page_id: therapistId,
          properties: {
            Frozen: {
              checkbox: frozen,
            },
          },
        });
      });

      // Invalidate cache after update
      await this.invalidateCache();

      logger.info({ therapistId, frozen }, 'Therapist frozen status updated in Notion');
    } catch (err) {
      logger.error({ err, therapistId, frozen }, 'Failed to update therapist frozen status in Notion');
      throw err;
    }
  }

  /**
   * Update therapist active status in Notion
   * @param therapistId - Notion page ID
   * @param active - Whether therapist is active (true) or inactive (false)
   *
   * Called when an appointment reaches 'completed' status to mark therapist as inactive.
   * Inactive therapists are hidden from the therapist selection list.
   */
  async updateTherapistActive(
    therapistId: string,
    active: boolean
  ): Promise<void> {
    logger.info({ therapistId, active }, 'Updating therapist active status in Notion');

    try {
      // FIX #23: Route through shared rate limiter
      await notionClientManager.executeWithRateLimit(async () => {
        await this.notion.pages.update({
          page_id: therapistId,
          properties: {
            Active: {
              checkbox: active,
            },
          },
        });
      });

      // Invalidate cache after update
      await this.invalidateCache();

      logger.info({ therapistId, active }, 'Therapist active status updated in Notion');
    } catch (err) {
      logger.error({ err, therapistId, active }, 'Failed to update therapist active status in Notion');
      throw err;
    }
  }

  /**
   * Get all frozen therapist IDs from Notion
   * Used by the booking status service to determine which therapists to hide
   */
  async getFrozenTherapistIds(): Promise<string[]> {
    try {
      // Route through circuit breaker to prevent cascading failures
      return await notionCircuitBreaker.execute(async () => {
        const response = await this.notion.databases.query({
          database_id: config.notionDatabaseId,
          filter: {
            property: 'Frozen',
            checkbox: {
              equals: true,
            },
          },
          page_size: 100,
        });

        return response.results.map((page: any) => page.id);
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get frozen therapists from Notion');
      return [];
    }
  }

  /**
   * Update therapist unique ID in Notion
   * @param therapistId - Notion page ID
   * @param odId - 10-digit unique therapist ID
   */
  async updateTherapistId(
    therapistId: string,
    odId: string
  ): Promise<void> {
    logger.info({ therapistId, odId }, 'Updating therapist ID in Notion');

    try {
      // FIX #23: Route through shared rate limiter
      await notionClientManager.executeWithRateLimit(async () => {
        await this.notion.pages.update({
          page_id: therapistId,
          properties: {
            ID: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: odId },
                },
              ],
            },
          },
        });
      });

      // Invalidate cache after update
      await this.invalidateCache();

      logger.info({ therapistId, odId }, 'Therapist ID updated in Notion');
    } catch (err) {
      logger.error({ err, therapistId, odId }, 'Failed to update therapist ID in Notion');
      throw err;
    }
  }

}

export const notionService = new NotionService();
