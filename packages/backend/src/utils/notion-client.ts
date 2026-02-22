/**
 * Shared Notion Client
 *
 * Provides a singleton Notion client with built-in rate limiting.
 * All Notion operations should use this shared client to ensure
 * we stay within API rate limits (3 requests/second).
 */

import { Client } from '@notionhq/client';
import { config } from '../config';
import { logger } from './logger';

// Notion API rate limit: 3 requests/second
// Use 350ms delay between calls to stay safely under limit
const NOTION_RATE_LIMIT_DELAY_MS = 350;
const NOTION_TIMEOUT_MS = 30000;
const MAX_QUEUE_SIZE = 100;

class NotionClientManager {
  private client: Client;
  private lastRequestTime = 0;
  private requestQueue: Array<{
    operation: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  private isProcessingQueue = false;
  private stopped = false;

  constructor() {
    this.client = new Client({
      auth: config.notionApiKey,
      timeoutMs: NOTION_TIMEOUT_MS,
    });
  }

  /**
   * Get the raw Notion client (for direct access when needed)
   * Prefer using executeWithRateLimit for most operations
   */
  getClient(): Client {
    return this.client;
  }

  /**
   * Execute a Notion API operation with rate limiting
   * Queues requests to ensure we don't exceed 3 req/sec
   */
  async executeWithRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      throw new Error('NotionClientManager is stopped');
    }
    if (this.requestQueue.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Notion request queue full (max ${MAX_QUEUE_SIZE})`);
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        operation: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      if (!this.isProcessingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * Process queued requests with rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (!request) break;

      try {
        // Calculate delay needed to respect rate limit
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        const delayNeeded = Math.max(0, NOTION_RATE_LIMIT_DELAY_MS - timeSinceLastRequest);

        if (delayNeeded > 0) {
          await this.sleep(delayNeeded);
        }

        this.lastRequestTime = Date.now();
        const result = await request.operation();
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Check if Notion is configured
   */
  isConfigured(): boolean {
    return !!config.notionApiKey && !!config.notionDatabaseId;
  }

  /**
   * Get database IDs
   */
  getDatabaseIds() {
    return {
      therapists: config.notionDatabaseId,
      users: config.notionUsersDatabaseId || null,
    };
  }

  /**
   * Drain queued requests and stop accepting new ones
   */
  stop(): void {
    this.stopped = true;
    const pending = this.requestQueue.splice(0);
    for (const request of pending) {
      request.reject(new Error('NotionClientManager stopped'));
    }
    logger.info({ drainedCount: pending.length }, 'Notion client manager stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const notionClientManager = new NotionClientManager();

// Re-export the Client type for convenience
export { Client } from '@notionhq/client';
