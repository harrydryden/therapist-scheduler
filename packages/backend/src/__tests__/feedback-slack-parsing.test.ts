/**
 * Tests for feedback form → Slack notification parsing logic
 *
 * Validates that the 4-question form with conditional sub-questions
 * produces correct, coherent Slack notification data:
 *  - Conditional questions whose parent condition is NOT met are excluded
 *  - Text sub-questions merge inline with their parent answer
 *  - Choice sub-questions render with ↳ prefix for hierarchy
 *  - Truncation limits are respected
 */

interface TestFormQuestion {
  id: string;
  type: 'text' | 'scale' | 'choice' | 'choice_with_text';
  question: string;
  required: boolean;
  options?: string[];
  scaleMax?: number;
  conditionalOn?: { questionId: string; values: string[] };
}

/**
 * Pure extraction of the feedback-to-Slack parsing logic from
 * feedback-form.routes.ts so it can be unit-tested without DB/HTTP.
 */
function buildFeedbackDataForSlack(
  formQuestions: TestFormQuestion[],
  responses: Record<string, string | number>
): Record<string, string> {
  const LABEL_MAX = 50;
  const CHOICE_TEXT_MAX = 80;
  const FREE_TEXT_MAX = 100;

  const isConditionMet = (q: TestFormQuestion): boolean => {
    if (!q.conditionalOn) return true;
    const parentVal = responses[q.conditionalOn.questionId];
    if (typeof parentVal !== 'string') return false;
    return q.conditionalOn.values.some(
      (v) => v.toLowerCase() === parentVal.toLowerCase()
    );
  };

  const questionById = new Map(formQuestions.map(q => [q.id, q]));
  const mergedTextChildren = new Set<string>();

  // First pass: identify conditional text sub-questions that merge with parent
  for (const q of formQuestions) {
    if (
      q.type === 'text' &&
      q.conditionalOn &&
      isConditionMet(q) &&
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
    if (!isConditionMet(q)) continue;
    if (mergedTextChildren.has(q.id)) continue;

    const isSubQuestion = !!q.conditionalOn;
    const rawLabel = q.question.length > LABEL_MAX ? q.question.slice(0, LABEL_MAX - 3) + '...' : q.question;
    const label = isSubQuestion ? `↳ ${rawLabel}` : rawLabel;

    if (q.type === 'scale') {
      feedbackData[label] = `${val}/${q.scaleMax ?? 5}`;
    } else if (q.type === 'choice' || q.type === 'choice_with_text') {
      let answer = String(val);

      const textVal = responses[`${q.id}_text`];
      if (textVal && typeof textVal === 'string' && textVal.trim()) {
        const truncated = textVal.length > CHOICE_TEXT_MAX ? textVal.slice(0, CHOICE_TEXT_MAX - 3) + '...' : textVal;
        answer += ` — "${truncated}"`;
      }

      if (!isSubQuestion) {
        for (const child of formQuestions) {
          if (mergedTextChildren.has(child.id) && child.conditionalOn?.questionId === q.id) {
            const childVal = String(responses[child.id]);
            const truncated = childVal.length > CHOICE_TEXT_MAX ? childVal.slice(0, CHOICE_TEXT_MAX - 3) + '...' : childVal;
            answer += ` — "${truncated}"`;
            break;
          }
        }
      }

      feedbackData[label] = answer;
    } else if (q.type === 'text') {
      const strVal = String(val);
      feedbackData[label] = strVal.length > FREE_TEXT_MAX ? strVal.slice(0, FREE_TEXT_MAX - 3) + '...' : strVal;
    }
  }

  return feedbackData;
}

// Default questions matching admin-forms.routes.ts
const DEFAULT_QUESTIONS: TestFormQuestion[] = [
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
    conditionalOn: undefined,
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

describe('buildFeedbackDataForSlack', () => {
  it('includes all 4 main questions when answered positively (no sub-questions triggered)', () => {
    const responses = {
      met_goals: 'Yes',
      felt_heard: 'Yes',
      would_book_again: 'Yes',
      would_recommend: 'Yes',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    expect(Object.keys(result)).toHaveLength(4);
    expect(result['Did this session meet your goals?']).toBe('Yes');
    expect(result['Did you feel heard and understood?']).toBe('Yes');
    expect(result['Would you book another session with this therapist in the future?']).toBeUndefined();
    // This question exceeds LABEL_MAX (50 chars), so it's truncated
    const bookAgainKey = Object.keys(result).find(k => k.startsWith('Would you book another'));
    expect(bookAgainKey).toBeDefined();
    expect(result[bookAgainKey!]).toBe('Yes');
  });

  it('filters out conditional sub-questions when parent condition is not met', () => {
    const responses = {
      met_goals: 'Yes',
      // These should NOT appear - parent said "Yes" but condition requires "No" or "Unsure"
      therapist_asked_goals: 'No',
      goals_detail: 'Some detail that should be filtered',
      felt_heard: 'Yes',
      would_book_again: 'Yes',
      would_recommend: 'Yes',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    // Should only have the 4 main questions
    expect(Object.keys(result)).toHaveLength(4);
    // Should NOT contain the conditional sub-question answers
    const allValues = Object.values(result).join(' ');
    expect(allValues).not.toContain('Some detail that should be filtered');
    // No keys should start with ↳
    expect(Object.keys(result).some(k => k.startsWith('↳'))).toBe(false);
  });

  it('merges text sub-question inline with parent when condition is met', () => {
    const responses = {
      met_goals: 'No',
      therapist_asked_goals: 'Yes',
      goals_detail: 'Anxiety goals were not addressed',
      felt_heard: 'Yes',
      would_book_again: 'Yes',
      would_recommend: 'Yes',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    // met_goals should have the goals_detail merged inline
    expect(result['Did this session meet your goals?']).toBe(
      'No — "Anxiety goals were not addressed"'
    );

    // therapist_asked_goals should have ↳ prefix as a choice sub-question
    const subKey = Object.keys(result).find(k => k.startsWith('↳'));
    expect(subKey).toBeDefined();
    expect(result[subKey!]).toBe('Yes');

    // goals_detail should NOT appear as a separate entry (it was merged)
    const detailKey = Object.keys(result).find(k =>
      k.includes('Which goals') && !k.startsWith('↳')
    );
    expect(detailKey).toBeUndefined();
  });

  it('renders choice sub-questions with ↳ prefix', () => {
    const responses = {
      met_goals: 'Unsure',
      therapist_asked_goals: 'No',
      goals_detail: 'I am not sure what we accomplished',
      felt_heard: 'Yes',
      would_book_again: 'Yes',
      would_recommend: 'Yes',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    // therapist_asked_goals is a choice sub-question → gets ↳ prefix
    const subKeys = Object.keys(result).filter(k => k.startsWith('↳'));
    expect(subKeys).toHaveLength(1);
    expect(subKeys[0]).toContain('Did the therapist ask');
    expect(result[subKeys[0]]).toBe('No');
  });

  it('handles multiple sub-questions triggered across different parents', () => {
    const responses = {
      met_goals: 'No',
      therapist_asked_goals: 'No',
      goals_detail: 'Goals not met',
      felt_heard: 'No',
      felt_heard_detail: 'Therapist seemed distracted',
      would_book_again: 'Unsure',
      would_book_again_detail: 'Need to think about it',
      would_recommend: 'No',
      would_recommend_detail: 'Not a good fit',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    // 4 main questions + 1 choice sub-question (therapist_asked_goals)
    // Text sub-questions are merged, not separate entries
    expect(Object.keys(result)).toHaveLength(5);

    // Check merges
    expect(result['Did this session meet your goals?']).toContain('No — "Goals not met"');
    expect(result['Did you feel heard and understood?']).toContain('No — "Therapist seemed distracted"');
  });

  it('truncates long free-text answers at FREE_TEXT_MAX (100 chars)', () => {
    // Use a standalone text question (not conditional) to test truncation
    const questions: TestFormQuestion[] = [
      { id: 'q1', type: 'text', question: 'Tell us more', required: true },
    ];
    const longText = 'A'.repeat(150);
    const responses = { q1: longText };

    const result = buildFeedbackDataForSlack(questions, responses);

    expect(result['Tell us more']).toBe('A'.repeat(97) + '...');
    expect(result['Tell us more'].length).toBe(100);
  });

  it('truncates merged sub-question text at CHOICE_TEXT_MAX (80 chars)', () => {
    const longDetail = 'B'.repeat(120);
    const responses = {
      met_goals: 'No',
      goals_detail: longDetail,
      felt_heard: 'Yes',
      would_book_again: 'Yes',
      would_recommend: 'Yes',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    // The merged text should be truncated to 80 chars
    const metGoalsVal = result['Did this session meet your goals?'];
    expect(metGoalsVal).toContain('No — "');
    // 'No — "' (6) + 77 B's + '...' (3) + '"' (1) = 87 total
    const quotedPart = metGoalsVal.split(' — "')[1].replace(/"$/, '');
    expect(quotedPart.length).toBe(80); // 77 + '...'
  });

  it('truncates long question labels at LABEL_MAX (50 chars)', () => {
    const longQuestion = 'A'.repeat(60) + '?';
    const questions: TestFormQuestion[] = [
      { id: 'q1', type: 'choice', question: longQuestion, required: true, options: ['Yes', 'No'] },
    ];

    const result = buildFeedbackDataForSlack(questions, { q1: 'Yes' });

    const key = Object.keys(result)[0];
    expect(key.length).toBe(50); // truncated to 47 + '...'
    expect(key.endsWith('...')).toBe(true);
  });

  it('handles case-insensitive conditional matching', () => {
    const responses = {
      met_goals: 'no', // lowercase
      goals_detail: 'Not met',
      felt_heard: 'yes',
      would_book_again: 'UNSURE', // uppercase
      would_book_again_detail: 'Need time',
      would_recommend: 'yes',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    // met_goals "no" should still trigger goals_detail merge
    expect(result['Did this session meet your goals?']).toContain('no — "Not met"');

    // would_book_again "UNSURE" should trigger detail merge
    const bookKey = Object.keys(result).find(k => k.startsWith('Would you book'));
    expect(result[bookKey!]).toContain('UNSURE — "Need time"');
  });

  it('handles empty responses gracefully', () => {
    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, {});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('handles scale question type', () => {
    const questions: TestFormQuestion[] = [
      { id: 'q1', type: 'scale', question: 'Rate satisfaction', required: true, scaleMax: 10 },
    ];

    const result = buildFeedbackDataForSlack(questions, { q1: 8 });

    expect(result['Rate satisfaction']).toBe('8/10');
  });

  it('handles choice_with_text question type with inline explanation', () => {
    const questions: TestFormQuestion[] = [
      { id: 'q1', type: 'choice_with_text', question: 'Would you return?', required: true, options: ['Yes', 'No'] },
    ];

    const result = buildFeedbackDataForSlack(questions, {
      q1: 'No',
      q1_text: 'The location was too far',
    });

    expect(result['Would you return?']).toBe('No — "The location was too far"');
  });

  it('produces the correct output for a complete worst-case form submission', () => {
    // All 4 main questions negative → all sub-questions triggered
    const responses = {
      met_goals: 'No',
      therapist_asked_goals: 'No',
      goals_detail: 'None of my goals were addressed during the session',
      felt_heard: 'No',
      felt_heard_detail: 'The therapist kept checking their phone',
      would_book_again: 'No',
      would_book_again_detail: 'I did not feel comfortable with the approach',
      would_recommend: 'No',
      would_recommend_detail: 'The session felt rushed and impersonal',
    };

    const result = buildFeedbackDataForSlack(DEFAULT_QUESTIONS, responses);

    // Verify structure: 4 main + 1 choice sub (therapist_asked_goals)
    // 4 text subs merged inline with parents
    const keys = Object.keys(result);
    expect(keys).toHaveLength(5);

    // Main questions have merged detail text
    expect(result['Did this session meet your goals?']).toBe(
      'No — "None of my goals were addressed during the session"'
    );
    expect(result['Did you feel heard and understood?']).toBe(
      'No — "The therapist kept checking their phone"'
    );

    // Choice sub-question has ↳ prefix
    const arrowKeys = keys.filter(k => k.startsWith('↳'));
    expect(arrowKeys).toHaveLength(1);
    expect(arrowKeys[0]).toContain('therapist ask');
    expect(result[arrowKeys[0]]).toBe('No');
  });
});
