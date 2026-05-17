/**
 * Tests for the `checkpointAt` field added to extractConversationMeta.
 *
 * The chase candidate query used to pull the full `conversationState`
 * JSON (potentially MB per row × batch size per tick) just to read one
 * nested timestamp — `checkpoint.checkpoint_at`. The fix denormalises
 * that timestamp into a top-level `appointmentRequest.checkpointAt`
 * column populated by the same two writers that maintain
 * `checkpointStage` (storeConversationState + applyCheckpointUpdate).
 * `extractConversationMeta` now returns the parsed Date alongside the
 * existing fields so the writers can pass it straight to Prisma.
 *
 * This file pins:
 *   - Happy path: ISO 8601 string from checkpoint.checkpoint_at parses
 *     to the correct Date.
 *   - Missing field returns null (covers legacy rows pre-instrumentation
 *     and freshly-created admin rows with no checkpoint yet).
 *   - Malformed value returns null (defensive — bad data shouldn't
 *     throw and abort the write).
 *   - Existing messageCount/checkpointStage contracts unchanged.
 */

import { extractConversationMeta } from '../utils/conversation-meta';

describe('extractConversationMeta — checkpointAt', () => {
  it('parses checkpoint.checkpoint_at from an ISO 8601 string', () => {
    const result = extractConversationMeta({
      messages: [],
      checkpoint: {
        stage: 'awaiting_user_slot_selection',
        checkpoint_at: '2026-05-15T10:00:00.000Z',
      },
    });

    expect(result.checkpointAt).toBeInstanceOf(Date);
    expect(result.checkpointAt!.toISOString()).toBe('2026-05-15T10:00:00.000Z');
  });

  it('returns null when checkpoint is absent (legacy rows pre-instrumentation)', () => {
    const result = extractConversationMeta({ messages: [] });
    expect(result.checkpointAt).toBeNull();
  });

  it('returns null when checkpoint exists but checkpoint_at is missing', () => {
    const result = extractConversationMeta({
      messages: [],
      checkpoint: { stage: 'initial_contact' },
    });
    expect(result.checkpointAt).toBeNull();
  });

  it('returns null when checkpoint_at is a malformed string (defensive on bad data)', () => {
    const result = extractConversationMeta({
      messages: [],
      checkpoint: { stage: 'initial_contact', checkpoint_at: 'not-a-date' },
    });
    expect(result.checkpointAt).toBeNull();
  });

  it('returns null when checkpoint_at is the wrong type (e.g. number)', () => {
    const result = extractConversationMeta({
      messages: [],
      checkpoint: { stage: 'initial_contact', checkpoint_at: 1234567890 },
    });
    expect(result.checkpointAt).toBeNull();
  });

  it('returns null for the null/undefined input case', () => {
    expect(extractConversationMeta(null).checkpointAt).toBeNull();
  });

  it('accepts a JSON string input (the storeConversationState code path)', () => {
    const json = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      checkpoint: {
        stage: 'awaiting_therapist_confirmation',
        checkpoint_at: '2026-05-16T12:30:00.000Z',
      },
    });
    const result = extractConversationMeta(json);

    expect(result.messageCount).toBe(1);
    expect(result.checkpointStage).toBe('awaiting_therapist_confirmation');
    expect(result.checkpointAt!.toISOString()).toBe('2026-05-16T12:30:00.000Z');
  });

  it('returns null for unparseable JSON (defensive)', () => {
    const result = extractConversationMeta('{not valid json');
    expect(result.messageCount).toBe(0);
    expect(result.checkpointStage).toBeNull();
    expect(result.checkpointAt).toBeNull();
  });
});
