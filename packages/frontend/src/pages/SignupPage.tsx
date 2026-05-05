import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { submitSignup } from '../api/signup';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormState {
  name: string;
  email: string;
  // null = unselected; true/false = selected
  priorTherapy: boolean | null;
  acknowledgedRealSession: boolean;
  agreedToFeedback: boolean;
}

const INITIAL_STATE: FormState = {
  name: '',
  email: '',
  priorTherapy: null,
  acknowledgedRealSession: false,
  agreedToFeedback: false,
};

export default function SignupPage() {
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: submitSignup,
    onSuccess: () => setSubmitted(true),
  });

  const emailValid = EMAIL_REGEX.test(form.email.trim());
  const nameValid = form.name.trim().length > 0;

  const canSubmit =
    nameValid &&
    emailValid &&
    form.priorTherapy !== null &&
    form.acknowledgedRealSession === true &&
    form.agreedToFeedback === true &&
    !mutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    mutation.mutate({
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      priorTherapy: form.priorTherapy === true,
      acknowledgedRealSession: true,
      agreedToFeedback: true,
    });
  };

  if (submitted) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-8 text-center">
          <svg
            className="w-12 h-12 text-green-500 mx-auto mb-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <h2 className="text-xl font-semibold text-green-900 mb-2">You&rsquo;re signed up</h2>
          <p className="text-green-800">
            Thanks{form.name ? `, ${form.name.trim().split(' ')[0]}` : ''}. We&rsquo;ve added you to
            our user database. When you&rsquo;re ready to book a session, head over to the{' '}
            <Link to="/" className="underline font-medium">
              therapist directory
            </Link>{' '}
            and pick someone to work with.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Sign up</h1>
        <p className="text-slate-600">
          A short intake form before you book your first session. Takes about 30 seconds.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-6 space-y-6">
        {/* Name */}
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
            Full name
          </label>
          <input
            type="text"
            id="name"
            value={form.name}
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
            placeholder="Your full name"
            required
            autoComplete="name"
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-colors"
          />
        </div>

        {/* Email */}
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
            Email address
          </label>
          <input
            type="email"
            id="email"
            value={form.email}
            onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className={`w-full px-4 py-2 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-colors ${
              form.email.length > 0 && !emailValid ? 'border-red-300' : 'border-gray-300'
            }`}
          />
          {form.email.length > 0 && !emailValid && (
            <p className="mt-1 text-xs text-red-600">Please enter a valid email address</p>
          )}
        </div>

        {/* Prior therapy */}
        <fieldset>
          <legend className="block text-sm font-medium text-gray-700 mb-2">
            Have you experienced therapy before?
          </legend>
          <div className="flex gap-3">
            {(['yes', 'no'] as const).map((option) => {
              const value = option === 'yes';
              const checked = form.priorTherapy === value;
              return (
                <label
                  key={option}
                  className={`flex-1 cursor-pointer rounded-md border px-4 py-3 text-sm font-medium text-center transition-colors ${
                    checked
                      ? 'border-primary-500 bg-primary-50 text-primary-700'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                  }`}
                >
                  <input
                    type="radio"
                    name="priorTherapy"
                    value={option}
                    checked={checked}
                    onChange={() => setForm((s) => ({ ...s, priorTherapy: value }))}
                    className="sr-only"
                  />
                  {option === 'yes' ? 'Yes, I have' : 'No, this would be my first time'}
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Real session acknowledgement */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.acknowledgedRealSession}
            onChange={(e) =>
              setForm((s) => ({ ...s, acknowledgedRealSession: e.target.checked }))
            }
            className="mt-1 h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
          />
          <span className="text-sm text-gray-700">
            I understand this is a <strong>real therapy session</strong> and I&rsquo;ll bring a real
            issue to talk about &mdash; not a test or hypothetical scenario.
          </span>
        </label>

        {/* Feedback agreement */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.agreedToFeedback}
            onChange={(e) => setForm((s) => ({ ...s, agreedToFeedback: e.target.checked }))}
            className="mt-1 h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
          />
          <span className="text-sm text-gray-700">
            I agree to complete a short feedback form after my session.
          </span>
        </label>

        {/* Error */}
        {mutation.isError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-700">
              {mutation.error instanceof Error
                ? mutation.error.message
                : 'Failed to submit signup. Please try again.'}
            </p>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full px-4 py-3 text-white font-medium bg-primary-600 rounded-md hover:bg-primary-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {mutation.isPending ? 'Submitting…' : 'Sign up'}
        </button>

        <p className="text-xs text-gray-500 text-center">
          Already booked with us before? You can sign up again to refresh your details &mdash; we won&rsquo;t
          create a duplicate account.
        </p>
      </form>
    </div>
  );
}
