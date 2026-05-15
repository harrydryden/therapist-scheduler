/**
 * Agent processor dependency injection.
 *
 * `processMessage` needs to invoke the booking agent (JustinTimeService)
 * for matched inbound emails, but the booking agent transitively imports
 * the email processor for its outbound sends — creating a circular
 * dependency at module-load time. The DI registry breaks the cycle:
 * server.ts registers the factory after all modules are loaded, and
 * `processMessage` resolves it lazily at call time.
 *
 * The interface here is intentionally narrow — only the two methods
 * `processMessage` calls. Adding more methods would creep the contract.
 */

/**
 * Result shape returned by `processEmailReply`.
 *
 * `loggedWhilePaused` distinguishes "the agent was paused by human
 * control and the message was logged for admin visibility but not
 * actually processed" from a normal successful agent run. The email
 * pipeline uses this flag to SKIP `markMessageProcessed` — the
 * message stays unmarked, so the missed-message-scanner (or the
 * release-control inline replay) can re-deliver it to the agent
 * once human control is off.
 *
 * Without this flag the pipeline marks paused messages as
 * `'successfully-processed'`; the scanner then skips them forever
 * and the conversation stalls — see the regression that prompted
 * this contract.
 */
export interface AgentProcessorResult {
  success: boolean;
  message: string;
  loggedWhilePaused?: boolean;
}

export interface AgentProcessor {
  processEmailReply(
    appointmentId: string,
    body: string,
    from: string,
    threadContext?: unknown,
    precomputedClassification?: unknown,
  ): Promise<AgentProcessorResult | void>;
  processInquiryReply(
    inquiryId: string,
    body: string,
    from: string,
    threadContext?: unknown,
  ): Promise<{ success: boolean; message: string } | void>;
}

let agentProcessorFactory: ((traceId: string) => AgentProcessor) | null = null;

/**
 * Register the agent processor factory at startup to avoid circular imports.
 * Called from server.ts after all services are initialized.
 */
export function registerAgentProcessor(factory: (traceId: string) => AgentProcessor): void {
  agentProcessorFactory = factory;
}

export function getAgentProcessor(traceId: string): AgentProcessor {
  if (!agentProcessorFactory) {
    throw new Error('AgentProcessor not registered — call registerAgentProcessor() at startup');
  }
  return agentProcessorFactory(traceId);
}
