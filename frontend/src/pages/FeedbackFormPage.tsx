import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { API_BASE } from '../config/env';

// ============================================
// Types
// ============================================

interface FormQuestion {
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

interface FormConfig {
  formName: string;
  description: string | null;
  welcomeTitle: string;
  welcomeMessage: string;
  thankYouTitle: string;
  thankYouMessage: string;
  questions: FormQuestion[];
  isActive: boolean;
}

interface PrefilledData {
  trackingCode: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  appointmentId: string;
}

interface FeedbackFormResponse {
  form: FormConfig;
  prefilled: PrefilledData | null;
  warning?: string;
}

// ============================================
// API Functions (public, no auth)
// ============================================

async function getFeedbackForm(splCode?: string): Promise<FeedbackFormResponse> {
  const endpoint = splCode
    ? `${API_BASE}/api/feedback/form/${splCode}`
    : `${API_BASE}/api/feedback/form`;

  const response = await fetch(endpoint);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load feedback form');
  }

  return data;
}

async function submitFeedback(data: {
  trackingCode?: string;
  therapistName: string;
  responses: Record<string, string | number>;
}): Promise<{ success: boolean; submissionId: string; message: string }> {
  const response = await fetch(`${API_BASE}/api/feedback/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || result.message || 'Failed to submit feedback');
  }

  return result;
}

// ============================================
// Components
// ============================================

function ScaleQuestion({
  question,
  value,
  onChange,
}: {
  question: FormQuestion;
  value: number | null;
  onChange: (value: number) => void;
}) {
  const min = question.scaleMin ?? 0;
  const max = question.scaleMax ?? 5;
  const range = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <div className="space-y-3">
      <div className="flex justify-between text-sm text-gray-500">
        <span>{question.scaleMinLabel || min}</span>
        <span>{question.scaleMaxLabel || max}</span>
      </div>
      <div className="flex justify-between gap-2">
        {range.map((num) => (
          <button
            key={num}
            type="button"
            onClick={() => onChange(num)}
            className={`
              flex-1 py-3 rounded-lg font-medium transition-all
              ${value === num
                ? 'bg-primary-600 text-white shadow-md scale-105'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }
            `}
          >
            {num}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChoiceQuestion({
  question,
  value,
  onChange,
}: {
  question: FormQuestion;
  value: string | null;
  onChange: (value: string) => void;
}) {
  const options = question.options || [];

  return (
    <div className="space-y-2">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`
            w-full py-3 px-4 rounded-lg font-medium text-left transition-all
            ${value === option
              ? 'bg-primary-600 text-white shadow-md'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }
          `}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

// ============================================
// Main Page Component
// ============================================

export default function FeedbackFormPage() {
  const { splCode } = useParams<{ splCode?: string }>();

  // Form state
  const [formConfig, setFormConfig] = useState<FormConfig | null>(null);
  const [prefilled, setPrefilled] = useState<PrefilledData | null>(null);
  const [responses, setResponses] = useState<Record<string, string | number>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(-1); // -1 = welcome screen

  // UI state
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);

  // Load form on mount
  useEffect(() => {
    async function loadForm() {
      try {
        setIsLoading(true);
        setError(null);

        const data = await getFeedbackForm(splCode);
        setFormConfig(data.form);
        setPrefilled(data.prefilled);

        if (data.warning) {
          setWarning(data.warning);
        }

        // Pre-fill therapist name if available
        if (data.prefilled?.therapistName) {
          setResponses((prev) => ({
            ...prev,
            therapist_confirmation: data.prefilled!.therapistName,
          }));
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load form';

        // Check if feedback was already submitted
        if (errorMessage.includes('already submitted')) {
          setAlreadySubmitted(true);
        } else {
          setError(errorMessage);
        }
      } finally {
        setIsLoading(false);
      }
    }

    loadForm();
  }, [splCode]);

  // Handle response changes
  const handleResponseChange = (questionId: string, value: string | number) => {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
  };

  // Navigate to next question
  const handleNext = () => {
    if (!formConfig) return;

    const currentQuestion = formConfig.questions[currentQuestionIndex];

    // Validate current question if it exists and is required
    if (currentQuestionIndex >= 0 && currentQuestion?.required) {
      const response = responses[currentQuestion.id];
      if (response === undefined || response === '' || response === null) {
        return; // Don't proceed if required field is empty
      }
    }

    if (currentQuestionIndex < formConfig.questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      handleSubmit();
    }
  };

  // Navigate to previous question
  const handleBack = () => {
    if (currentQuestionIndex > -1) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
    }
  };

  // Submit form
  const handleSubmit = async () => {
    if (!formConfig) return;

    try {
      setIsSubmitting(true);
      setError(null);

      // Get therapist name from responses or prefilled
      const therapistName = responses.therapist_confirmation as string || prefilled?.therapistName || '';

      await submitFeedback({
        trackingCode: prefilled?.trackingCode || splCode,
        therapistName,
        responses,
      });

      setIsComplete(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to submit feedback';

      if (errorMessage.includes('already submitted')) {
        setAlreadySubmitted(true);
      } else {
        setError(errorMessage);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Check if current question is answered
  const isCurrentQuestionAnswered = () => {
    if (currentQuestionIndex < 0 || !formConfig) return true;
    const currentQuestion = formConfig.questions[currentQuestionIndex];
    const response = responses[currentQuestion.id];
    return response !== undefined && response !== '' && response !== null;
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  // Already submitted state
  if (alreadySubmitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Already Submitted</h2>
          <p className="text-gray-600 mb-6">
            You have already submitted feedback for this session. Thank you for your time!
          </p>
          <Link
            to="/"
            className="inline-block px-6 py-3 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
          >
            Return Home
          </Link>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !formConfig) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Unable to Load Form</h2>
          <p className="text-gray-600 mb-6">{error || 'The feedback form is not available at this time.'}</p>
          <Link
            to="/"
            className="inline-block px-6 py-3 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
          >
            Return Home
          </Link>
        </div>
      </div>
    );
  }

  // Complete state
  if (isComplete) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">{formConfig.thankYouTitle}</h2>
          <p className="text-gray-600 mb-6">{formConfig.thankYouMessage}</p>
          <Link
            to="/"
            className="inline-block px-6 py-3 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
          >
            Return Home
          </Link>
        </div>
      </div>
    );
  }

  // Welcome screen
  if (currentQuestionIndex === -1) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">{formConfig.welcomeTitle}</h1>
          <p className="text-gray-600 mb-6">{formConfig.welcomeMessage}</p>

          {warning && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">{warning}</p>
            </div>
          )}

          {prefilled && (
            <div className="mb-6 p-4 bg-primary-50 border border-primary-200 rounded-lg">
              <p className="text-sm text-primary-800">
                <span className="font-medium">Session with:</span> {prefilled.therapistName}
              </p>
              {prefilled.userName && (
                <p className="text-sm text-primary-800 mt-1">
                  <span className="font-medium">Welcome back,</span> {prefilled.userName}
                </p>
              )}
            </div>
          )}

          <button
            onClick={() => setCurrentQuestionIndex(0)}
            className="w-full py-3 px-6 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
          >
            Start Feedback
          </button>
        </div>
      </div>
    );
  }

  // Question screen
  const currentQuestion = formConfig.questions[currentQuestionIndex];
  const progress = ((currentQuestionIndex + 1) / formConfig.questions.length) * 100;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
        {/* Progress bar */}
        <div className="mb-6">
          <div className="flex justify-between text-sm text-gray-500 mb-2">
            <span>Question {currentQuestionIndex + 1} of {formConfig.questions.length}</span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-600 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Question */}
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-1">
            {currentQuestion.question}
            {currentQuestion.required && <span className="text-red-500 ml-1">*</span>}
          </h2>
          {currentQuestion.prefilled && prefilled?.therapistName && (
            <p className="text-sm text-gray-500">Pre-filled from your appointment</p>
          )}
        </div>

        {/* Input based on question type */}
        <div className="mb-8">
          {currentQuestion.type === 'text' && (
            <input
              type="text"
              value={(responses[currentQuestion.id] as string) || ''}
              onChange={(e) => handleResponseChange(currentQuestion.id, e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              placeholder="Type your answer..."
            />
          )}

          {currentQuestion.type === 'scale' && (
            <ScaleQuestion
              question={currentQuestion}
              value={(responses[currentQuestion.id] as number) ?? null}
              onChange={(value) => handleResponseChange(currentQuestion.id, value)}
            />
          )}

          {currentQuestion.type === 'choice' && (
            <ChoiceQuestion
              question={currentQuestion}
              value={(responses[currentQuestion.id] as string) || null}
              onChange={(value) => handleResponseChange(currentQuestion.id, value)}
            />
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex gap-3">
          {currentQuestionIndex > 0 && (
            <button
              onClick={handleBack}
              className="flex-1 py-3 px-6 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 transition-colors"
            >
              Back
            </button>
          )}

          <button
            onClick={handleNext}
            disabled={currentQuestion.required && !isCurrentQuestionAnswered() || isSubmitting}
            className={`
              flex-1 py-3 px-6 rounded-lg font-medium transition-colors
              ${currentQuestion.required && !isCurrentQuestionAnswered()
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-primary-600 text-white hover:bg-primary-700'
              }
            `}
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Submitting...
              </span>
            ) : currentQuestionIndex === formConfig.questions.length - 1 ? (
              'Submit'
            ) : (
              'Next'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
