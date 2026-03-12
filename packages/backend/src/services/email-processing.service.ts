/**
 * email-processing.service.ts — Thin facade for backward compatibility
 *
 * This file was split into three focused services:
 *   1. email-oauth.service.ts       — OAuth token management, Gmail client, push watch, health
 *   2. email-ingest.service.ts      — Notification processing, polling, history, thread recovery
 *   3. email-message-processor.service.ts — Individual message processing, sending, parsing
 *
 * All existing importers of `emailProcessingService` continue to work unchanged
 * because this facade re-exports a unified object with the same public API.
 */

import { emailOAuthService, getGmailCircuitStats } from './email-oauth.service';
import { emailIngestService } from './email-ingest.service';
import { emailMessageProcessorService } from './email-message-processor.service';

// Re-export the circuit breaker stats function (was a top-level export)
export { getGmailCircuitStats } from './email-oauth.service';

/**
 * Unified facade that delegates to the three sub-services.
 * Preserves the exact same public method signatures that callers depend on.
 */
class EmailProcessingServiceFacade {
  // ─── From email-oauth.service ─────────────────────────────────────

  ensureValidToken(minValidityMinutes?: number) {
    return emailOAuthService.ensureValidToken(minValidityMinutes);
  }

  getTokenStatus() {
    return emailOAuthService.getTokenStatus();
  }

  async setupPushNotifications(topicName: string) {
    const result = await emailOAuthService.setupPushNotifications(topicName);
    // Store initial history ID (persist to both Redis and DB) — matches original behavior
    await emailIngestService.setHistoryId(parseInt(result.historyId, 10));
    return result;
  }

  checkHealth() {
    return emailOAuthService.checkHealth();
  }

  // ─── From email-ingest.service ────────────────────────────────────

  processGmailNotification(emailAddress: string, notificationHistoryId: number, traceId: string) {
    return emailIngestService.processGmailNotification(emailAddress, notificationHistoryId, traceId);
  }

  pollForNewEmails(traceId: string) {
    return emailIngestService.pollForNewEmails(traceId);
  }

  checkThreadForUnprocessedReplies(threadId: string, traceId: string) {
    return emailIngestService.checkThreadForUnprocessedReplies(threadId, traceId);
  }

  previewThreadMessages(threadId: string, traceId: string) {
    return emailIngestService.previewThreadMessages(threadId, traceId);
  }

  reprocessThread(threadId: string, traceId: string, forceMessageIds?: string[]) {
    return emailIngestService.reprocessThread(threadId, traceId, forceMessageIds);
  }

  // ─── From email-message-processor.service ─────────────────────────

  sendEmail(params: {
    to: string;
    subject: string;
    body: string;
    replyTo?: string;
    threadId?: string;
  }) {
    return emailMessageProcessorService.sendEmail(params);
  }

  processPendingEmails(traceId: string, isLockValid?: () => boolean) {
    return emailMessageProcessorService.processPendingEmails(traceId, isLockValid);
  }
}

// Keep the same export name so no importers need to change
export const emailProcessingService = new EmailProcessingServiceFacade();

// Re-export the class type for any code that references it
export { EmailProcessingServiceFacade as EmailProcessingService };
