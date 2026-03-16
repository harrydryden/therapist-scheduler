/**
 * Tests for feedback form validation logic
 *
 * Covers:
 * - requiresExplanation: which choice answers need explanation text
 * - Server-side enforcement of requireExplanationFor config
 * - Conditional question validation (conditionalOn)
 * - Edge cases: case-insensitivity, empty arrays, back-and-forth answers
 */

import { requiresExplanation, validateResponses } from '@therapist-scheduler/shared/utils/form-utils';
import type { FormQuestion } from '@therapist-scheduler/shared/types/feedback';

/** Minimal subset of FormQuestion used by test fixtures — compatible with FormQuestion */
type TestQuestion = Pick<FormQuestion, 'id' | 'type' | 'question' | 'required' | 'conditionalOn'> & Partial<FormQuestion>;

// ============================================
// Tests
// ============================================

describe('requiresExplanation', () => {
  const defaultConfig = ['No', 'Unsure'];

  it('returns true for "No" (case-insensitive)', () => {
    expect(requiresExplanation('No', defaultConfig)).toBe(true);
    expect(requiresExplanation('no', defaultConfig)).toBe(true);
    expect(requiresExplanation('NO', defaultConfig)).toBe(true);
  });

  it('returns true for "Unsure" (case-insensitive)', () => {
    expect(requiresExplanation('Unsure', defaultConfig)).toBe(true);
    expect(requiresExplanation('unsure', defaultConfig)).toBe(true);
    expect(requiresExplanation('UNSURE', defaultConfig)).toBe(true);
  });

  it('returns false for "Yes"', () => {
    expect(requiresExplanation('Yes', defaultConfig)).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(requiresExplanation(null, defaultConfig)).toBe(false);
    expect(requiresExplanation(undefined, defaultConfig)).toBe(false);
    expect(requiresExplanation('', defaultConfig)).toBe(false);
  });

  it('respects custom config with "Yes" included', () => {
    const allRequired = ['Yes', 'No', 'Unsure'];
    expect(requiresExplanation('Yes', allRequired)).toBe(true);
    expect(requiresExplanation('No', allRequired)).toBe(true);
  });

  it('respects config with only "No"', () => {
    const noOnly = ['No'];
    expect(requiresExplanation('No', noOnly)).toBe(true);
    expect(requiresExplanation('Unsure', noOnly)).toBe(false);
    expect(requiresExplanation('Yes', noOnly)).toBe(false);
  });

  it('handles empty config (no answers require explanation)', () => {
    expect(requiresExplanation('No', [])).toBe(false);
    expect(requiresExplanation('Unsure', [])).toBe(false);
    expect(requiresExplanation('Yes', [])).toBe(false);
  });

  it('handles custom option names', () => {
    const custom = ['Not really', 'Somewhat'];
    expect(requiresExplanation('Not really', custom)).toBe(true);
    expect(requiresExplanation('Somewhat', custom)).toBe(true);
    expect(requiresExplanation('Definitely', custom)).toBe(false);
  });
});

describe('validateResponses (server-side submission validation)', () => {
  const questions: TestQuestion[] = [
    { id: 'comfortable', type: 'choice_with_text', question: 'Did you feel comfortable?', required: true },
    { id: 'heard', type: 'choice_with_text', question: 'Did you feel heard?', required: true },
    { id: 'takeaways', type: 'text', question: 'Key takeaways', required: false },
  ];
  const defaultConfig = ['No', 'Unsure'];

  it('passes when "Yes" is selected (no explanation needed)', () => {
    const responses = { comfortable: 'Yes', heard: 'Yes' };
    expect(validateResponses(responses, questions, defaultConfig)).toBeNull();
  });

  it('passes when "No" is selected with explanation text', () => {
    const responses = {
      comfortable: 'No',
      comfortable_text: 'The therapist was late.',
      heard: 'Yes',
    };
    expect(validateResponses(responses, questions, defaultConfig)).toBeNull();
  });

  it('fails when "No" is selected without explanation text', () => {
    const responses = { comfortable: 'No', comfortable_text: 'reason', heard: 'Yes' };
    // This should pass now since we provide text
    expect(validateResponses(responses, questions, defaultConfig)).toBeNull();

    // Without text it should fail
    const responses2 = { comfortable: 'No', heard: 'Yes' };
    const error = validateResponses(responses2, questions, defaultConfig);
    expect(error).toContain('comfortable');
    expect(error).toContain('No');
  });

  it('fails when "Unsure" is selected without explanation text', () => {
    const responses = { comfortable: 'Yes', heard: 'Unsure' };
    const error = validateResponses(responses, questions, defaultConfig);
    expect(error).toContain('heard');
    expect(error).toContain('Unsure');
  });

  it('fails when explanation text is whitespace-only', () => {
    const responses = {
      comfortable: 'No',
      comfortable_text: '   ',
      heard: 'Yes',
    };
    expect(validateResponses(responses, questions, defaultConfig)).not.toBeNull();
  });

  it('skips non-choice_with_text questions without required flag', () => {
    const responses = { comfortable: 'Yes', heard: 'Yes', takeaways: '' as string | number };
    expect(validateResponses(responses, questions, defaultConfig)).toBeNull();
  });

  it('skips questions without a response when not required', () => {
    // Only provide required fields
    const responses = { comfortable: 'Yes', heard: 'Yes' };
    expect(validateResponses(responses, questions, defaultConfig)).toBeNull();
  });

  describe('back-and-forth answer changes', () => {
    it('validates final state, not history: "No" with text passes', () => {
      const responses = {
        comfortable: 'No',
        comfortable_text: 'Changed my mind but still no.',
        heard: 'Yes',
      };
      expect(validateResponses(responses, questions, defaultConfig)).toBeNull();
    });

    it('validates final state: "Yes" with stale text from prior "No" passes', () => {
      const responses = {
        comfortable: 'Yes',
        comfortable_text: 'This was from when I said No',
        heard: 'Yes',
      };
      expect(validateResponses(responses, questions, defaultConfig)).toBeNull();
    });

    it('validates final state: "No" with cleared text fails', () => {
      const responses = {
        comfortable: 'No',
        comfortable_text: '',
        heard: 'Yes',
      };
      expect(validateResponses(responses, questions, defaultConfig)).not.toBeNull();
    });
  });

  describe('custom requireExplanationFor config', () => {
    it('requires explanation for "Yes" when configured', () => {
      const allRequired = ['Yes', 'No', 'Unsure'];
      const responses = { comfortable: 'Yes', heard: 'Yes' };
      expect(validateResponses(responses, questions, allRequired)).not.toBeNull();
    });

    it('does not require explanation for "Unsure" when removed from config', () => {
      const noOnly = ['No'];
      const responses = { comfortable: 'Unsure', heard: 'Yes' };
      expect(validateResponses(responses, questions, noOnly)).toBeNull();
    });

    it('allows all answers without explanation when config is empty', () => {
      const responses = { comfortable: 'No', heard: 'Unsure' };
      expect(validateResponses(responses, questions, [])).toBeNull();
    });
  });
});

describe('conditional question validation', () => {
  const questions: TestQuestion[] = [
    { id: 'met_goals', type: 'choice', question: 'Did this session meet your goals?', required: true },
    {
      id: 'goals_detail',
      type: 'text',
      question: 'Which goals were met/not met?',
      required: true,
      conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] },
    },
    { id: 'felt_heard', type: 'choice', question: 'Did you feel heard?', required: true },
    {
      id: 'felt_heard_detail',
      type: 'text',
      question: 'Tell us more about why.',
      required: true,
      conditionalOn: { questionId: 'felt_heard', values: ['No', 'Unsure'] },
    },
  ];

  it('skips conditional sub-questions when parent answer is "Yes"', () => {
    const responses = { met_goals: 'Yes', felt_heard: 'Yes' };
    expect(validateResponses(responses, questions, [])).toBeNull();
  });

  it('requires conditional sub-questions when parent answer is "No"', () => {
    const responses = { met_goals: 'No', felt_heard: 'Yes' };
    const error = validateResponses(responses, questions, []);
    expect(error).toContain('goals');
  });

  it('requires conditional sub-questions when parent answer is "Unsure"', () => {
    const responses = { met_goals: 'Unsure', felt_heard: 'Yes' };
    const error = validateResponses(responses, questions, []);
    expect(error).toContain('goals');
  });

  it('passes when conditional sub-questions are answered', () => {
    const responses = {
      met_goals: 'No',
      goals_detail: 'None of my goals were met.',
      felt_heard: 'Unsure',
      felt_heard_detail: 'I felt like they weren\'t listening.',
    };
    expect(validateResponses(responses, questions, [])).toBeNull();
  });

  it('handles case-insensitive matching for trigger values', () => {
    const responses = { met_goals: 'no', felt_heard: 'yes' };
    const error = validateResponses(responses, questions, []);
    // "no" should trigger the conditional, and goals_detail is missing
    expect(error).toContain('goals');
  });

  it('skips conditional sub-questions when parent has no response', () => {
    // Parent question not answered - sub-question condition is not met
    const responses = { felt_heard: 'Yes' } as Record<string, string | number>;
    // met_goals is required and missing
    const error = validateResponses(responses, questions, []);
    expect(error).toContain('goals?');
  });

  it('handles mixed: some parents trigger, some do not', () => {
    const responses = {
      met_goals: 'Yes',        // No sub-questions triggered
      felt_heard: 'No',         // Sub-question triggered but not answered
    };
    const error = validateResponses(responses, questions, []);
    expect(error).toContain('Tell us more');
  });

  it('passes full new question set (happy path - all Yes)', () => {
    const fullQuestions: TestQuestion[] = [
      { id: 'met_goals', type: 'choice', question: 'Did this session meet your goals?', required: true },
      { id: 'therapist_asked_goals', type: 'choice', question: 'Did the therapist ask what your goals were?', required: true, conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] } },
      { id: 'goals_detail', type: 'text', question: 'Which goals were met/not met?', required: true, conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] } },
      { id: 'felt_heard', type: 'choice', question: 'Did you feel heard?', required: true },
      { id: 'felt_heard_detail', type: 'text', question: 'Tell us more.', required: true, conditionalOn: { questionId: 'felt_heard', values: ['No', 'Unsure'] } },
      { id: 'would_book_again', type: 'choice', question: 'Would you book again?', required: true },
      { id: 'would_book_again_detail', type: 'text', question: 'Why?', required: true, conditionalOn: { questionId: 'would_book_again', values: ['No', 'Unsure'] } },
      { id: 'would_recommend', type: 'choice', question: 'Would you recommend?', required: true },
      { id: 'would_recommend_detail', type: 'text', question: 'Why hesitant?', required: true, conditionalOn: { questionId: 'would_recommend', values: ['No', 'Unsure'] } },
    ];

    // All "Yes" - only 4 questions need answers
    const responses = {
      met_goals: 'Yes',
      felt_heard: 'Yes',
      would_book_again: 'Yes',
      would_recommend: 'Yes',
    };
    expect(validateResponses(responses, fullQuestions, [])).toBeNull();
  });

  it('passes full new question set (all No with details)', () => {
    const fullQuestions: TestQuestion[] = [
      { id: 'met_goals', type: 'choice', question: 'Did this session meet your goals?', required: true },
      { id: 'therapist_asked_goals', type: 'choice', question: 'Did the therapist ask what your goals were?', required: true, conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] } },
      { id: 'goals_detail', type: 'text', question: 'Which goals were met/not met?', required: true, conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] } },
      { id: 'felt_heard', type: 'choice', question: 'Did you feel heard?', required: true },
      { id: 'felt_heard_detail', type: 'text', question: 'Tell us more.', required: true, conditionalOn: { questionId: 'felt_heard', values: ['No', 'Unsure'] } },
      { id: 'would_book_again', type: 'choice', question: 'Would you book again?', required: true },
      { id: 'would_book_again_detail', type: 'text', question: 'Why?', required: true, conditionalOn: { questionId: 'would_book_again', values: ['No', 'Unsure'] } },
      { id: 'would_recommend', type: 'choice', question: 'Would you recommend?', required: true },
      { id: 'would_recommend_detail', type: 'text', question: 'Why hesitant?', required: true, conditionalOn: { questionId: 'would_recommend', values: ['No', 'Unsure'] } },
    ];

    const responses = {
      met_goals: 'No',
      therapist_asked_goals: 'No',
      goals_detail: 'None of my goals were met.',
      felt_heard: 'No',
      felt_heard_detail: 'Therapist was distracted.',
      would_book_again: 'No',
      would_book_again_detail: 'Not a good fit.',
      would_recommend: 'No',
      would_recommend_detail: 'Would not recommend.',
    };
    expect(validateResponses(responses, fullQuestions, [])).toBeNull();
  });
});
