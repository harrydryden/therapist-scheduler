import { useState } from 'react';
import { ApiError } from '../api/client';
import type { TherapistDetail } from '../types';
import { APP } from '../config/constants';
import { useBookingForm } from '../hooks/useBookingForm';

// Helper to check if error is the thread limit error
function isThreadLimitError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'USER_THREAD_LIMIT';
}

// FIX #38: Booking form logic (firstName, email, mutation, handleSubmit) is now
// shared via the useBookingForm hook, eliminating duplication with TherapistCard.tsx.
interface BookingFormProps {
  therapist: TherapistDetail;
}

export default function BookingForm({ therapist }: BookingFormProps) {
  const [submitted, setSubmitted] = useState(false);

  const { firstName, setFirstName, email, setEmail, mutation, handleSubmit, canSubmit } = useBookingForm({
    therapistNotionId: therapist.id,
    therapistName: therapist.name,
    onSuccess: () => setSubmitted(true),
  });

  // Show "therapist booked" message when not accepting bookings
  if (therapist.acceptingBookings === false) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center">
        <svg
          className="w-12 h-12 text-slate-400 mx-auto mb-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <h3 className="text-lg font-semibold text-slate-700 mb-2">Therapist Booked</h3>
        <p className="text-slate-600">
          {therapist.name} is currently not accepting new appointment requests. Please check back
          later or explore other available therapists.
        </p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
        <svg className="w-12 h-12 text-green-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <h3 className="text-lg font-semibold text-green-800 mb-2">Request Submitted!</h3>
        <p className="text-green-700">
          We've received your appointment request. Our scheduling coordinator {APP.COORDINATOR_NAME} will email you shortly to find a
          time that works for both you and {therapist.name}.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Request an Appointment</h3>

      <div className="mb-4">
        <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-1">
          First Name
        </label>
        <input
          type="text"
          id="firstName"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="Your first name"
          required
          className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-colors"
        />
      </div>

      <div className="mb-4">
        <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
          Email
        </label>
        <input
          type="email"
          id="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-colors"
        />
      </div>

      {mutation.isError && isThreadLimitError(mutation.error) && (
        <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h4 className="font-medium text-amber-800">Active Request Limit Reached</h4>
              <p className="text-sm text-amber-700 mt-1">
                You currently have {mutation.error.details?.activeCount || 2} active appointment requests with:
              </p>
              <ul className="text-sm text-amber-700 mt-2 list-disc list-inside">
                {mutation.error.details?.activeTherapists?.map((name: string, idx: number) => (
                  <li key={idx}>{name}</li>
                ))}
              </ul>
              <p className="text-sm text-amber-700 mt-2">
                Please wait for one of your current requests to be confirmed or cancelled before requesting another therapist. Check your email for updates from {APP.COORDINATOR_NAME}.
              </p>
            </div>
          </div>
        </div>
      )}

      {mutation.isError && !isThreadLimitError(mutation.error) && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-700">
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Failed to submit request. Please try again.'}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full px-4 py-3 text-white font-medium bg-primary-600 rounded-md hover:bg-primary-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
      >
        {mutation.isPending ? 'Submitting...' : 'Request Appointment'}
      </button>

      <p className="mt-3 text-xs text-gray-500 text-center">
        Our coordinator will contact you to schedule a time that works for both of you.
      </p>

      <p className="mt-2 text-xs text-gray-400 text-center">
        You can have up to 2 active appointment requests at a time.
      </p>
    </form>
  );
}
