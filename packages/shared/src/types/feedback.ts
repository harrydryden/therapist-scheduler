/**
 * Shared feedback form types used by both FeedbackFormPage and AdminFormsPage.
 */

export interface FormQuestion {
  id: string;
  type: 'text' | 'scale' | 'choice' | 'choice_with_text';
  question: string;
  required: boolean;
  prefilled?: boolean;
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  options?: string[];
  followUpPlaceholder?: string;
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
}
