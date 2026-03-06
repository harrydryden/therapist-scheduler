/**
 * Shared feedback form types used by both FeedbackFormPage and AdminFormsPage.
 */

export interface FormQuestion {
  id: string;
  type: 'text' | 'scale' | 'choice' | 'choice_with_text';
  question: string;
  helperText?: string;
  required: boolean;
  prefilled?: boolean;
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  options?: string[];
  followUpPlaceholder?: string;
  /** If set, this question is only shown when the parent question's answer matches one of the trigger values (case-insensitive). */
  conditionalOn?: {
    questionId: string;
    values: string[];
  };
}

export interface FormConfig {
  formName: string;
  description: string | null;
  welcomeTitle: string;
  welcomeMessage: string;
  thankYouTitle: string;
  thankYouMessage: string;
  questions: FormQuestion[];
  isActive: boolean;
  /** Which choice answers require an explanation (e.g. ["No", "Unsure"]). Compared case-insensitively. */
  requireExplanationFor: string[];
}
