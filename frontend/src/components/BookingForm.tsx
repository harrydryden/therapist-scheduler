import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitAppointmentRequest } from '../api/client';
import type { TherapistDetail, AppointmentRequest } from '../types';

interface BookingFormProps {
  therapist: TherapistDetail;
}

export default function BookingForm({ therapist }: BookingFormProps) {
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: (request: AppointmentRequest) => submitAppointmentRequest(request),
    onSuccess: () => {
      setSubmitted(true);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!firstName.trim() || !email.trim()) return;

    mutation.mutate({
      userName: firstName.trim(),
      userEmail: email,
      therapistNotionId: therapist.id,
      // therapistEmail and therapistName are looked up on the backend from Notion
      // This prevents the frontend from sending fake data
      therapistName: therapist.name, // Still send for backward compat, but backend ignores
    });
  };

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
          We've received your appointment request. Our scheduling coordinator Justin Time will email you shortly to find a
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

      {mutation.isError && (
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
        disabled={mutation.isPending || !firstName.trim() || !email.trim()}
        className="w-full px-4 py-3 text-white font-medium bg-primary-600 rounded-md hover:bg-primary-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
      >
        {mutation.isPending ? 'Submitting...' : 'Request Appointment'}
      </button>

      <p className="mt-3 text-xs text-gray-500 text-center">
        Our coordinator will contact you to schedule a time that works for both of you.
      </p>
    </form>
  );
}
