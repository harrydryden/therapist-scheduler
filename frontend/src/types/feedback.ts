/**
 * FIX #39: Shared feedback form types used by both FeedbackFormPage and AdminFormsPage.
 * Previously these were duplicated in both files.
 */

export interface FormQuestion {
  id: string;
  type: 'text' | 'scale' | 'choice';
  question: string;
  required: boolean;
  prefilled?: boolean;
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  options?: string[];
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
