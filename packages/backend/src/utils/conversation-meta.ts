/**
 * FIX #21: Helper to extract denormalized metadata from conversation state.
 * Returns messageCount and checkpointStage for writing alongside the blob.
 */
export function extractConversationMeta(
  stateJsonOrObj: string | Record<string, unknown> | null
): { messageCount: number; checkpointStage: string | null } {
  if (!stateJsonOrObj) {
    return { messageCount: 0, checkpointStage: null };
  }

  try {
    const obj = typeof stateJsonOrObj === 'string'
      ? JSON.parse(stateJsonOrObj)
      : stateJsonOrObj;

    const messageCount = Array.isArray(obj.messages) ? obj.messages.length : 0;
    const checkpointStage = obj.checkpoint?.stage ?? null;

    return { messageCount, checkpointStage };
  } catch {
    return { messageCount: 0, checkpointStage: null };
  }
}
