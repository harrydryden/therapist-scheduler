import { prisma } from '../utils/database';
import { logger } from '../utils/logger';

export type KnowledgeAudience = 'therapist' | 'user' | 'both';

export interface KnowledgeEntry {
  id: string;
  title: string | null;
  content: string;
  audience: string;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

class KnowledgeService {
  private promptCache: { value: { forTherapist: string; forUser: string }; expiresAt: number } | null = null;
  private static PROMPT_CACHE_TTL_MS = 60_000; // 1 minute

  /**
   * Invalidate the cached prompt knowledge (call after any CRUD operation)
   */
  invalidateCache(): void {
    this.promptCache = null;
  }

  /**
   * Get all active knowledge entries
   */
  async getActiveKnowledge(): Promise<KnowledgeEntry[]> {
    try {
      const entries = await prisma.knowledgeBase.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      return entries;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch active knowledge entries');
      return [];
    }
  }

  /**
   * Get all knowledge entries (for admin)
   */
  async getAllKnowledge(): Promise<KnowledgeEntry[]> {
    try {
      const entries = await prisma.knowledgeBase.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      return entries;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch all knowledge entries');
      return [];
    }
  }

  /**
   * Get knowledge entries filtered by audience
   */
  getEntriesForAudience(
    entries: KnowledgeEntry[],
    audience: 'therapist' | 'user'
  ): KnowledgeEntry[] {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries.filter(
      (e) => e && e.audience && (e.audience === audience || e.audience === 'both')
    );
  }

  /**
   * Format knowledge entries into a prompt section
   */
  formatForPrompt(entries: KnowledgeEntry[]): string {
    if (!Array.isArray(entries) || entries.length === 0) return '';

    return entries
      .filter((entry) => entry && entry.content)
      .map((entry) => {
        const title = entry.title ? `**${entry.title}:** ` : '';
        return `- ${title}${entry.content}`;
      })
      .join('\n');
  }

  /**
   * Get formatted knowledge for system prompt injection
   */
  async getKnowledgeForPrompt(): Promise<{
    forTherapist: string;
    forUser: string;
  }> {
    // Return cached result if still valid
    if (this.promptCache && Date.now() < this.promptCache.expiresAt) {
      return this.promptCache.value;
    }

    const entries = await this.getActiveKnowledge();

    const therapistEntries = this.getEntriesForAudience(entries, 'therapist');
    const userEntries = this.getEntriesForAudience(entries, 'user');

    const result = {
      forTherapist: this.formatForPrompt(therapistEntries),
      forUser: this.formatForPrompt(userEntries),
    };

    this.promptCache = { value: result, expiresAt: Date.now() + KnowledgeService.PROMPT_CACHE_TTL_MS };
    return result;
  }
}

export const knowledgeService = new KnowledgeService();
