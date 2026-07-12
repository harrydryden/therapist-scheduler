/**
 * Public surface for the email kernel.
 *
 * The `emailMessageProcessorService` object literal preserves the
 * legacy API that callers (email-processing.service.ts) imported before
 * this module was split out. Each method binds to a standalone function
 * in the outbound sub-module.
 *
 * `processMessage` (the inbound orchestrator) moved to
 * `domain/scheduling/inbound/` in Stage D3 — it's scheduling policy, not
 * kernel mechanism, so it's no longer part of this barrel. Callers
 * (server.ts, email-ingest.service.ts) import it from its new location.
 *
 * New code should prefer the named imports below over the singleton,
 * but the singleton stays in place so the call-site update was a
 * one-liner per file.
 */

import { sendEmail } from './outbound/send';
import { processPendingEmails } from './outbound/queue';

export const emailMessageProcessorService = {
  sendEmail,
  processPendingEmails,
};

// Inbound surface — processing-failure readers used by the admin
// MISSED-message preview. See core/email/inbound/index.ts's own doc
// comment for what moved out of this barrel.
export {
  getLastProcessingError,
  getLastProcessingErrors,
} from './inbound';

// Outbound surface (Gmail send + pending-email queue drain).
export { sendEmail, processPendingEmails } from './outbound';
