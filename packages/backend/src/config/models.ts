/**
 * Centralized AI Model Configuration
 *
 * This file defines all AI models used throughout the application.
 * Using model aliases (without date suffix) ensures we get the latest
 * point releases within each generation automatically.
 *
 * Model naming convention: https://docs.anthropic.com/en/docs/about-claude/models
 *
 * Note: Anthropic does not offer cross-generation "latest" aliases
 * (e.g., "claude-sonnet-latest"). Aliases like "claude-sonnet-4-6" resolve to
 * the newest 4.6.x point release, but a new generation (e.g., 5.0) will
 * require a manual update here.
 *
 * Current aliases:
 * - claude-sonnet-5: Latest Sonnet generation (fast + intelligent)
 * - claude-opus-4-8: Latest Opus generation (highest capability)
 * - claude-haiku-4-5: Latest Haiku 4.5.x (fastest, most cost-effective)
 *
 * Last updated: 2026-07-11
 */

export const CLAUDE_MODELS = {
  /**
   * Primary model for complex agentic tasks (scheduling negotiations, tool use)
   * Used by: Justin Time scheduling agent
   * Characteristics: Best reasoning, tool use, and multi-step tasks
   */
  AGENT: 'claude-sonnet-5',

  /**
   * Model for data extraction and structured output tasks
   * Used by: PDF ingestion, profile extraction
   * Characteristics: Highest-capability model for accurate extraction from
   * complex or messy documents, where correctness matters more than speed.
   */
  EXTRACTION: 'claude-opus-4-8',

  /**
   * Model for simple, fast tasks (classification, quick responses)
   * Characteristics: Fastest, most cost-effective
   */
  FAST: 'claude-haiku-4-5',
} as const;

/**
 * Model configuration with fallbacks
 * If a specific model is unavailable, the system can try alternatives
 */
export const MODEL_CONFIG = {
  agent: {
    primary: CLAUDE_MODELS.AGENT,
    maxTokens: 1024,
    temperature: 0.7,
  },
  extraction: {
    primary: CLAUDE_MODELS.EXTRACTION,
    maxTokens: 2000,
    temperature: 0.3, // Lower temperature for more consistent extraction
  },
  fast: {
    primary: CLAUDE_MODELS.FAST,
    maxTokens: 500,
    temperature: 0.5,
  },
} as const;

// Type exports for use in services
export type ClaudeModel = typeof CLAUDE_MODELS[keyof typeof CLAUDE_MODELS];
export type ModelConfigKey = keyof typeof MODEL_CONFIG;
