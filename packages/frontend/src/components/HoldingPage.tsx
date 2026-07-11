/**
 * Holding page rendered on the public booking directory (TherapistsPage)
 * when no therapists are accepting bookings — i.e. the active set is
 * empty. Filter-narrowed empty states use a different (compact) message
 * with a "Clear filter" action; this page is reserved for the case
 * where there is genuinely nothing for a visitor to book against.
 *
 * Intentionally informational only — no email capture form. The
 * "we'll notify you" promise relies on the existing signup / mailing
 * list mechanisms (the /signup form is the public on-ramp for users
 * who want to be on the list). Adding a dedicated waitlist capture
 * here is a separate concern and would land as its own change.
 */

export default function HoldingPage() {
  return (
    <div className="text-center py-20 px-4 max-w-xl mx-auto">
      <div
        className="inline-flex items-center justify-center w-20 h-20 bg-spill-blue-100 rounded-full mb-6"
        aria-hidden="true"
      >
        <svg
          className="w-10 h-10 text-spill-blue-800"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          {/* Calendar with a small plus — gestures at "adding new" */}
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 14v4m-2-2h4"
          />
        </svg>
      </div>
      <h2 className="font-display font-bold text-3xl leading-[39px] tracking-[-0.6px] text-black mb-3">
        Therapists coming soon
      </h2>
      <p className="text-base tracking-[-0.31px] text-spill-grey-600 leading-relaxed">
        We don't have any therapists on the platform at the moment. More will be added soon.
        We'll notify you when they are.
      </p>
    </div>
  );
}
