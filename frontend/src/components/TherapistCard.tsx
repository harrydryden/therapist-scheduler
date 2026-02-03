import { useState, memo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitAppointmentRequest } from '../api/client';
import type { Therapist } from '../types';

interface TherapistCardProps {
  therapist: Therapist;
}

const TherapistCard = memo(function TherapistCard({ therapist }: TherapistCardProps) {
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  const mutation = useMutation({
    mutationFn: submitAppointmentRequest,
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
      therapistName: therapist.name, // Still send for backward compat
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden hover:shadow-md transition-all duration-200">
      {/* Name and specialisms */}
      <div className="p-6">
        <h3 className="text-xl font-bold text-slate-900 break-words line-clamp-2">{therapist.name}</h3>
        <div className="flex flex-wrap gap-2 mt-3">
          {therapist.specialisms.slice(0, 4).map((specialism) => (
            <span
              key={specialism}
              className="inline-block px-3 py-1 text-xs font-medium bg-teal-50 text-teal-700 rounded-full"
            >
              {specialism}
            </span>
          ))}
          {therapist.specialisms.length > 4 && (
            <span className="inline-block px-3 py-1 text-xs font-medium bg-slate-100 text-slate-600 rounded-full">
              +{therapist.specialisms.length - 4}
            </span>
          )}
        </div>
      </div>

      {/* Bio */}
      <div className="px-6 pb-5">
        <p className="text-sm text-slate-600 leading-relaxed">
          {isExpanded ? therapist.bio : therapist.bio.slice(0, 120) + (therapist.bio.length > 120 ? '...' : '')}
        </p>
        {therapist.bio.length > 120 && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-sm font-medium text-teal-600 hover:text-teal-700 mt-2"
          >
            {isExpanded ? 'Show less' : 'Read more'}
          </button>
        )}
      </div>

      {/* Booking Form */}
      <div className="border-t border-slate-100 p-6 bg-slate-50">
        {mutation.isSuccess ? (
          <div className="text-center py-2">
            <div className="inline-flex items-center justify-center w-12 h-12 bg-teal-100 rounded-full mb-3">
              <svg className="w-6 h-6 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-teal-700">Request sent!</p>
            <p className="text-xs text-slate-500 mt-1">
              We'll email you shortly to schedule your session.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor={`firstName-${therapist.id}`} className="sr-only">
                First name
              </label>
              <input
                type="text"
                id={`firstName-${therapist.id}`}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Your first name"
                className="w-full px-4 py-3 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none transition-all"
                disabled={mutation.isPending}
                required
              />
            </div>
            <div>
              <label htmlFor={`email-${therapist.id}`} className="sr-only">
                Your email
              </label>
              <input
                type="email"
                id={`email-${therapist.id}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Your email"
                className="w-full px-4 py-3 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none transition-all"
                disabled={mutation.isPending}
                required
              />
            </div>
            <button
              type="submit"
              disabled={mutation.isPending || !firstName.trim() || !email.trim()}
              className="w-full py-3 px-4 text-sm font-semibold text-white bg-teal-500 rounded-full hover:bg-teal-600 focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {mutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Sending...
                </span>
              ) : (
                'Book a free session'
              )}
            </button>
            {mutation.isError && (
              <p className="text-xs text-red-600 text-center">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Something went wrong. Please try again.'}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
});

export default TherapistCard;
