/**
 * Feedback Form Config Utility
 *
 * Centralizes the logic for fetching, creating, and auto-migrating
 * feedback form configuration. Used by:
 * - GET /api/feedback/form (public)
 * - GET /api/admin/forms/feedback (admin)
 * - GET /api/v1/ats/feedback/form (ATS)
 */

import { prisma } from './database';
import { logger } from './logger';

// Default questions used when creating or migrating the form config
export const DEFAULT_QUESTIONS = [
  {
    id: 'met_goals',
    type: 'choice',
    question: 'Did this session meet your goals?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'therapist_asked_goals',
    type: 'choice',
    question: 'Did the therapist ask what your goals were?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
    conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] },
  },
  {
    id: 'goals_detail',
    type: 'text',
    question: 'Which goals, if any, were met, which goals, if any, were not met?',
    required: true,
    conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] },
  },
  {
    id: 'felt_heard',
    type: 'choice',
    question: 'Did you feel heard and understood?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'felt_heard_detail',
    type: 'text',
    question: 'Please tell us more about why you felt that way (eg anything your therapist said, did, non verbal cues, etc).',
    required: true,
    conditionalOn: { questionId: 'felt_heard', values: ['No', 'Unsure'] },
  },
  {
    id: 'would_book_again',
    type: 'choice',
    question: 'Would you book another session with this therapist in the future?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'would_book_again_detail',
    type: 'text',
    question: 'Please tell us why you felt that way.',
    required: true,
    conditionalOn: { questionId: 'would_book_again', values: ['No', 'Unsure'] },
  },
  {
    id: 'would_recommend',
    type: 'choice',
    question: 'Based on this session, would you recommend this therapist to a close friend?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'would_recommend_detail',
    type: 'text',
    question: 'Tell us why you would be hesitant to recommend this therapist to a close friend.',
    required: true,
    conditionalOn: { questionId: 'would_recommend', values: ['No', 'Unsure'] },
  },
];

const DEFAULT_CONFIG = {
  id: 'default',
  formName: 'Therapy Session Feedback',
  welcomeTitle: 'Session Feedback',
  welcomeMessage: 'Please take a moment to share your feedback about your therapy session.',
  thankYouTitle: 'Thank you!',
  thankYouMessage: 'Thanks for sharing your feedback - we really appreciate it.',
  questions: DEFAULT_QUESTIONS,
  isActive: true,
  requiresAuth: true,
};

/**
 * Fetch the feedback form config, creating it with defaults if it doesn't exist,
 * and auto-migrating to v2 questions if still on the old question set.
 *
 * Returns null only if the config doesn't exist AND createIfMissing is false.
 */
export async function getOrCreateFeedbackFormConfig(
  options: { createIfMissing?: boolean } = {}
) {
  const { createIfMissing = true } = options;

  let config = await prisma.feedbackFormConfig.findUnique({
    where: { id: 'default' },
  });

  // Create with defaults if missing
  if (!config) {
    if (!createIfMissing) return null;
    config = await prisma.feedbackFormConfig.create({ data: DEFAULT_CONFIG });
    logger.info('Created feedback form config with default questions');
  }

  // Auto-migrate to v2 questions if needed
  const questions = config.questions as unknown[];
  const questionIds = Array.isArray(questions)
    ? (questions as Array<{ id?: string }>).map(q => q.id)
    : [];
  const hasNewQuestions = questionIds.includes('met_goals');
  const needsMigration = !questions || !Array.isArray(questions) || questions.length === 0 || !hasNewQuestions;

  if (needsMigration) {
    config = await prisma.feedbackFormConfig.update({
      where: { id: 'default' },
      data: {
        questions: DEFAULT_QUESTIONS,
        requiresAuth: true,
        questionsVersion: 2,
      },
    });
    logger.info('Migrated feedback form config to v2 questions');
  }

  return config;
}
