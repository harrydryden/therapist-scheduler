/**
 * Helper to extract denormalized metadata from conversation state.
 * Returns messageCount + checkpointStage + checkpointAt for writing
 * alongside the JSON blob — keeps the columns in lock-step with the
 * source of truth without callers having to re-parse the state.
 *
 * `checkpointAt` is the parsed Date form of `checkpoint.checkpoint_at`
 * (ISO 8601 string in the JSON). Returns null when the field is
 * missing, malformed, or the JSON itself is unparseable — callers
 * already handle NULL (legacy rows pre-instrumentation behave the same
 * way).
 */
export function extractConversationMeta(
  stateJsonOrObj: string | Record<string, unknown> | null
): { messageCount: number; checkpointStage: string | null; checkpointAt: Date | null } {
  if (!stateJsonOrObj) {
    return { messageCount: 0, checkpointStage: null, checkpointAt: null };
  }

  try {
    const obj = typeof stateJsonOrObj === 'string'
      ? JSON.parse(stateJsonOrObj)
      : stateJsonOrObj;

    const messageCount = Array.isArray(obj.messages) ? obj.messages.length : 0;
    const checkpointStage = obj.checkpoint?.stage ?? null;
    // checkpoint_at is stored as ISO 8601 string in the JSON. Parse to
    // Date for the column (DateTime?). Invalid / missing → null.
    const checkpointAtRaw = obj.checkpoint?.checkpoint_at;
    let checkpointAt: Date | null = null;
    if (typeof checkpointAtRaw === 'string') {
      const ms = Date.parse(checkpointAtRaw);
      if (Number.isFinite(ms)) checkpointAt = new Date(ms);
    }

    return { messageCount, checkpointStage, checkpointAt };
  } catch {
    return { messageCount: 0, checkpointStage: null, checkpointAt: null };
  }
}
