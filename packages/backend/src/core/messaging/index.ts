export {
  acquireMessageLock,
  markMessageProcessed,
  releaseMessageLock,
  releaseDbLock,
  isMessageProcessed,
  filterUnprocessed,
  recordUnmatchedAttempt,
  shouldEmitProcessingAlert,
  DEDUP_CONSTANTS,
  type LockResult,
  type ProcessedContext,
} from './message-dedup';
