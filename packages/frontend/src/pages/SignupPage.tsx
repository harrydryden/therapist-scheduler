import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { submitSignup } from '../api/signup';
import { lookupInvitation } from '../api/invitations';
import { COUNTRIES, DEFAULT_COUNTRY, type CountryCode } from '@therapist-scheduler/shared';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// UK first (the platform default and the most common signup), then the
// rest alphabetised by label so users can scan for theirs predictably.
const COUNTRY_OPTIONS = [
  ...COUNTRIES.filter((c) => c.code === DEFAULT_COUNTRY),
  ...COUNTRIES.filter((c) => c.code !== DEFAULT_COUNTRY).sort((a, b) =>
    a.label.localeCompare(b.label),
  ),
];

interface FormState {
  name: string;
  email: string;
  // null = unselected; true/false = selected
  priorTherapy: boolean | null;
  acknowledgedRealSession: boolean;
  agreedToFeedback: boolean;
  country: CountryCode;
}

const INITIAL_STATE: FormState = {
  name: '',
  email: '',
  priorTherapy: null,
  acknowledgedRealSession: false,
  agreedToFeedback: false,
  country: DEFAULT_COUNTRY,
};

export default function SignupPage() {
  const [params] = useSearchParams();
  const invitationToken = useMemo(() => params.get('invite') || null, [params]);

  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [submitted, setSubmitted] = useState(false);

  // When ?invite=<token> is present, look the invitation up so we can
  // prefill the email (locked) and surface a clear error if the token is
  // bad / expired / already used / revoked before the user fills the form.
  const invitationQuery = useQuery({
    queryKey: ['signup-invitation', invitationToken],
    queryFn: () => lookupInvitation(invitationToken!),
    enabled: !!invitationToken,
    retry: false,
  });

  // Prefill name/email from the invitation as soon as the lookup resolves.
  // Only prefill when the invitation is redeemable (the non-redeemable
  // shape has no email or name — by design, to avoid leaking who the
  // invitation was sent to from a non-usable token).
  useEffect(() => {
    const inv = invitationQuery.data;
    if (!inv || !inv.redeemable) return;
    setForm((prev) => ({
      ...prev,
      email: prev.email || inv.email,
      name: prev.name || inv.name || '',
    }));
  }, [invitationQuery.data]);

  const mutation = useMutation({
    mutationFn: submitSignup,
    onSuccess: () => setSubmitted(true),
  });

  const emailValid = EMAIL_REGEX.test(form.email.trim());
  const nameValid = form.name.trim().length > 0;
  const invitationLoaded = !invitationToken || invitationQuery.isFetched;
  const invitation = invitationQuery.data;
  // If we have an invitation and it's not redeemable, gate the form.
  const invitationBlocked = !!invitation && invitation.redeemable === false;

  const canSubmit =
    nameValid &&
    emailValid &&
    form.priorTherapy !== null &&
    form.acknowledgedRealSession === true &&
    form.agreedToFeedback === true &&
    !mutation.isPending &&
    !invitationBlocked &&
    invitationLoaded;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    mutation.mutate({
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      priorTherapy: form.priorTherapy === true,
      acknowledgedRealSession: true,
      agreedToFeedback: true,
      country: form.country,
      ...(invitationToken ? { invitationToken } : {}),
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

      {/* Invitation banner: visible whenever ?invite= is in the URL. Shows
          either "valid invitation for X" or a clear failure mode (expired,
          revoked, already used) so the user understands why the form is
          gated before they fill it in. */}
      {invitationToken && invitationQuery.isLoading && (
        <div className="mb-6 bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-600">
          Verifying invitation…
        </div>
      )}
      {/* Single banner for all "not usable" cases. The backend deliberately
          collapses unknown / malformed / expired / revoked / already-accepted
          into one shape (redeemable=false, reason='invalid') so we present
          it the same way here — a leaked URL can't be probed via this page
          to learn whether it ever pointed at a real invitation. */}
      {invitationToken && invitationQuery.isFetched && (!invitation || invitation.redeemable === false) && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          This invitation link isn&rsquo;t usable. It may have been revoked, used
          already, or expired. Ask the person who invited you for a new link.
        </div>
      )}
      {invitation && invitation.redeemable && (
        <div className="mb-6 bg-spill-blue-50 border border-spill-blue-200 rounded-lg p-4 text-sm text-spill-blue-800">
          You&rsquo;ve been invited to sign up. Use the email below &mdash; this invitation is for {invitation.email}.
        </div>
      )}

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
            disabled={invitationBlocked}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-colors disabled:bg-slate-50 disabled:cursor-not-allowed"
          />
        </div>

        {/* Email — locked when an invitation is in play; the backend
            requires the email to match the invitation address. */}
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
            readOnly={!!invitation && invitation.redeemable}
            disabled={invitationBlocked}
            className={`w-full px-4 py-2 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-colors ${
              form.email.length > 0 && !emailValid ? 'border-red-300' : 'border-gray-300'
            } ${invitation && invitation.redeemable ? 'bg-slate-50 cursor-not-allowed' : ''} disabled:bg-slate-50`}
          />
          {invitation && invitation.redeemable && (
            <p className="mt-1 text-xs text-slate-500">
              Locked to the email this invitation was sent to.
            </p>
          )}
          {form.email.length > 0 && !emailValid && !invitation && (
            <p className="mt-1 text-xs text-red-600">Please enter a valid email address</p>
          )}
        </div>

        {/* Country — drives the timezone every email and reminder we send
            this user is formatted in. Defaults to UK. */}
        <div>
          <label htmlFor="country" className="block text-sm font-medium text-gray-700 mb-1">
            Country
          </label>
          <select
            id="country"
            value={form.country}
            onChange={(e) => setForm((s) => ({ ...s, country: e.target.value as CountryCode }))}
            disabled={invitationBlocked}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-colors disabled:bg-slate-50 disabled:cursor-not-allowed"
          >
            {COUNTRY_OPTIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Where you&rsquo;re based. We&rsquo;ll use this to send session times in your local timezone.
          </p>
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
