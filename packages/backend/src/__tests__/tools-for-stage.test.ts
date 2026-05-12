/**
 * Unit tests for getToolsForStage — the stage-gated tool surface from PR 4.
 *
 * The matrix is intentionally conservative: only excludes tools that are
 * unambiguously nonsensical at the given stage. These tests pin that
 * behaviour so a future stage rename or tool addition doesn't silently
 * widen the gate.
 *
 * The function is pure and operates on `{ name, … }` shapes, so this test
 * uses a synthetic tool list rather than importing the real schedulingTools
 * (which would drag in the loop's anthropic/prisma/settings module graph).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getToolsForStage } from '../services/tools-for-stage';
import type { ConversationStage } from '@therapist-scheduler/shared';

// Synthetic minimal tools mirroring the real names. Only `name` is read by
// the matrix; description and input_schema are required by the type.
const makeTool = (name: string): Anthropic.Tool => ({
  name,
  description: `${name} (test stub)`,
  input_schema: { type: 'object' as const, properties: {} },
});

const STUB_TOOLS: Anthropic.Tool[] = [
  'send_email',
  'update_therapist_availability',
  'mark_scheduling_complete',
  'cancel_appointment',
  'recommend_cancel_match',
  'issue_voucher_code',
  'initiate_reschedule',
  'flag_for_human_review',
  'remember',
  'record_booking_link',
  'record_availability_window',
].map(makeTool);

const namesOf = (tools: Anthropic.Tool[]): string[] => tools.map((t) => t.name).sort();
const ALL_NAMES = namesOf(STUB_TOOLS);

describe('getToolsForStage', () => {
  it('returns the full tool set when stage is undefined', () => {
    expect(namesOf(getToolsForStage(undefined, STUB_TOOLS))).toEqual(ALL_NAMES);
  });

  describe('pre-slot stages', () => {
    const preSlot: ConversationStage[] = [
      'initial_contact',
      'awaiting_therapist_availability',
      'awaiting_user_slot_selection',
    ];

    for (const stage of preSlot) {
      it(`hides mark_scheduling_complete and initiate_reschedule at ${stage}`, () => {
        const names = namesOf(getToolsForStage(stage, STUB_TOOLS));
        expect(names).not.toContain('mark_scheduling_complete');
        expect(names).not.toContain('initiate_reschedule');
        // Other tools still available.
        expect(names).toContain('send_email');
        expect(names).toContain('flag_for_human_review');
        expect(names).toContain('cancel_appointment');
      });
    }
  });

  describe('post-confirm stages', () => {
    const postConfirm: ConversationStage[] = ['confirmed', 'awaiting_meeting_link'];

    for (const stage of postConfirm) {
      it(`hides availability-collection tools at ${stage}`, () => {
        const names = namesOf(getToolsForStage(stage, STUB_TOOLS));
        expect(names).not.toContain('update_therapist_availability');
        expect(names).not.toContain('record_availability_window');
        expect(names).not.toContain('record_booking_link');
        // Critical recovery tools still available — agent must always be
        // able to cancel, reschedule, or escalate after confirmation.
        expect(names).toContain('cancel_appointment');
        expect(names).toContain('initiate_reschedule');
        expect(names).toContain('flag_for_human_review');
      });
    }
  });

  describe('stages where the right tool set is ambiguous', () => {
    // These keep the full surface on purpose: the agent might legitimately
    // need any tool to recover or progress.
    const ambiguous: ConversationStage[] = [
      'awaiting_therapist_confirmation',
      'rescheduling',
      'stalled',
      'chased',
      'closure_recommended',
      'cancelled',
    ];

    for (const stage of ambiguous) {
      it(`keeps the full tool surface at ${stage}`, () => {
        expect(namesOf(getToolsForStage(stage, STUB_TOOLS))).toEqual(ALL_NAMES);
      });
    }
  });

  it('preserves universal tools across every stage', () => {
    const universal = ['send_email', 'flag_for_human_review', 'remember', 'cancel_appointment'];
    const stages: ConversationStage[] = [
      'initial_contact',
      'awaiting_therapist_availability',
      'awaiting_user_slot_selection',
      'awaiting_therapist_confirmation',
      'awaiting_meeting_link',
      'confirmed',
      'rescheduling',
      'cancelled',
      'stalled',
      'chased',
      'closure_recommended',
    ];
    for (const stage of stages) {
      const names = namesOf(getToolsForStage(stage, STUB_TOOLS));
      for (const u of universal) {
        expect(names).toContain(u);
      }
    }
  });

  it('does not mutate the input array', () => {
    const before = STUB_TOOLS.slice();
    getToolsForStage('confirmed', STUB_TOOLS);
    expect(STUB_TOOLS).toEqual(before);
  });
});
