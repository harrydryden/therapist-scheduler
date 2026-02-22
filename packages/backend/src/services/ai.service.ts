import Anthropic from '@anthropic-ai/sdk';
import {
  RateLimitError,
  APIConnectionError,
  APIConnectionTimeoutError,
  InternalServerError,
  APIError,
} from '@anthropic-ai/sdk';
import { config } from '../config';
import { MODEL_CONFIG } from '../config/models';
import { TIMEOUTS } from '../constants';
import { logger, logTokenUsage } from '../utils/logger';

export interface AIServiceParams {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  traceId?: string;
}

export interface AIResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latency: number;
}

// Initialize Anthropic client with timeout
const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
  timeout: TIMEOUTS.ANTHROPIC_API_MS,
});

/**
 * Transient error retry configuration for AI service
 */
const TRANSIENT_RETRY_CONFIG = {
  MAX_RETRIES: 2,
  RETRY_DELAYS_MS: [1000, 3000], // 1s, 3s - fast retries for extraction
} as const;

/**
 * Check if an error is transient and should be retried
 */
function isTransientError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) {
    return true;
  }
  if (error instanceof InternalServerError) {
    return true;
  }
  if (error instanceof APIError && typeof error.status === 'number') {
    return error.status >= 500 && error.status < 600;
  }
  return false;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AIService {
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(params: AIServiceParams = {}) {
    // Use centralized model config for extraction tasks
    this.model = params.model || MODEL_CONFIG.extraction.primary;
    this.maxTokens = params.maxTokens || MODEL_CONFIG.extraction.maxTokens;
    this.temperature = params.temperature || MODEL_CONFIG.extraction.temperature;
  }

  async generateResponse(
    prompt: string,
    systemPrompt?: string,
    params: AIServiceParams = {}
  ): Promise<AIResponse> {
    const startTime = Date.now();
    const traceId = params.traceId || `ai-${Date.now()}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= TRANSIENT_RETRY_CONFIG.MAX_RETRIES; attempt++) {
      try {
        const response = await anthropic.messages.create({
          model: params.model || this.model,
          max_tokens: params.maxTokens || this.maxTokens,
          system: systemPrompt || undefined,
          messages: [
            { role: 'user', content: prompt },
          ],
        });

        const latency = Date.now() - startTime;

        // Extract text content from response
        const textContent = response.content.find((block) => block.type === 'text');
        const content = textContent?.type === 'text' ? textContent.text : '';

        const usage = {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        };

        // Log token usage for monitoring
        logTokenUsage({
          traceId,
          service: 'anthropic',
          model: params.model || this.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          latency,
        });

        return {
          content,
          usage,
          latency,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check for rate limit - don't retry here, let caller handle
        if (error instanceof RateLimitError) {
          logger.warn({ traceId, attempt }, 'AI service rate limited');
          throw error;
        }

        // Check for transient errors - retry with backoff
        if (isTransientError(error) && attempt < TRANSIENT_RETRY_CONFIG.MAX_RETRIES) {
          const delay = TRANSIENT_RETRY_CONFIG.RETRY_DELAYS_MS[Math.min(attempt, TRANSIENT_RETRY_CONFIG.RETRY_DELAYS_MS.length - 1)];
          logger.warn(
            { traceId, attempt: attempt + 1, maxRetries: TRANSIENT_RETRY_CONFIG.MAX_RETRIES, delayMs: delay, errorType: error.constructor.name },
            'AI service transient error - retrying'
          );
          await sleep(delay);
          continue;
        }

        // Non-retryable error or max retries exceeded
        logger.error({ error, traceId, attempt }, 'AI service error');
        throw new Error(`AI service failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Should not reach here, but TypeScript needs this
    throw lastError || new Error('AI service failed: Unknown error');
  }
}

// Singleton instance
export const aiService = new AIService();
