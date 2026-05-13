/**
 * Public surface for outbound email — Gmail send + pending-email
 * queue drain.
 */

export { sendEmail } from './send';
export { processPendingEmails } from './queue';
