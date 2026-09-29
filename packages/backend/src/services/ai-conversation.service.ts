/**
 * AI Conversation Service
 *
 * Extracted from justin-time.service.ts — handles conversation state management,
 * state persistence with optimistic locking, conversation trimming, and the
 * lightweight inquiry reply flow (weekly mailing responses).
 *
 * This module owns all read/write operations on conversation state JSON,
 * including retry logic and compensation recording for failed saves.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicClient } from '../utils/anthropic-client';
import { CLAUDE_MODELS, MODEL_CONFIG } from '../config/models';
import { logger } from '../utils/logger';
import { firstName } from '../utils/first-name';
import { prisma } from '../utils/database';
import { sendEmail } from '../core/email';
import { emailQueueService } from './email-queue.service';
import { parseConversationState } from '../utils/json-parser';
import { extractConversationMeta } from '../utils/conversation-meta';
import { chaseResetIfStageChanged } from '../domain/scheduling/lifecycle/update-fragments';
import { wrapUntrustedContent } from '../utils/content-sanitizer';
import { getSettingValue } from './settings.service';
import { CONVERSATION_LIMITS } from '../constants';
import { resilientCall } from '../utils/resilient-call';
import { withSerializationRetry } from '../utils/serialization-retry';
import { circuitBreakerRegistry, CIRCUIT_BREAKER_CONFIGS } from '../utils/circuit-breaker';
import { ConcurrentModificationError } from '../errors';
import type { ConversationState } from '../types';
import type { Prisma } from '@prisma/client';
import {
  stageFromAction,
  updateCheckpoint,
  type ConversationAction,
  type ConversationCheckpoint,
  type ConversationStage,
} from '../services/conversation-checkpoint.service';

import type { ConversationMessage } from './scheduling-context.service';

const claudeCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.CLAUDE_API);

/**
 * What a conversation-state writer persists: the message log plus the
 * optional checkpoint / facts / responseTracking carried by
 * ConversationState. `systemPrompt` is optional because FIX #20 stores it
 * as '' (it's rebuilt every turn).
 */
export type StorableConversationState = Omit<ConversationState, 'systemPrompt' | 'messages'> & {
  systemPrompt?: string;
  messages: ConversationMessage[];
};

/**
 * Serialise a conversation state for the `conversationState` Json columns.
 *
 * Returns both the JSON text (for size checks / extractConversationMeta)
 * and a plain JSON OBJECT for the column. The object — never the string —
 * must be what's written: handing Prisma `JSON.stringify(state)` for a
 * Json column stores a jsonb string scalar (`jsonb_typeof = 'string'`),
 * which breaks every SQL-level jsonb path writer (lifecycle/audit.ts's
 * `jsonb_set` fails with `22023 cannot set path in scalar`, silently
 * dropping audit notes) and forces readers into `#>> '{}'` unwrap hacks.
 * Round-tripping through JSON also guarantees the value is plain JSON
 * (no Date instances / undefined) and matches the text the denormalised
 * columns are derived from.
 */
function serialiseConversationState(state: object): { json: string; value: Prisma.InputJsonObject } {
  const json = JSON.stringify(state);
  return { json, value: JSON.parse(json) as Prisma.InputJsonObject };
}

/** Truncate message content to prevent state size bombs */
export function truncateMessageContent(content: string): string {
  const MAX_LENGTH = CONVERSATION_LIMITS.MAX_MESSAGE_LENGTH;
  const SUFFIX = CONVERSATION_LIMITS.TRUNCATION_SUFFIX;
  if (content.length <= MAX_LENGTH) return content;
  return content.slice(0, MAX_LENGTH - SUFFIX.length) + SUFFIX;
}

/** Limits `trimConversationState` enforces. */
export interface ConversationTrimLimits {
  /** Message count above which the state is trimmed (`agent.maxMessages`). */
  maxMessages: number;
  /** Message count a count-triggered trim keeps (`agent.trimToMessages`). */
  trimToMessages: number;
  /** Serialised-size cap (UTF-8 bytes), enforced on every save. */
  maxStateBytes: number;
}

const DEFAULT_TRIM_LIMITS: ConversationTrimLimits = {
  maxMessages: CONVERSATION_LIMITS.MAX_MESSAGES,
  trimToMessages: CONVERSATION_LIMITS.TRIM_TO_MESSAGES,
  maxStateBytes: CONVERSATION_LIMITS.MAX_STATE_BYTES,
};

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * Trim limits from the admin settings (`agent.maxMessages`,
 * `agent.trimToMessages` — defined in setting-definitions but never read
 * before), falling back to the CONVERSATION_LIMITS defaults when a setting
 * is unreadable or not a positive number. `trimToMessages` is clamped to
 * `maxMessages` so a misconfigured pair can't disable trimming.
 */
async function readTrimLimits(): Promise<ConversationTrimLimits> {
  let maxMessages = DEFAULT_TRIM_LIMITS.maxMessages;
  let trimToMessages = DEFAULT_TRIM_LIMITS.trimToMessages;
  try {
    maxMessages = positiveIntOr(await getSettingValue<number>('agent.maxMessages'), maxMessages);
    trimToMessages = positiveIntOr(await getSettingValue<number>('agent.trimToMessages'), trimToMessages);
  } catch (err) {
    logger.warn({ err }, 'Failed to read conversation trim settings; using defaults');
  }
  return {
    maxMessages,
    trimToMessages: Math.min(trimToMessages, maxMessages),
    maxStateBytes: DEFAULT_TRIM_LIMITS.maxStateBytes,
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Where a turn's in-memory conversation state stands relative to the
 * stored row: the `conversationVersion` it last read or wrote, and how
 * many of its in-memory messages that version already contains. Messages
 * past `persistedCount` are the turn's own and not yet saved. The turn
 * save methods advance it in place.
 */
export interface ConversationSaveCursor {
  version: number | undefined;
  persistedCount: number;
}

/** Rebase attempts before a turn save gives up on a busy row. */
const MAX_TURN_SAVE_REBASES = 3;

export class AIConversationService {
  private traceId: string;

  constructor(traceId?: string) {
    this.traceId = traceId || 'ai-conversation';
  }

  /**
   * Store conversation state in database with optimistic locking.
   *
   * The version is the dedicated `conversationVersion` counter, NOT
   * `updatedAt`: every other write to the row (the dispatch human-control
   * gate, send.ts's outbound stamps, lifecycle transitions) bumps
   * `@updatedAt`, so an updatedAt CAS made the agent's end-of-turn save
   * conflict with its own tool calls. Only conversation-state writers
   * touch `conversationVersion`, and each one increments it.
   *
   * Automatically trims state if it exceeds size limits.
   *
   * FIX ST2: Atomic state storage with activity recording
   * Previously, recordActivity was called separately which could succeed
   * while storeConversationState failed, creating inconsistent data.
   * Now includes activity update in the same atomic operation.
   *
   * @param expectedVersion - the `conversationVersion` the caller read.
   *   When supplied the write only lands if the row still carries it
   *   (ConcurrentModificationError otherwise). Omit only for a first
   *   write where no version has been read.
   * @returns the row's new `conversationVersion`, so a caller that saves
   *   more than once in a turn can chain its CAS without a re-read.
   */
  async storeConversationState(
    appointmentRequestId: string,
    state: StorableConversationState,
    expectedVersion?: number
  ): Promise<number> {
    // Trim to the admin-configured message limits AND the byte cap —
    // checked on every save, whatever the message count.
    const trimmedState = this.trimConversationState(state, await readTrimLimits());
    const { json: stateJson, value: stateValue } = serialiseConversationState(trimmedState);
    const now = new Date();
    // FIX #21: Extract denormalized metadata to avoid loading full blob in list queries.
    // checkpointAt was added to drop the chase candidate query's conversationState fetch.
    const { messageCount, checkpointStage, checkpointAt } = extractConversationMeta(stateJson);

    // Detect checkpoint-stage advance — chase-reset invariant.
    //
    // The agent loop mutates `state.checkpoint` in memory after a
    // tool returns a `checkpointAction`, then saves the whole state
    // here at end-of-turn. That's the DOMINANT path for stage
    // transitions; `applyCheckpointUpdate` only covers chase-sending
    // + closure-dismiss callers. Without this read, the agent's
    // natural advance from `awaiting_therapist_availability` →
    // `awaiting_user_slot_selection` (etc.) leaves `chaseSentAt`
    // pinned forever and the next stage never gets chased.
    //
    // Same pattern as `applyCheckpointUpdate` — read the OLD stage
    // from the denormalised column, compare against the new stage
    // derived from the saved state. Cheap (indexed lookup of one
    // column; row likely cached because we're about to write it).
    const existing = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentRequestId },
      select: { checkpointStage: true },
    });
    // Chase-reset on stage advance. The rule + the field set live
    // together in `update-fragments` so the two writers of
    // `checkpointStage` (this method + `applyCheckpointUpdate`)
    // stay in lock-step on the invariant.
    //
    // A state with NO checkpoint (a legacy row, or one that so far only
    // holds lifecycle audit notes appended before the agent ran) leaves
    // the stage columns alone: the column is then the only record of the
    // stage (processEmailReply seeds the checkpoint from it), and a
    // null-vs-stage "change" would wrongly reset the chase sentinels.
    const stageFields = checkpointStage === null
      ? {}
      : {
          checkpointStage,
          checkpointAt,
          // Chase-reset on stage advance — see the read above.
          ...chaseResetIfStageChanged(existing?.checkpointStage ?? null, checkpointStage),
        };

    // `!== undefined`, not truthiness: version 0 is a real version (every
    // row starts there).
    if (expectedVersion !== undefined) {
      // Use optimistic locking - only update if version matches.
      // FIX ST2: Include activity recording in same atomic operation.
      //
      // withSerializationRetry re-runs the whole transaction on a
      // transient DB error (dropped connection, expired transaction) —
      // nothing was committed, so a clean re-run is correct. A
      // ConcurrentModificationError is NOT transient and propagates
      // immediately to the caller's optimistic-lock handling.
      await withSerializationRetry(
        () => prisma.$transaction(async (tx) => {
          const result = await tx.appointmentRequest.updateMany({
            where: {
              id: appointmentRequestId,
              conversationVersion: expectedVersion,
            },
            data: {
              conversationState: stateValue,
              conversationVersion: { increment: 1 },
              updatedAt: now,
              // FIX ST2: Atomic activity recording - no separate call needed
              lastActivityAt: now,
              isStale: false,
              messageCount,
              ...stageFields,
            },
          });

          if (result.count === 0) {
            // Version mismatch - another conversation-state writer got
            // there first. Use the typed error so callers can
            // `instanceof`-check rather than string-matching the message
            // (fragile across rephrasings).
            throw new ConcurrentModificationError(appointmentRequestId);
          }

        }),
        { appointmentRequestId, op: 'storeConversationState' },
        (msg, ctx) => logger.warn({ traceId: this.traceId, ...ctx }, msg),
      );
      // The CAS matched `expectedVersion` and incremented it under the
      // row lock, so the new version is exactly one higher.
      return expectedVersion + 1;
    } else {
      // Call without a version check (a first write where the caller has
      // no version to compare against). Still increments the version so
      // any reader holding the old one detects this write.
      // FIX ST2: Include activity recording in same atomic operation.
      return withSerializationRetry(
        () => prisma.$transaction(async (tx) => {
          const updated = await tx.appointmentRequest.update({
            where: { id: appointmentRequestId },
            data: {
              conversationState: stateValue,
              conversationVersion: { increment: 1 },
              updatedAt: now,
              // FIX ST2: Atomic activity recording
              lastActivityAt: now,
              isStale: false,
              messageCount,
              ...stageFields,
            },
            select: { id: true, conversationVersion: true },
          });

          return updated?.conversationVersion;
        }),
        { appointmentRequestId, op: 'storeConversationState:init' },
        (msg, ctx) => logger.warn({ traceId: this.traceId, ...ctx }, msg),
      );
    }
  }

  /**
   * Atomically apply a checkpoint mutation AND optional extra field updates.
   *
   * The single source of truth for checkpoint state is
   * `conversationState.checkpoint` (JSON). The denormalized DB column
   * `checkpointStage` is derived from the JSON and must never be written
   * directly by callers — use this helper instead.
   *
   * This exists because prior code had ~4 different direct writers of
   * `appointmentRequest.checkpointStage` (chase-email, ai-tool-executor,
   * justin-time reschedule path, dismissClosureRecommendation). They drifted
   * out of sync with the JSON and caused real bugs. Routing everything
   * through this helper enforces the invariant column == derive(JSON).
   *
   * Handles optimistic-lock conflicts with a small retry budget. If the
   * caller supplies `extraWhere` (e.g. a sentinel guard), a lost-lock is
   * treated as a semantic failure — we don't retry past a changed guard.
   *
   * Use `applyCheckpointAction` for the common case of "advance via a
   * ConversationAction". Use this lower-level `applyCheckpointUpdate` when
   * the new checkpoint depends on the current one (e.g. dismissing closure
   * and restoring an inferred prior stage).
   */
  async applyCheckpointUpdate(
    appointmentRequestId: string,
    mutate: (current: ConversationCheckpoint | null) => ConversationCheckpoint,
    options?: {
      extraUpdates?: Prisma.AppointmentRequestUpdateInput;
      extraWhere?: Prisma.AppointmentRequestWhereInput;
      maxRetries?: number;
    }
  ): Promise<{ applied: boolean; stage: string | null }> {
    const maxRetries = options?.maxRetries ?? 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const record = await prisma.appointmentRequest.findUnique({
        where: { id: appointmentRequestId },
        // checkpointStage is the denormalised column kept in sync
        // with `conversationState.checkpoint.stage` (see this very
        // function's docstring for the invariant). The chase-reset
        // rule compares against the column because that's what the
        // chase scheduler reads. conversationVersion is the CAS token
        // (see storeConversationState).
        select: { conversationState: true, checkpointStage: true, conversationVersion: true },
      });
      if (!record) {
        return { applied: false, stage: null };
      }

      const state = record.conversationState
        ? parseConversationState(record.conversationState as Prisma.JsonValue)
        : null;
      if (!state) {
        // No conversation state yet — can't apply a checkpoint mutation.
        // Happens very early in the lifecycle before the agent runs.
        return { applied: false, stage: null };
      }

      // Capture the OLD stage from the denormalised column so we
      // can detect a checkpoint advance — when the stage flips
      // (e.g. therapist replies with availability → row moves to
      // `awaiting_user_slot_selection`) we reset the chase-sentinel
      // triplet so the chase scheduler can fire one chase per
      // STAGE, not one chase per APPOINTMENT.
      const oldStage = record.checkpointStage;

      state.checkpoint = mutate(state.checkpoint ?? null);
      const { json: stateJson, value: stateValue } = serialiseConversationState(
        this.trimConversationState(state, await readTrimLimits()),
      );
      const { messageCount, checkpointStage, checkpointAt } = extractConversationMeta(stateJson);

      const now = new Date();

      // Chase-reset on stage advance. Rule + field set live in
      // `update-fragments` — same helper used by
      // `storeConversationState` so the two writers can't drift.
      const chaseResetFields = chaseResetIfStageChanged(oldStage, checkpointStage);

      const transactionResult = await withSerializationRetry(
        () => prisma.$transaction(async (tx) => {
          const result = await tx.appointmentRequest.updateMany({
            where: {
              id: appointmentRequestId,
              conversationVersion: record.conversationVersion,
              ...options?.extraWhere,
            },
            data: {
              conversationState: stateValue,
              messageCount,
              checkpointStage,
              checkpointAt,
              updatedAt: now,
              ...chaseResetFields,
              ...options?.extraUpdates,
              // After extraUpdates so a caller can't accidentally clobber
              // the version bump.
              conversationVersion: { increment: 1 },
            },
          });


          return result;
        }),
        { appointmentRequestId, op: 'applyCheckpointUpdate' },
        (msg, ctx) => logger.warn({ traceId: this.traceId, ...ctx }, msg),
      );

      if (transactionResult.count === 1) {
        return { applied: true, stage: checkpointStage };
      }

      // Lost the optimistic lock. If the caller's extraWhere guard failed
      // (e.g. sentinel changed), that's a semantic failure — stop retrying.
      if (options?.extraWhere) {
        const stillMatchesGuard = await prisma.appointmentRequest.count({
          where: { id: appointmentRequestId, ...options.extraWhere },
        });
        if (stillMatchesGuard === 0) {
          logger.info(
            { appointmentRequestId },
            'applyCheckpointUpdate: caller guard no longer matches, stopping retry'
          );
          return { applied: false, stage: null };
        }
      }

      logger.debug(
        { appointmentRequestId, attempt: attempt + 1 },
        'applyCheckpointUpdate: optimistic lock conflict, retrying'
      );
    }

    logger.warn(
      { appointmentRequestId, maxRetries },
      'applyCheckpointUpdate: exhausted retry budget on optimistic lock conflicts'
    );
    return { applied: false, stage: null };
  }

  /**
   * Convenience wrapper for the common "advance checkpoint via a
   * ConversationAction" case. Delegates to `applyCheckpointUpdate`.
   */
  async applyCheckpointAction(
    appointmentRequestId: string,
    action: ConversationAction,
    options?: {
      extraUpdates?: Prisma.AppointmentRequestUpdateInput;
      extraWhere?: Prisma.AppointmentRequestWhereInput;
      contextUpdates?: { lastEmailSentTo?: 'user' | 'therapist' };
      maxRetries?: number;
    }
  ): Promise<{ applied: boolean; stage: string | null }> {
    return this.applyCheckpointUpdate(
      appointmentRequestId,
      (current) => updateCheckpoint(current, action, null, options?.contextUpdates),
      options,
    );
  }

  /**
   * Append a single message to the conversation log under optimistic
   * locking (CAS on conversationVersion, which the append bumps) so a
   * concurrent agent save / chase-tick / second admin click can't
   * silently overwrite it — and so an agent turn in flight sees the bump
   * and rebases onto it (see saveTurnState) instead of saving over it.
   *
   * Used by admin endpoints (send-message, release-control) and by the
   * lifecycle audit-note writer (lifecycle/audit.ts). The caller's
   * email/Slack/transition side effect has already happened; this
   * persists the record of it.
   *
   * Behaviour:
   *   - A row with no conversationState yet gets one holding just this
   *     message (lifecycle notes can precede the agent's first save).
   *     A state that exists but can't be parsed is left alone (returns
   *     false) rather than overwritten.
   *   - On an optimistic-lock conflict the helper re-reads and re-applies,
   *     up to three attempts, then the error bubbles so the caller can log
   *     loudly — the prior side effect already happened, so a missed entry
   *     is the loss of a record, not duplicate work.
   *
   * Returns: true if the message was appended, false if the row is missing
   * or its state is unreadable.
   */
  async appendConversationMessage(
    appointmentRequestId: string,
    message: ConversationMessage,
  ): Promise<boolean> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      const row = await prisma.appointmentRequest.findUnique({
        where: { id: appointmentRequestId },
        select: { conversationState: true, conversationVersion: true },
      });
      if (!row) return false;
      const state: StorableConversationState | null = row.conversationState
        ? parseConversationState(row.conversationState)
        : { systemPrompt: '', messages: [] };
      if (!state) return false;

      state.messages.push(message);
      try {
        await this.storeConversationState(appointmentRequestId, state, row.conversationVersion);
        return true;
      } catch (err) {
        if (err instanceof ConcurrentModificationError && attempt < MAX_ATTEMPTS) {
          logger.warn(
            { traceId: this.traceId, appointmentRequestId, attempt },
            'appendConversationMessage hit optimistic-lock conflict — retrying',
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Save an agent turn's state under optimistic locking, rebasing onto any
   * conversation writes that landed since the turn last read or wrote the
   * row (a lifecycle audit note from a transition the turn itself
   * triggered, an admin append, a chase checkpoint update).
   *
   * On a ConcurrentModificationError the stored state is re-read and the
   * turn's own unsaved messages (those past `cursor.persistedCount`) are
   * appended to it; the turn's checkpoint / facts / responseTracking are
   * kept, since the turn is the fresher writer of those. The rebased
   * message list replaces `state.messages` IN PLACE, so the caller's
   * in-memory state keeps matching the row and later saves in the same
   * turn stay consistent. Before this, the end-of-turn save simply
   * overwrote such writes — e.g. the "[System: agent] confirmed" note the
   * turn's own mark_scheduling_complete had just appended.
   *
   * Advances `cursor` on success. Throws the ConcurrentModificationError if
   * the row is still being written after MAX_TURN_SAVE_REBASES rebases, and
   * any non-conflict error as-is.
   */
  async saveTurnState(
    appointmentRequestId: string,
    state: StorableConversationState,
    cursor: ConversationSaveCursor,
  ): Promise<void> {
    for (let rebases = 0; ; rebases++) {
      try {
        cursor.version = await this.storeConversationState(appointmentRequestId, state, cursor.version);
        cursor.persistedCount = state.messages.length;
        return;
      } catch (err) {
        if (!(err instanceof ConcurrentModificationError) || rebases >= MAX_TURN_SAVE_REBASES) throw err;
        const latest = await this.getConversationState(appointmentRequestId);
        if (!latest) throw err;
        const ownMessages = state.messages.slice(cursor.persistedCount);
        state.messages.splice(0, state.messages.length, ...latest.messages, ...ownMessages);
        cursor.version = latest._version;
        cursor.persistedCount = latest.messages.length;
        logger.info(
          {
            traceId: this.traceId,
            appointmentRequestId,
            rebasedOntoVersion: latest._version,
            ownMessages: ownMessages.length,
          },
          'Conversation state changed during the turn — rebased the turn\'s messages onto it',
        );
      }
    }
  }

  /**
   * FIX RSA-4: end-of-turn save. Conflicts are rebased (saveTurnState);
   * transient failures are retried with exponential backoff. If all
   * retries fail, records compensation data for manual recovery.
   */
  async storeConversationStateWithRetry(
    appointmentRequestId: string,
    state: StorableConversationState,
    cursor: ConversationSaveCursor,
    executedTools: Array<{ toolName: string; emailSentTo?: 'user' | 'therapist'; timestamp: string }>
  ): Promise<{ success: boolean; retriesUsed: number }> {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 100;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.saveTurnState(appointmentRequestId, state, cursor);
        return { success: true, retriesUsed: attempt };
      } catch (error) {
        // A conflict that survived saveTurnState's rebases means the row
        // is under sustained concurrent writes — not a transient error.
        if (error instanceof ConcurrentModificationError) {
          logger.warn(
            { traceId: this.traceId, appointmentRequestId, attempt },
            'State save conflict persisted after rebasing - not retrying (concurrent modification)'
          );
          break;
        }
        const errorMsg = error instanceof Error ? error.message : 'Unknown';

        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            { traceId: this.traceId, appointmentRequestId, attempt, delay, error: errorMsg },
            'State save failed - retrying'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted - record compensation data
    const emailTools = executedTools.filter(t => t.toolName === 'send_email');

    if (emailTools.length > 0) {
      // Log critical compensation data for manual recovery
      logger.error(
        {
          traceId: this.traceId,
          appointmentRequestId,
          compensationRequired: true,
          emailsSent: emailTools,
          stateSnapshot: {
            messageCount: state.messages.length,
            lastMessage: state.messages.slice(-1)[0],
          },
        },
        'COMPENSATION REQUIRED: Emails sent but state save failed - manual recovery needed'
      );

      // Attempt to persist minimal compensation record to database
      try {
        const existingRecord = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentRequestId },
          select: { notes: true },
        });
        const compensationNote = `[COMPENSATION ${new Date().toISOString()}] Emails sent but state save failed. Emails: ${JSON.stringify(emailTools)}`;
        const newNotes = existingRecord?.notes
          ? `${compensationNote}\n\n${existingRecord.notes}`
          : compensationNote;

        await prisma.appointmentRequest.update({
          where: { id: appointmentRequestId },
          data: { notes: newNotes },
          select: { id: true },
        });
        logger.info(
          { traceId: this.traceId, appointmentRequestId },
          'Compensation record saved to notes field'
        );
      } catch (compensationError) {
        logger.error(
          { traceId: this.traceId, appointmentRequestId, error: compensationError },
          'Failed to save compensation record - data only in logs'
        );
      }
    }

    return { success: false, retriesUsed: MAX_RETRIES };
  }

  /**
   * Get conversation state from database with version info for optimistic
   * locking. `_version` is the row's `conversationVersion` — pass it back
   * to storeConversationState as `expectedVersion`.
   */
  async getConversationState(
    appointmentRequestId: string
  ): Promise<ConversationState & { _version: number } | null> {
    const request = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentRequestId },
      select: { conversationState: true, conversationVersion: true },
    });

    if (!request?.conversationState) {
      return null;
    }

    const parsed = parseConversationState(request.conversationState);
    if (!parsed) {
      return null;
    }

    return {
      ...parsed,
      _version: request.conversationVersion,
    };
  }

  /**
   * Trim conversation state to prevent unbounded growth.
   *
   * Two triggers, both checked on EVERY save:
   *   - count: more than `limits.maxMessages` messages → keep
   *     `limits.trimToMessages` of them;
   *   - size: the serialised state exceeds `limits.maxStateBytes` → drop
   *     as many messages as it takes to fit. (Previously the size check
   *     only ran above ~256 messages, so a 20-message state of 45KB
   *     messages grew past the 500KB read limit and became unreadable —
   *     every later turn failed with "Conversation state not found".)
   *
   * Strategy: keep BOTH ends of the conversation, drop the middle.
   *   - First TRIM_KEEP_FIRST messages: initial booking context (who, what, when).
   *     The agent always needs these to understand what the conversation is about,
   *     even after a long reschedule chain.
   *   - The most recent messages: recent context.
   *   - One placeholder message in between explaining how many messages were dropped.
   * When the size cap still isn't met, the tail shrinks first (always keeping
   * the newest message), then the head.
   *
   * Only `messages` is rewritten: every other field (checkpoint, facts,
   * responseTracking, systemPrompt, anything added later) is carried over
   * unchanged. Returning a hand-picked `{ systemPrompt, messages }` here
   * used to wipe the agent's checkpoint and facts on exactly the long
   * conversations that most need them.
   */
  trimConversationState<T extends { messages: ConversationMessage[] }>(
    state: T,
    limits: ConversationTrimLimits = DEFAULT_TRIM_LIMITS,
  ): T {
    const { maxMessages, trimToMessages, maxStateBytes } = limits;
    const messages = state.messages;
    const total = messages.length;
    const overCount = total > maxMessages;
    if (!overCount && jsonBytes(state) <= maxStateBytes) {
      return state;
    }

    // Exact serialised size of a candidate without building it:
    //   bytes({...state, messages: []}) + Σ bytes(message) + (count - 1) commas.
    const baseBytes = jsonBytes({ ...state, messages: [] });
    const prefixBytes = [0];
    for (const m of messages) prefixBytes.push(prefixBytes[prefixBytes.length - 1] + jsonBytes(m));
    const placeholderFor = (dropped: number, first: number, last: number): ConversationMessage => ({
      role: 'user',
      content: `[System Note: ${dropped} middle messages were trimmed to maintain performance. The first ${first} messages (initial booking context) and the last ${last} messages (recent activity) are preserved.]`,
    });
    const sizeOf = (first: number, last: number): number => {
      const dropped = total - first - last;
      const kept = first + last + (dropped > 0 ? 1 : 0);
      const keptBytes =
        prefixBytes[first] +
        (prefixBytes[total] - prefixBytes[total - last]) +
        (dropped > 0 ? jsonBytes(placeholderFor(dropped, first, last)) : 0);
      return baseBytes + keptBytes + Math.max(0, kept - 1);
    };

    // Reserve one slot for the placeholder; split the rest between head
    // (initial context) and tail (recent context). A size-only trim starts
    // from everything and sheds messages until it fits.
    // (The head never takes the last message: the newest is always kept.)
    let keepFirst = Math.min(CONVERSATION_LIMITS.TRIM_KEEP_FIRST, Math.max(0, total - 1));
    let keepLast = overCount
      ? Math.max(1, trimToMessages - keepFirst - 1)
      : total - keepFirst;
    keepLast = Math.min(keepLast, total - keepFirst);
    while (sizeOf(keepFirst, keepLast) > maxStateBytes && keepLast > 1) keepLast--;
    while (sizeOf(keepFirst, keepLast) > maxStateBytes && keepFirst > 0) keepFirst--;

    const droppedCount = total - keepFirst - keepLast;
    // If nothing would actually be dropped (very short conversation), return as-is
    if (droppedCount <= 0) {
      return state;
    }

    const trimmedMessages = [
      ...messages.slice(0, keepFirst),
      placeholderFor(droppedCount, keepFirst, keepLast),
      ...messages.slice(total - keepLast),
    ];

    logger.info(
      {
        originalCount: total,
        trimmedCount: trimmedMessages.length,
        keepFirst,
        keepLast,
        droppedCount,
        trigger: overCount ? 'message_count' : 'state_bytes',
      },
      'Trimmed conversation state (head+tail strategy)'
    );

    return {
      ...state,
      messages: trimmedMessages,
    };
  }

  /**
   * Process a reply to the weekly promotional email (inquiry mode)
   * This is a lightweight handler for general questions - NOT for booking flows
   *
   * The agent answers questions about Spill's therapy services and directs
   * users to the booking URL to start an actual booking.
   */
  async processInquiryReply(
    inquiryId: string,
    emailContent: string,
    fromEmail: string,
    threadContext?: string
  ): Promise<{ success: boolean; message: string }> {
    logger.info(
      { traceId: this.traceId, inquiryId, fromEmail },
      'Processing weekly mailing inquiry reply'
    );

    try {
      // Get the inquiry record
      const inquiry = await prisma.weeklyMailingInquiry.findUnique({
        where: { id: inquiryId },
      });

      if (!inquiry) {
        throw new Error('Weekly mailing inquiry not found');
      }

      // Get booking URL from settings
      const bookingUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');

      // Build lightweight inquiry system prompt
      const systemPrompt = await this.buildInquirySystemPrompt(
        inquiry.userName || 'User',
        bookingUrl
      );

      // Get or initialize conversation state
      let conversationState: ConversationState;
      if (inquiry.conversationState) {
        const parsed = parseConversationState(inquiry.conversationState);
        conversationState = parsed || { systemPrompt, messages: [] };
      } else {
        conversationState = { systemPrompt, messages: [] };
      }

      // Wrap email content for safety
      const safeEmailContent = wrapUntrustedContent(emailContent, 'email');

      // Build the new message
      let newMessage: string;
      if (threadContext) {
        const safeThreadContext = wrapUntrustedContent(threadContext, 'thread_history');
        newMessage = `A user who received our weekly promotional email has replied. Below is the conversation history and their new message.

${safeThreadContext}

=== NEW MESSAGE ===
From: ${fromEmail}
${safeEmailContent}

Please answer their question helpfully and direct them to the booking URL to schedule a session.`;
      } else {
        newMessage = `A user who received our weekly promotional email has replied:

From: ${fromEmail}
${safeEmailContent}

Please answer their question helpfully and direct them to the booking URL to schedule a session.`;
      }

      // Add to conversation state
      conversationState.messages.push({
        role: 'user',
        content: truncateMessageContent(newMessage),
      });

      // Tools available: send_email and unsubscribe_user
      const inquiryTools: Anthropic.Tool[] = [
        {
          name: 'send_email',
          description:
            'Send an email reply to the person you are replying to. You do NOT supply a recipient — ' +
            'the system always sends to the verified sender of this conversation.',
          input_schema: {
            type: 'object',
            properties: {
              subject: { type: 'string', description: 'Email subject line. MUST include "Spill" somewhere in the subject.' },
              body: { type: 'string', description: 'Email body content' },
            },
            required: ['subject', 'body'],
          },
        },
        {
          name: 'unsubscribe_user',
          description: 'Unsubscribe the user you are currently replying to from weekly promotional emails. Use this when they explicitly ask to be removed from the mailing list or to stop receiving emails. You do NOT supply an email address — the system unsubscribes the verified sender of this conversation.',
          input_schema: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'Brief note about why they unsubscribed (optional)' },
            },
            required: [],
          },
        },
      ];

      // Build messages for Claude
      const messagesForClaude: Anthropic.MessageParam[] = conversationState.messages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

      // Call Claude
      const response = await resilientCall(
        () => anthropicClient.messages.create({
          model: CLAUDE_MODELS.AGENT,
          max_tokens: MODEL_CONFIG.agent.maxTokens,
          system: systemPrompt,
          tools: inquiryTools,
          messages: messagesForClaude,
        }),
        { context: 'processInquiryReply', traceId: this.traceId, circuitBreaker: claudeCircuitBreaker }
      );

      // Process response
      const toolCalls = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      const assistantText = textBlocks.map(b => b.text).join('\n');

      if (assistantText) {
        conversationState.messages.push({
          role: 'assistant',
          content: truncateMessageContent(assistantText),
        });
      }

      // Execute tool calls
      for (const toolCall of toolCalls) {
        if (toolCall.name === 'send_email') {
          const input = toolCall.input as { subject: string; body: string; to?: unknown };

          // SECURITY: the recipient is pinned to the inquiry's verified
          // sender. The model never chooses the address — a prompt-injected
          // reply must not be able to make scheduling@ email a third party,
          // and a model-supplied `to` (legacy schema) is ignored outright.
          const recipient = inquiry.userEmail;
          if (typeof input.to === 'string' && input.to.trim().toLowerCase() !== recipient.toLowerCase()) {
            logger.warn(
              { traceId: this.traceId, inquiryId, ignoredTo: input.to },
              'Inquiry send_email supplied a recipient that is not the verified sender — ignoring it',
            );
          }

          // Ensure subject includes "Spill" for brand consistency
          let normalizedSubject = input.subject;
          if (!input.subject.toLowerCase().includes('spill')) {
            normalizedSubject = `Spill - ${input.subject}`;
            logger.info(
              { traceId: this.traceId, originalSubject: input.subject, normalizedSubject },
              'Added "Spill" prefix to inquiry email subject'
            );
          }

          logger.info(
            { traceId: this.traceId, inquiryId, to: recipient, subject: normalizedSubject },
            'Sending inquiry response email'
          );

          // Try to send directly, fall back to queue
          try {
            await sendEmail({
              to: recipient,
              subject: normalizedSubject,
              body: input.body,
              threadId: inquiry.gmailThreadId || undefined,
            });
          } catch (sendError) {
            logger.warn(
              { traceId: this.traceId, error: sendError },
              'Could not send inquiry email directly, queuing for later'
            );
            // Queue without appointmentId (inquiry emails don't have one)
            await emailQueueService.enqueue({
              to: recipient,
              subject: normalizedSubject,
              body: input.body,
            });
          }

          // Log tool execution
          conversationState.messages.push({
            role: 'user',
            content: `[Tool executed: send_email to ${recipient}]`,
          });
        } else if (toolCall.name === 'unsubscribe_user') {
          const input = toolCall.input as { reason?: string };
          // Unsubscribe the VERIFIED sender of this inquiry, never an address
          // supplied by the model. The inbound was matched to
          // `inquiry.userEmail` (by thread id / sender), so that's the only
          // address we can safely act on — a model-supplied email could
          // mis-target a third party named in the body, or be hallucinated.
          const targetEmail = inquiry.userEmail.toLowerCase();

          logger.info(
            { traceId: this.traceId, inquiryId, email: targetEmail, reason: input.reason },
            'Unsubscribing user from weekly mailing list'
          );

          try {
            // updateMany returns count=0 if the user doesn't exist, which we
            // treat as already-unsubscribed.
            const result = await prisma.user.updateMany({
              where: {
                email: targetEmail,
                subscribed: true,
              },
              data: { subscribed: false },
            });

            if (result.count > 0) {
              logger.info(
                { traceId: this.traceId, email: targetEmail },
                'User unsubscribed from weekly mailing list'
              );
            } else {
              logger.warn(
                { traceId: this.traceId, email: targetEmail },
                'User not found or already unsubscribed'
              );
            }

            // Mark the inquiry as resolved
            await prisma.weeklyMailingInquiry.update({
              where: { id: inquiryId },
              data: { status: 'resolved' },
            });

            // Log tool execution
            conversationState.messages.push({
              role: 'user',
              content: `[Tool executed: unsubscribe_user for ${targetEmail}${input.reason ? ` - Reason: ${input.reason}` : ''}]`,
            });
          } catch (unsubError) {
            logger.error(
              { traceId: this.traceId, error: unsubError, email: targetEmail },
              'Failed to unsubscribe user'
            );
            conversationState.messages.push({
              role: 'user',
              content: `[Tool failed: unsubscribe_user for ${targetEmail} - Error occurred]`,
            });
          }
        }
      }

      // Save conversation state — as a JSON object, not a JSON string
      // (see serialiseConversationState).
      await prisma.weeklyMailingInquiry.update({
        where: { id: inquiryId },
        data: {
          conversationState: serialiseConversationState(conversationState).value,
          updatedAt: new Date(),
        },
      });

      return { success: true, message: 'Inquiry reply processed' };
    } catch (error) {
      logger.error(
        { error, traceId: this.traceId, inquiryId, fromEmail },
        'Failed to process weekly mailing inquiry reply'
      );
      throw error;
    }
  }

  /**
   * Build a lightweight system prompt for inquiry handling (not booking)
   */
  private async buildInquirySystemPrompt(userName: string, bookingUrl: string): Promise<string> {
    const agentName = await getSettingValue<string>('agent.fromName');
    const sessionDuration = await getSettingValue<number>('agent.sessionDurationMinutes');

    return `# ${agentName} - Inquiry Handler

You are ${agentName}, a friendly assistant responding to someone who replied to Spill's weekly promotional email.

## Your Role
This is an INQUIRY channel only - you answer questions and direct users to the booking website. You do NOT handle bookings here.

## Your Goal
1. Answer any questions the user has about Spill's therapy services
2. Be helpful, warm, and professional
3. **Always** direct them to the booking page: ${bookingUrl}

## CRITICAL: No Direct Booking
**You cannot book appointments through this email channel.** If someone asks to book, requests specific times, or tries to schedule a session via email:

1. Acknowledge their request warmly
2. Explain that booking is done through our website for the best experience
3. Provide the booking link: ${bookingUrl}
4. Let them know they can choose their preferred therapist and time there

Example responses for booking requests:
- "I'd love to help you book! To see all available therapists and times, please visit ${bookingUrl} - you can choose the perfect slot for you there."
- "Great that you're ready to book! Head over to ${bookingUrl} where you can browse our therapists and pick a time that works for you."

## Key Information About Spill
- Spill provides professional therapy sessions
- Sessions are typically ${sessionDuration} minutes
- Users can book at their convenience through the web app
- All sessions are confidential

## User Information
- Name: ${userName}

## Guidelines
- Keep responses brief (1-2 paragraphs max)
- Be warm and encouraging without being pushy
- For questions about therapy approaches, specific therapists, or pricing, suggest they explore the booking page or book a session
- **Always** include the booking URL in your response
- Sign off as "${firstName(agentName)}" or "The Spill Team"

## What You Can Help With
- General questions about Spill's therapy services
- How the booking process works
- What to expect from a session
- Reassurance and encouragement

## What You Cannot Do Here
- Book appointments (direct to website)
- Offer specific therapist availability (direct to website)
- Promise specific times or therapists (direct to website)
- Handle rescheduling or cancellations (direct to website)

## Handling Unsubscribe Requests
If a user asks to unsubscribe, stop receiving emails, or be removed from the mailing list:
1. Use the unsubscribe_user tool — you do NOT pass an email address; it unsubscribes the person you're replying to
2. Then send a friendly confirmation email acknowledging their request
3. Be understanding and professional - don't try to convince them to stay

Example unsubscribe response:
"Hi [Name], I've removed you from our mailing list - you won't receive any more promotional emails from us. If you ever change your mind, you can always visit ${bookingUrl} to book a session. Take care!"

## Available Tools
- send_email: Use this to reply to the user's message
- unsubscribe_user: Use this to remove the current user from the weekly mailing list when they request it`;
  }
}

// Singleton for callers that don't need per-request tracing (chase-email,
// lifecycle transitions, etc). The traceId is only used for logging inside
// the instance, so a default is fine here.
export const aiConversationService = new AIConversationService('shared');

/**
 * Choose the stage to fall back to when dismissing a closure recommendation
 * whose JSON checkpoint is wedged at `closure_recommended`.
 *
 * Two paths can wedge the JSON at this stage and both lose direct access to
 * the actual prior stage:
 *
 *   1. Chase-recommended (chase-email): prior action was 'sent_chase_followup'
 *      which gets overwritten by 'closure_recommended_to_admin' →
 *      lastSuccessfulAction maps to 'closure_recommended' (uninformative).
 *      The chase path DOES set `chaseSentTo`, so that's the strongest signal.
 *
 *   2. Agent-recommended (recommend_cancel_match): the agent overwrites
 *      lastSuccessfulAction with 'recommended_cancel_match' (also maps to
 *      'closure_recommended', uninformative) and never sets `chaseSentTo`.
 *      Without consulting other state we'd always fall back to
 *      'awaiting_therapist_availability', which is wrong whenever the agent
 *      was actually waiting on the user.
 *
 * Inference order:
 *   a. `lastSuccessfulAction` — works when the prior action wasn't itself a
 *      closure-recommendation action.
 *   b. `checkpoint.context.lastEmailSentTo` — preserved across checkpoint
 *      updates (updateCheckpoint spreads context), so it reflects whoever the
 *      agent was last waiting on regardless of which closure path fired.
 *   c. `chaseSentTo` — only meaningful for the chase-recommended path.
 *   d. Final default — 'awaiting_therapist_availability'.
 *
 * Lives here rather than in the lifecycle service because it's purely
 * about checkpoint state and consumes types from conversation-checkpoint.
 */
export function inferRestoredStage(
  checkpoint: ConversationCheckpoint | null | undefined,
  chaseSentTo: string | null,
): ConversationStage {
  if (checkpoint?.lastSuccessfulAction) {
    const inferred = stageFromAction(checkpoint.lastSuccessfulAction);
    if (inferred !== 'closure_recommended' && inferred !== 'chased') {
      return inferred;
    }
  }

  const lastEmailTo = checkpoint?.context?.lastEmailSentTo;
  if (lastEmailTo === 'user') return 'awaiting_user_slot_selection';
  if (lastEmailTo === 'therapist') return 'awaiting_therapist_availability';

  if (chaseSentTo === 'user') return 'awaiting_user_slot_selection';
  if (chaseSentTo === 'therapist') return 'awaiting_therapist_availability';

  return 'awaiting_therapist_availability';
}
