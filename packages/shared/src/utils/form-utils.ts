/**
 * Shared feedback form utilities.
 *
 * These pure functions encapsulate the conditional-question, validation, and
 * Slack-formatting logic used by both frontend and backend.  Centralising
 * them here eliminates the 6× duplication that previously existed across
 * FeedbackFormPage, AdminFormsPage, feedback-form.routes, and two test files.
 */

import type { FormQuestion } from '../types/feedback';

// ============================================
// Slack formatting constants
// ============================================

export const SLACK_LABEL_MAX = 50;
export const SLACK_CHOICE_TEXT_MAX = 80;
export const SLACK_FREE_TEXT_MAX = 100;

// ============================================
// Conditional question evaluation
// ============================================

/**
 * Check whether a conditional question's parent condition is met.
 * Unconditional questions always return true.
 */
export function isConditionMet(
  question: Pick<FormQuestion, 'conditionalOn'>,
  responses: Record<string, string | number>,
): boolean {
  if (!question.conditionalOn) return true;
  const parentVal = responses[question.conditionalOn.questionId];
  if (typeof parentVal !== 'string') return false;
  return question.conditionalOn.values.some(
    (v) => v.toLowerCase() === parentVal.toLowerCase(),
  );
}

/**
 * Filter a question list down to only those whose conditions are currently met.
 */
export function getVisibleQuestions<T extends Pick<FormQuestion, 'conditionalOn'>>(
  questions: T[],
  responses: Record<string, string | number>,
): T[] {
  return questions.filter((q) => isConditionMet(q, responses));
}

// ============================================
// Explanation requirement check
// ============================================

/**
 * Does the chosen answer require an explanation?
 * Comparison is case-insensitive.
 */
export function requiresExplanation(
  value: string | null | undefined,
  requireExplanationFor: string[],
): boolean {
  if (!value || typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return requireExplanationFor.some((opt) => opt.toLowerCase() === lower);
}

// ============================================
// Response validation
// ============================================

/**
 * Validate submitted responses against a question set.
 *
 * Returns an error message string if validation fails, or null if valid.
 * This is the single source of truth for the validation logic used by both
 * the frontend (pre-submit) and backend (server-side enforcement).
 */
export function validateResponses(
  responses: Record<string, string | number>,
  questions: FormQuestion[],
  requireExplanationFor: string[],
): string | null {
  for (const q of questions) {
    if (!isConditionMet(q, responses)) continue;

    // Required fields must have a non-empty response
    if (q.required) {
      const val = responses[q.id];
      if (val === undefined || val === null || (typeof val === 'string' && !val.trim())) {
        return `Please answer "${q.question}"`;
      }
    }

    // For choice_with_text, enforce explanation text for configured answers
    if (q.type === 'choice_with_text') {
      const choiceVal = responses[q.id];
      if (typeof choiceVal !== 'string') continue;
      if (requiresExplanation(choiceVal, requireExplanationFor)) {
        const textVal = responses[`${q.id}_text`];
        if (!textVal || (typeof textVal === 'string' && !textVal.trim())) {
          return `Please provide an explanation for "${q.question}" when answering "${choiceVal}"`;
        }
      }
    }
  }
  return null;
}

// ============================================
// Slack feedback data builder
// ============================================

/**
 * Build a compact key-value representation of feedback responses for Slack.
 *
 * Handles:
 * - Conditional sub-questions: excluded when parent condition is not met
 * - Text sub-questions: merged inline with parent answer as `No — "detail"`
 * - Choice sub-questions: prefixed with ↳ for visual hierarchy
 * - Truncation: labels at 50 chars, choice text at 80, free text at 100
 */
export function buildFeedbackDataForSlack(
  formQuestions: FormQuestion[],
  responses: Record<string, string | number>,
): Record<string, string> {
  // Build a lookup of question IDs for parent-child merging
  const questionById = new Map(formQuestions.map((q) => [q.id, q]));

  // Track which text sub-questions should be merged into their parent
  const mergedTextChildren = new Set<string>();

  // First pass: identify conditional text sub-questions that merge with parent
  for (const q of formQuestions) {
    if (
      q.type === 'text' &&
      q.conditionalOn &&
      isConditionMet(q, responses) &&
      responses[q.id] != null &&
      responses[q.id] !== ''
    ) {
      const parent = questionById.get(q.conditionalOn.questionId);
      if (parent && (parent.type === 'choice' || parent.type === 'choice_with_text')) {
        mergedTextChildren.add(q.id);
      }
    }
  }

  const feedbackData: Record<string, string> = {};

  for (const q of formQuestions) {
    const val = responses[q.id];
    if (val == null || val === '') continue;
    if (!isConditionMet(q, responses)) continue;
    if (mergedTextChildren.has(q.id)) continue;

    const isSub = !!q.conditionalOn;
    const rawLabel =
      q.question.length > SLACK_LABEL_MAX
        ? q.question.slice(0, SLACK_LABEL_MAX - 3) + '...'
        : q.question;
    const label = isSub ? `↳ ${rawLabel}` : rawLabel;

    if (q.type === 'scale') {
      feedbackData[label] = `${val}/${q.scaleMax ?? 5}`;
    } else if (q.type === 'choice' || q.type === 'choice_with_text') {
      let answer = String(val);

      // Merge inline choice_with_text explanations
      const textVal = responses[`${q.id}_text`];
      if (textVal && typeof textVal === 'string' && textVal.trim()) {
        const t =
          textVal.length > SLACK_CHOICE_TEXT_MAX
            ? textVal.slice(0, SLACK_CHOICE_TEXT_MAX - 3) + '...'
            : textVal;
        answer += ` — "${t}"`;
      }

      // Merge conditional text sub-question answers inline with parent
      if (!isSub) {
        for (const child of formQuestions) {
          if (mergedTextChildren.has(child.id) && child.conditionalOn?.questionId === q.id) {
            const childVal = String(responses[child.id]);
            const t =
              childVal.length > SLACK_CHOICE_TEXT_MAX
                ? childVal.slice(0, SLACK_CHOICE_TEXT_MAX - 3) + '...'
                : childVal;
            answer += ` — "${t}"`;
            break; // Only merge the first text child to keep compact
          }
        }
      }

      feedbackData[label] = answer;
    } else if (q.type === 'text') {
      const strVal = String(val);
      feedbackData[label] =
        strVal.length > SLACK_FREE_TEXT_MAX
          ? strVal.slice(0, SLACK_FREE_TEXT_MAX - 3) + '...'
          : strVal;
    }
  }

  return feedbackData;
}

// ============================================
// Type-safe Prisma JSON → FormQuestion[] parser
// ============================================

/**
 * Safely parse a Prisma JsonValue into a FormQuestion array.
 * Returns an empty array if the value is not an array.
 */
export function parseFormQuestions(raw: unknown): FormQuestion[] {
  return Array.isArray(raw) ? (raw as FormQuestion[]) : [];
}
