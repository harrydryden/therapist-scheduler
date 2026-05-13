export {
  acquireMessageLock,
  markMessageProcessed,
  releaseMessageLock,
  isMessageProcessed,
  filterUnprocessed,
  recordUnmatchedAttempt,
  shouldEmitProcessingAlert,
  DEDUP_CONSTANTS,
  type LockResult,
  type ProcessedContext,
} from './message-dedup';
