import { useState } from 'react';
import { ApiError } from '../api/client';
import type { TherapistDetail } from '../types';
import { APP } from '../config/constants';
import { useBookingForm } from '../hooks/useBookingForm';
import type { VoucherState } from '../hooks/useVoucher';

// Helper to check if error is the thread limit error
function isThreadLimitError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'USER_THREAD_LIMIT';
}

// FIX #38: Booking form logic (firstName, email, mutation, handleSubmit) is now
// shared via the useBookingForm hook, eliminating duplication with TherapistCard.tsx.
interface BookingFormProps {
  therapist: TherapistDetail;
  voucher?: VoucherState;
  /** When true, users without a valid voucher are blocked from booking */
  voucherRequired?: boolean;
}

const INPUT_CLASSES =
  'w-full px-3 py-2.5 text-sm bg-white border rounded-lg focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none transition-shadow duration-150';

export default function BookingForm({ therapist, voucher, voucherRequired = false }: BookingFormProps) {
  const [submitted, setSubmitted] = useState(false);

  const [bookingMethodUsed, setBookingMethodUsed] = useState<'agent_negotiated' | 'direct_link'>('agent_negotiated');

  const { firstName, setFirstName, email, setEmail, mutation, handleSubmit, handleDirectBooking, canSubmit, showEmailError } = useBookingForm({
    therapistHandle: therapist.id,
    onSuccess: () => setSubmitted(true),
    voucherToken: voucher?.voucherToken,
  });

  // Show "therapist booked" message when not accepting bookings
  if (therapist.acceptingBookings === false) {
    return (
      <div className="bg-spill-grey-100 border border-spill-grey-200 rounded-xl p-6 text-center">
        <svg
          className="w-10 h-10 text-spill-grey-400 mx-auto mb-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <h4 className="text-lg font-semibold tracking-[-0.36px] text-black mb-2">Therapist booked</h4>
        <p className="text-sm text-spill-grey-600">
          {therapist.name} is currently not accepting new appointment requests. Please check back
          later or explore other available therapists.
        </p>
      </div>
    );
  }

  // Gate: expired voucher (only block when voucher is required)
  if (voucherRequired && voucher && voucher.isExpired) {
    return (
      <div className="bg-spill-yellow-100 border border-spill-yellow-200 rounded-xl p-6 text-center">
        <svg className="w-10 h-10 text-spill-yellow-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h4 className="text-lg font-semibold tracking-[-0.36px] text-black mb-2">Session code expired</h4>
        <p className="text-sm text-spill-grey-600">
          Your session code has expired. Check your email for a new one, or contact{' '}
          <a href="mailto:scheduling@spill.chat" className="text-spill-blue-800 underline font-medium">scheduling@spill.chat</a> to request a fresh code.
        </p>
      </div>
    );
  }

  // Gate: no voucher at all (only block when voucher is required)
  if (voucherRequired && voucher && !voucher.voucherToken) {
    return (
      <div className="bg-spill-grey-100 border border-spill-grey-200 rounded-xl p-6 text-center">
        <svg className="w-10 h-10 text-spill-grey-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
        <h4 className="text-lg font-semibold tracking-[-0.36px] text-black mb-2">Session code required</h4>
        <p className="text-sm text-spill-grey-600">
          A session code is required to book. Check your email from Spill for your personal code. If you don't have one, email{' '}
          <a href="mailto:scheduling@spill.chat" className="text-spill-blue-800 underline font-medium">scheduling@spill.chat</a> to request a code.
        </p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="bg-spill-teal-100 border border-spill-teal-200 rounded-xl p-6 text-center">
        <svg className="w-10 h-10 text-spill-teal-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <h4 className="text-lg font-semibold tracking-[-0.36px] text-spill-teal-600 mb-2">
          {bookingMethodUsed === 'direct_link' ? 'Details received!' : 'Request submitted!'}
        </h4>
        <p className="text-sm text-spill-grey-600">
          {bookingMethodUsed === 'direct_link'
            ? `Once you've booked with ${therapist.name}, our coordinator ${APP.COORDINATOR_NAME} will follow up to confirm your session time.`
            : `We've received your appointment request. Our scheduling coordinator ${APP.COORDINATOR_NAME} will email you shortly to find a time that works for both you and ${therapist.name}.`
          }
        </p>
        {voucher?.displayCode && (
          <p className="text-sm text-spill-teal-600 mt-3">
            Your voucher code <span className="font-mono font-medium">{voucher.displayCode}</span> has been used.
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-spill-grey-200 rounded-xl p-6">
      <h3 className="font-display font-bold text-xl leading-[26px] tracking-[-0.4px] text-black mb-4">Request an appointment</h3>

      <div className="mb-4">
        <label htmlFor="firstName" className="block text-sm font-medium text-black mb-1.5">
          First name
        </label>
        <input
          type="text"
          id="firstName"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="Your first name"
          required
          className={`${INPUT_CLASSES} border-spill-grey-200`}
        />
      </div>

      <div className="mb-5">
        <label htmlFor="email" className="block text-sm font-medium text-black mb-1.5">
          Email
        </label>
        <input
          type="email"
          id="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          className={`${INPUT_CLASSES} ${showEmailError ? 'border-spill-red-400' : 'border-spill-grey-200'}`}
        />
        {showEmailError && (
          <p className="mt-1.5 text-xs text-spill-red-600">Please enter a valid email address</p>
        )}
      </div>

      {voucher?.displayCode && (
        <div className="mb-4 px-3 py-2 bg-spill-teal-100 border border-spill-teal-200 rounded-lg">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-spill-teal-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm text-spill-teal-600 font-medium">Voucher code: {voucher.displayCode}</span>
          </div>
          {voucher.expiresAt && (
            <p className="text-xs text-spill-grey-600 mt-1 ml-6">
              Expires {voucher.expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          )}
        </div>
      )}

      {mutation.isError && isThreadLimitError(mutation.error) && (
        <div className="mb-4 p-4 bg-spill-yellow-100 border border-spill-yellow-200 rounded-lg">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-spill-yellow-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h4 className="text-sm font-semibold text-black">Active request limit reached</h4>
              <p className="text-sm text-spill-grey-600 mt-1">
                You currently have {(mutation.error.details as Record<string, unknown>)?.activeCount as number || 2} active appointment requests.
              </p>
              <p className="text-sm text-spill-grey-600 mt-2">
                Please wait for one of your current requests to be confirmed or cancelled before requesting another therapist. Check your email for updates from {APP.COORDINATOR_NAME}.
              </p>
            </div>
          </div>
        </div>
      )}

      {mutation.isError && !isThreadLimitError(mutation.error) && (
        <div className="mb-4 p-3 bg-spill-red-100 border border-spill-red-200 rounded-lg">
          <p className="text-sm text-spill-red-600">
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Failed to submit request. Please try again.'}
          </p>
        </div>
      )}

      {therapist.bookingLink ? (
        <div className="space-y-2">
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex-1 px-4 py-3 text-sm font-medium text-spill-grey-600 bg-white border border-spill-grey-200 rounded-lg hover:bg-spill-grey-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150"
            >
              {mutation.isPending ? 'Submitting...' : 'Request booking'}
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => {
                setBookingMethodUsed('direct_link');
                handleDirectBooking();
                window.open(therapist.bookingLink!, '_blank', 'noopener,noreferrer');
              }}
              className="flex-1 px-4 py-3 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150 inline-flex items-center justify-center gap-1.5"
            >
              {mutation.isPending ? 'Submitting...' : (
                <>
                  Book now
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </>
              )}
            </button>
          </div>
          <p className="text-xs text-spill-grey-400 text-center">
            <strong>Book now</strong> opens {therapist.name}'s booking page. We'll follow up to confirm your session time.
          </p>
        </div>
      ) : (
        <>
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full px-4 py-3 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {mutation.isPending ? 'Submitting...' : 'Request appointment'}
          </button>

          <p className="mt-3.5 text-xs text-spill-grey-400 text-center">
            Our coordinator will contact you to schedule a time that works for both of you.
          </p>
        </>
      )}

      <p className="mt-1.5 text-xs text-spill-grey-400 text-center">
        You can have up to 2 active appointment requests at a time.
      </p>
    </form>
  );
}
