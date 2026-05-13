/**
 * `remember` — record an informational note on the conversation's
 * appointment memory (Layer C — agent notes).
 *
 * Strictly scoped to `context.appointmentRequestId` — `addNote`
 * takes that single ID and writes via primary-key update. The
 * agent has no path to write a note for any other appointment.
 *
 * No checkpoint action — `remember` is informational, doesn't
 * advance the FSM. The result message tells the agent whether the
 * note was new or already present (dedup is by content hash).
 */

import { addNote } from '../../../../services/agent-memory.service';
import { rememberInputSchema } from '../../../../schemas/tool-inputs';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export async function handleRemember(
  rawInput: unknown,
  context: SchedulingContext,
): Promise<ToolExecutionResult> {
  const parsed = rememberInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { success: false, toolName: 'remember', error: `Invalid remember input: ${parsed.error.message}` };
  }
  const result = await addNote(
    context.appointmentRequestId,
    parsed.data.category,
    parsed.data.note,
  );
  return {
    success: true,
    toolName: 'remember',
    resultMessage: result.added
      ? `Note recorded (category: ${parsed.data.category}, id: ${result.noteId}). Total notes: ${result.memory.notes.length}.`
      : `Note already present (id: ${result.noteId}). Skipped duplicate.`,
  };
}
