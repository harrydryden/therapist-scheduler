/**
 * Public surface for the inbound email pipeline.
 *
 * Most callers only need `processMessage` (the orchestrator) and
 * `registerAgentProcessor` (DI plumbing). The other exports are for
 * tests and the admin UI's MISSED-message preview.
 */

export { processMessage } from './process';
export { registerAgentProcessor, type AgentProcessor } from './agent-processor';
export {
  getLastProcessingError,
  getLastProcessingErrors,
} from './processing-failures';
