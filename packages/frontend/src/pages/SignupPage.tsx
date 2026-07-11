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
      <div className="max-w-[640px] mx-auto py-12 px-4 sm:px-6">
        <div className="bg-spill-teal-100 border border-spill-teal-200 rounded-xl p-8 text-center">
          <svg
            className="w-10 h-10 text-spill-teal-600 mx-auto mb-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <h3 className="font-display font-bold text-xl leading-[26px] tracking-[-0.4px] text-black mb-2">You&rsquo;re signed up</h3>
          <p className="text-sm text-spill-grey-600">
            Thanks{form.name ? `, ${form.name.trim().split(' ')[0]}` : ''}. We&rsquo;ve added you to
            our user database. When you&rsquo;re ready to book a session, head over to the{' '}
            <Link to="/" className="text-spill-blue-800 underline font-medium">
              therapist directory
            </Link>{' '}
            and pick someone to work with.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[640px] mx-auto py-10 px-4 sm:px-6">
      <div className="mb-7">
        <h2 className="font-display font-bold text-3xl leading-[39px] tracking-[-0.6px] text-black mb-2">Sign up</h2>
        <p className="text-base tracking-[-0.31px] text-spill-grey-600">
          A short intake form before you book your first session. Takes about 30 seconds.
        </p>
      </div>

      {/* Invitation banner: visible whenever ?invite= is in the URL. Shows
          either "valid invitation for X" or a clear failure mode (expired,
          revoked, already used) so the user understands why the form is
          gated before they fill it in. */}
      {invitationToken && invitationQuery.isLoading && (
        <div className="mb-6 bg-spill-grey-100 border border-spill-grey-200 rounded-lg p-4 text-sm text-spill-grey-600">
          Verifying invitation…
        </div>
      )}
      {/* Single banner for all "not usable" cases. The backend deliberately
          collapses unknown / malformed / expired / revoked / already-accepted
          into one shape (redeemable=false, reason='invalid') so we present
          it the same way here — a leaked URL can't be probed via this page
          to learn whether it ever pointed at a real invitation. */}
      {invitationToken && invitationQuery.isFetched && (!invitation || invitation.redeemable === false) && (
        <div className="mb-6 bg-spill-yellow-100 border border-spill-yellow-200 rounded-lg p-4 text-sm text-spill-grey-600">
          This invitation link isn&rsquo;t usable. It may have been revoked, used
          already, or expired. Ask the person who invited you for a new link.
        </div>
      )}
      {invitation && invitation.redeemable && (
        <div className="mb-6 bg-spill-blue-100 border border-spill-blue-200 rounded-lg p-4 text-sm text-spill-blue-900">
          You&rsquo;ve been invited to sign up. Use the email below &mdash; this invitation is for {invitation.email}.
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white border border-spill-grey-200 rounded-xl p-7 space-y-[22px]">
        {/* Name */}
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-black mb-1.5">
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
            className="w-full px-3 py-2.5 text-sm bg-white border border-spill-grey-200 rounded-lg focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none transition-shadow duration-150 disabled:bg-spill-grey-100 disabled:cursor-not-allowed"
          />
        </div>

        {/* Email — locked when an invitation is in play; the backend
            requires the email to match the invitation address. */}
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-black mb-1.5">
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
            className={`w-full px-3 py-2.5 text-sm border rounded-lg focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none transition-shadow duration-150 ${
              form.email.length > 0 && !emailValid ? 'border-spill-red-400' : 'border-spill-grey-200'
            } ${invitation && invitation.redeemable ? 'bg-spill-grey-100 cursor-not-allowed' : 'bg-white'} disabled:bg-spill-grey-100`}
          />
          {invitation && invitation.redeemable && (
            <p className="mt-1.5 text-xs text-spill-grey-400">
              Locked to the email this invitation was sent to.
            </p>
          )}
          {form.email.length > 0 && !emailValid && !invitation && (
            <p className="mt-1.5 text-xs text-spill-red-600">Please enter a valid email address</p>
          )}
        </div>

        {/* Country — drives the timezone every email and reminder we send
            this user is formatted in. Defaults to UK. */}
        <div>
          <label htmlFor="country" className="block text-sm font-medium text-black mb-1.5">
            Country
          </label>
          <select
            id="country"
            value={form.country}
            onChange={(e) => setForm((s) => ({ ...s, country: e.target.value as CountryCode }))}
            disabled={invitationBlocked}
            className="w-full px-3 py-2.5 text-sm bg-white border border-spill-grey-200 rounded-lg focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none transition-shadow duration-150 disabled:bg-spill-grey-100 disabled:cursor-not-allowed"
          >
            {COUNTRY_OPTIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-spill-grey-400">
            Where you&rsquo;re based. We&rsquo;ll use this to send session times in your local timezone.
          </p>
        </div>

        {/* Prior therapy */}
        <fieldset>
          <legend className="block text-sm font-medium text-black mb-2">
            Have you experienced therapy before?
          </legend>
          <div className="flex gap-3 flex-wrap">
            {(['yes', 'no'] as const).map((option) => {
              const value = option === 'yes';
              const checked = form.priorTherapy === value;
              return (
                <label
                  key={option}
                  className={`flex-1 min-w-[200px] cursor-pointer rounded-lg border px-4 py-3 text-sm font-medium text-center transition-all duration-150 ${
                    checked
                      ? 'border-spill-blue-800 bg-spill-blue-100 text-spill-blue-900'
                      : 'border-spill-grey-200 bg-white text-spill-grey-600 hover:bg-spill-grey-100'
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
            className="mt-1 h-4 w-4 accent-black border-spill-grey-200 rounded focus:ring-spill-blue-400"
          />
          <span className="text-sm text-spill-grey-600">
            I understand this is a <strong className="text-black">real therapy session</strong> and I&rsquo;ll bring a real
            issue to talk about &mdash; not a test or hypothetical scenario.
          </span>
        </label>

        {/* Feedback agreement */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.agreedToFeedback}
            onChange={(e) => setForm((s) => ({ ...s, agreedToFeedback: e.target.checked }))}
            className="mt-1 h-4 w-4 accent-black border-spill-grey-200 rounded focus:ring-spill-blue-400"
          />
          <span className="text-sm text-spill-grey-600">
            I agree to complete a short feedback form after my session.
          </span>
        </label>

        {/* Error */}
        {mutation.isError && (
          <div className="p-3 bg-spill-red-100 border border-spill-red-200 rounded-lg">
            <p className="text-sm text-spill-red-600">
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
          className="w-full px-4 py-3 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150"
        >
          {mutation.isPending ? 'Submitting…' : 'Sign up'}
        </button>

        <p className="text-xs text-spill-grey-400 text-center">
          Already booked with us before? You can sign up again to refresh your details &mdash; we won&rsquo;t
          create a duplicate account.
        </p>
      </form>
    </div>
  );
}
