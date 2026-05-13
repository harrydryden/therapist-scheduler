/**
 * Public surface for the email kernel.
 *
 * The `emailMessageProcessorService` object literal preserves the
 * legacy API that callers (server.ts, email-ingest.service.ts,
 * email-processing.service.ts) imported before this module was
 * split out. Each method binds to a standalone function in the
 * inbound or outbound sub-modules.
 *
 * New code should prefer the named imports below over the singleton,
 * but the singleton stays in place so the call-site update was a
 * one-liner per file.
 */

import { processMessage } from './inbound/process';
import { sendEmail } from './outbound/send';
import { processPendingEmails } from './outbound/queue';

export const emailMessageProcessorService = {
  processMessage,
  sendEmail,
  processPendingEmails,
};

// Inbound surface (orchestrator + DI plumbing + processing-failure
// readers used by the admin MISSED-message preview).
export {
  processMessage,
  registerAgentProcessor,
  type AgentProcessor,
  getLastProcessingError,
  getLastProcessingErrors,
} from './inbound';

// Outbound surface (Gmail send + pending-email queue drain).
export { sendEmail, processPendingEmails } from './outbound';
