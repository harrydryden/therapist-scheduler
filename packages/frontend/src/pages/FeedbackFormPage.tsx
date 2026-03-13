import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { API_BASE } from '../config/env';
import { fetchWithTimeout } from '../api/client';
// FIX #39: Import shared types instead of duplicating them
import type { FormQuestion, FormConfig } from '../types/feedback';

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

const FEEDBACK_TIMEOUT_MS = 30000;

const FORM_LOAD_MAX_RETRIES = 3;

async function getFeedbackForm(splCode?: string, signal?: AbortSignal): Promise<FeedbackFormResponse> {
  const endpoint = splCode
    ? `${API_BASE}/feedback/form/${splCode}`
    : `${API_BASE}/feedback/form`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < FORM_LOAD_MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(endpoint, signal ? { signal } : {}, FEEDBACK_TIMEOUT_MS);
      const data = await response.json();

      if (!response.ok) {
        const err = new Error(data.error || 'Failed to load feedback form');
        // Don't retry client errors (4xx) — they won't succeed on retry
        if (response.status >= 400 && response.status < 500) throw err;
        lastError = err;
        if (attempt < FORM_LOAD_MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }

      // Backend wraps responses in { success, data } envelope via sendSuccess()
      return data.data ?? data;
    } catch (err) {
      // Don't retry if the component unmounted (external abort)
      if (signal?.aborted) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry client-level errors (already thrown above for 4xx)
      if (attempt < FORM_LOAD_MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
    }
  }

  throw lastError || new Error('Failed to load form');
}

async function submitFeedback(data: {
  trackingCode?: string;
  therapistName: string;
  responses: Record<string, string | number>;
}): Promise<{ success: boolean; submissionId: string; message: string }> {
  const response = await fetchWithTimeout(`${API_BASE}/feedback/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, FEEDBACK_TIMEOUT_MS);

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || result.message || 'Failed to submit feedback');
  }

  // Backend wraps responses in { success, data, message } envelope via sendSuccess()
  return { success: result.success, submissionId: result.data?.submissionId, message: result.message };
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
            aria-label={`${num} out of ${max}${num === min && question.scaleMinLabel ? ` - ${question.scaleMinLabel}` : ''}${num === max && question.scaleMaxLabel ? ` - ${question.scaleMaxLabel}` : ''}`}
            aria-pressed={value === num}
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

function requiresExplanation(value: string | null, requireExplanationFor: string[]): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return requireExplanationFor.some((opt) => opt.toLowerCase() === lower);
}

function ChoiceWithTextQuestion({
  question,
  choiceValue,
  textValue,
  requireExplanationFor,
  onChoiceChange,
  onTextChange,
}: {
  question: FormQuestion;
  choiceValue: string | null;
  textValue: string;
  requireExplanationFor: string[];
  onChoiceChange: (value: string) => void;
  onTextChange: (value: string) => void;
}) {
  const options = question.options || [];
  const textRequired = requiresExplanation(choiceValue, requireExplanationFor);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChoiceChange(option)}
            className={`
              w-full py-3 px-4 rounded-lg font-medium text-left transition-all
              ${choiceValue === option
                ? 'bg-primary-600 text-white shadow-md'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }
            `}
          >
            {option}
          </button>
        ))}
      </div>
      {choiceValue && (
        <div className="space-y-1">
          {textRequired && (
            <p className="text-sm text-red-600 font-medium">Please explain your answer <span className="text-red-500">*</span></p>
          )}
          <textarea
            value={textValue}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder={textRequired
              ? (question.followUpPlaceholder || 'Please tell us more...')
              : (question.followUpPlaceholder || 'Tell us more (optional)...')}
            rows={3}
            className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none ${
              textRequired && !textValue.trim()
                ? 'border-red-300'
                : 'border-gray-300'
            }`}
          />
        </div>
      )}
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

  // Load form on mount with cleanup to prevent state updates after unmount
  useEffect(() => {
    const controller = new AbortController();

    async function loadForm() {
      try {
        setIsLoading(true);
        setError(null);

        const data = await getFeedbackForm(splCode, controller.signal);
        if (controller.signal.aborted) return;

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
        if (controller.signal.aborted) return;
        const errorMessage = err instanceof Error ? err.message : 'Failed to load form';
        // FIX #40: Check structured error code in addition to string matching
        const errorCode = (err as { code?: string })?.code;

        // Check if feedback was already submitted
        if (errorCode === 'ALREADY_SUBMITTED' || errorMessage.includes('already submitted')) {
          setAlreadySubmitted(true);
        } else {
          setError(errorMessage);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    loadForm();
    return () => controller.abort();
  }, [splCode]);

  // Compute which questions are visible based on conditional logic
  const visibleQuestions = formConfig
    ? formConfig.questions.filter((q) => {
        if (!q.conditionalOn) return true;
        const parentVal = responses[q.conditionalOn.questionId];
        if (typeof parentVal !== 'string') return false;
        return q.conditionalOn.values.some(
          (v) => v.toLowerCase() === parentVal.toLowerCase()
        );
      })
    : [];

  // Handle response changes
  const handleResponseChange = (questionId: string, value: string | number) => {
    setResponses((prev) => {
      const updated = { ...prev, [questionId]: value };

      // When a parent answer changes, clear responses for conditional sub-questions
      // whose condition is no longer met
      if (formConfig && typeof value === 'string') {
        for (const q of formConfig.questions) {
          if (q.conditionalOn?.questionId === questionId) {
            const conditionMet = q.conditionalOn.values.some(
              (v) => v.toLowerCase() === value.toLowerCase()
            );
            if (!conditionMet) {
              delete updated[q.id];
              delete updated[`${q.id}_text`];
            }
          }
        }
      }

      return updated;
    });
  };

  // Navigate to next question (using visible question indices)
  const handleNext = () => {
    if (!formConfig) return;

    // Validate current question before proceeding
    if (currentQuestionIndex >= 0 && !isCurrentQuestionAnswered()) {
      return;
    }

    // Find next visible question after the current one
    const currentQ = formConfig.questions[currentQuestionIndex];
    const currentVisibleIdx = currentQ ? visibleQuestions.findIndex((q) => q.id === currentQ.id) : -1;

    if (currentVisibleIdx < visibleQuestions.length - 1) {
      const nextVisibleQ = visibleQuestions[currentVisibleIdx + 1];
      const nextRealIdx = formConfig.questions.findIndex((q) => q.id === nextVisibleQ.id);
      setCurrentQuestionIndex(nextRealIdx);
    } else {
      handleSubmit();
    }
  };

  // Navigate to previous question (using visible question indices)
  const handleBack = () => {
    if (!formConfig || currentQuestionIndex <= 0) {
      setCurrentQuestionIndex(-1);
      return;
    }

    const currentQ = formConfig.questions[currentQuestionIndex];
    const currentVisibleIdx = visibleQuestions.findIndex((q) => q.id === currentQ.id);

    if (currentVisibleIdx <= 0) {
      setCurrentQuestionIndex(-1);
    } else {
      const prevVisibleQ = visibleQuestions[currentVisibleIdx - 1];
      const prevRealIdx = formConfig.questions.findIndex((q) => q.id === prevVisibleQ.id);
      setCurrentQuestionIndex(prevRealIdx);
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
      // FIX #40: Check structured error code in addition to string matching
      const errorCode = (err as { code?: string })?.code;

      if (errorCode === 'ALREADY_SUBMITTED' || errorMessage.includes('already submitted')) {
        setAlreadySubmitted(true);
      } else {
        setError(errorMessage);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Check if current question can proceed
  const isCurrentQuestionAnswered = () => {
    if (currentQuestionIndex < 0 || !formConfig) return true;
    const currentQuestion = formConfig.questions[currentQuestionIndex];
    const response = responses[currentQuestion.id];

    // Required questions must have a base response
    if (currentQuestion.required && (response === undefined || response === '' || response === null)) {
      return false;
    }

    // For choice_with_text, require explanation for configured answers
    // (applies even for non-required questions — if they chose to answer, they must explain)
    if (currentQuestion.type === 'choice_with_text' && requiresExplanation(response as string, formConfig.requireExplanationFor)) {
      const textResponse = responses[`${currentQuestion.id}_text`] as string | undefined;
      if (!textResponse || !textResponse.trim()) return false;
    }

    return true;
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
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Therapy Session Feedback</h1>
          {prefilled && (
            <p className="text-lg text-gray-600 mb-6">Session with {prefilled.therapistName}</p>
          )}

          <div className="text-gray-600 mb-6">
            {prefilled?.userName && (
              <p className="mb-2">Hi {prefilled.userName}</p>
            )}
            <p>We hope your session was useful. Would you kindly complete this short feedback form? It will take between 5-10 minutes.</p>
          </div>

          {warning && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">{warning}</p>
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
  const currentVisibleIndex = visibleQuestions.findIndex((q) => q.id === currentQuestion.id);
  const progress = ((currentVisibleIndex + 1) / visibleQuestions.length) * 100;
  const isLastVisible = currentVisibleIndex === visibleQuestions.length - 1;
  const canProceed = isCurrentQuestionAnswered();

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
        {/* Progress bar */}
        <div className="mb-6">
          <div className="flex justify-between text-sm text-gray-500 mb-2">
            <span>Question {currentVisibleIndex + 1} of {visibleQuestions.length}</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Form completion progress"
            className="h-2 bg-gray-200 rounded-full overflow-hidden"
          >
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
          {currentQuestion.helperText && (
            <p className="text-sm text-gray-500 italic mt-1">{currentQuestion.helperText}</p>
          )}
          {currentQuestion.prefilled && prefilled?.therapistName && (
            <p className="text-sm text-gray-500 mt-1">Pre-filled from your appointment</p>
          )}
        </div>

        {/* Input based on question type */}
        <div className="mb-8">
          {currentQuestion.type === 'text' && (
            <textarea
              value={(responses[currentQuestion.id] as string) || ''}
              onChange={(e) => handleResponseChange(currentQuestion.id, e.target.value)}
              rows={4}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none"
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

          {currentQuestion.type === 'choice_with_text' && (
            <ChoiceWithTextQuestion
              question={currentQuestion}
              choiceValue={(responses[currentQuestion.id] as string) || null}
              textValue={(responses[`${currentQuestion.id}_text`] as string) || ''}
              requireExplanationFor={formConfig.requireExplanationFor}
              onChoiceChange={(value) => handleResponseChange(currentQuestion.id, value)}
              onTextChange={(value) => handleResponseChange(`${currentQuestion.id}_text`, value)}
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
            disabled={!canProceed || isSubmitting}
            className={`
              flex-1 py-3 px-6 rounded-lg font-medium transition-colors
              ${!canProceed
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
            ) : isLastVisible ? (
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
