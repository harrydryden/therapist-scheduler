/**
 * Public surface for the email kernel.
 *
 * `processMessage` (the inbound orchestrator) moved to
 * `domain/scheduling/inbound/` in Stage D3 — it's scheduling policy, not
 * kernel mechanism, so it's no longer part of this barrel. Callers
 * (server.ts, email-ingest.service.ts) import it from its new location.
 *
 * The `emailMessageProcessorService` legacy singleton (and the
 * `services/email-processing.service.ts` backward-compat facade it
 * existed to serve) is gone — every caller now imports `sendEmail` /
 * `processPendingEmails` directly from here, or the relevant method
 * directly from `emailOAuthService` / `emailIngestService`. See
 * `docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md` finding #30.
 */

// Inbound surface — processing-failure readers used by the admin
// MISSED-message preview. See core/email/inbound/index.ts's own doc
// comment for what moved out of this barrel.
export {
  getLastProcessingError,
  getLastProcessingErrors,
} from './inbound';

// Outbound surface (Gmail send + pending-email queue drain).
export { sendEmail, processPendingEmails } from './outbound';
