/**
 * What to tell someone who has just signed up. When booking needs a
 * session code, the directory is useless until the welcome email (which
 * carries their personal booking link) arrives — so send them to their
 * inbox, not to the directory.
 */
export function signupSuccessCopy(opts: { voucherEnabled: boolean; voucherRequired: boolean }): {
  headline: string;
  body: string;
  /** A welcome email with the booking link is sent only when vouchers are on. */
  emailSent: boolean;
  showDirectoryLink: boolean;
} {
  if (opts.voucherEnabled) {
    return {
      headline: 'Check your inbox',
      body:
        "We've emailed you a personal booking link. Open it to choose a therapist — it can take a few minutes to arrive, so check your spam folder too.",
      emailSent: true,
      showDirectoryLink: !opts.voucherRequired,
    };
  }
  return {
    headline: 'You\u2019re signed up',
    body: 'When you\u2019re ready, pick a therapist from the directory and request a session.',
    emailSent: false,
    showDirectoryLink: true,
  };
}
