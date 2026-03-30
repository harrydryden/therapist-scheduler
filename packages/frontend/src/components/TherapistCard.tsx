import { useState, memo } from 'react';
import type { Therapist } from '../types';
import {
  CATEGORY_LABELS,
} from '../config/therapist-categories';
import { UI } from '../config/constants';
import { useBookingForm } from '../hooks/useBookingForm';
import type { VoucherState } from '../hooks/useVoucher';
import { CategorySection } from './badges/CategorySection';
import { formatAvailability } from '../utils/availability';
import type { TherapistAvailability } from '../types';

interface TherapistCardProps {
  therapist: Therapist;
  voucher?: VoucherState;
  /** When true, users without a valid voucher are blocked from booking */
  voucherRequired?: boolean;
}

// Icon components
function CalendarIcon() {
  return (
    <svg className="w-4 h-4 text-spill-grey-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

// Availability display component
interface AvailabilityDisplayProps {
  availability: TherapistAvailability | null;
  isExpanded: boolean;
  onToggle: () => void;
}

function AvailabilityDisplay({ availability, isExpanded, onToggle }: AvailabilityDisplayProps) {
  const hasAvailability = availability && availability.slots && availability.slots.length > 0;

  if (!hasAvailability) {
    return (
      <div className="flex items-center gap-2.5 text-spill-grey-400">
        <CalendarIcon />
        <span className="text-sm">Available on request</span>
      </div>
    );
  }

  const formattedSlots = formatAvailability(availability);
  const displaySlots = isExpanded ? formattedSlots : formattedSlots.slice(0, UI.MAX_AVAILABILITY_SLOTS);
  const hasMore = formattedSlots.length > UI.MAX_AVAILABILITY_SLOTS;

  return (
    <div className="text-spill-grey-600">
      <div className="space-y-1">
        {displaySlots.map((slot, idx) => (
          <div key={idx} className="flex items-center gap-2.5">
            {idx === 0 && <CalendarIcon />}
            {idx > 0 && <div className="w-4 flex-shrink-0" />}
            <span className="text-sm">{slot}</span>
          </div>
        ))}
        {hasMore && (
          <button
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Show fewer availability times' : 'Show more availability times'}
            className="ml-[26px] text-xs text-spill-blue-800 hover:text-spill-blue-400 font-medium focus:outline-none focus:ring-2 focus:ring-spill-blue-400 rounded"
          >
            {isExpanded ? 'Show less' : `+${formattedSlots.length - UI.MAX_AVAILABILITY_SLOTS} more days`}
          </button>
        )}
        <p className="text-xs text-spill-grey-400 mt-1.5 ml-[26px]">More times available upon request</p>
      </div>
    </div>
  );
}

// FIX #38: Booking form logic (firstName, email, mutation, handleSubmit) is now
// shared via the useBookingForm hook, eliminating duplication with BookingForm.tsx.
const TherapistCard = memo(function TherapistCard({ therapist, voucher, voucherRequired = false }: TherapistCardProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showBookingForm, setShowBookingForm] = useState(false);

  const { firstName, setFirstName, email, setEmail, mutation, handleSubmit, canSubmit, showEmailError } = useBookingForm({
    therapistNotionId: therapist.id,
    therapistName: therapist.name,
    voucherToken: voucher?.voucherToken,
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const isExpanded = (section: string) => expandedSections.has(section);

  return (
    <div className="bg-white rounded-2xl border border-spill-grey-200 overflow-hidden hover:shadow-lg transition-all duration-300 grid grid-rows-subgrid row-span-8 group">
      {/* Row 1: Teal accent bar */}
      <div className="h-1.5 bg-spill-teal-400" />

      {/* Row 2: Card header */}
      <div className="px-6 pt-5">
        <h3 className="text-lg font-bold text-spill-black leading-tight mb-1">
          {therapist.name}
        </h3>
        <p className={`text-sm text-spill-grey-400 leading-relaxed ${isExpanded('bio') ? '' : 'line-clamp-2'}`}>
          {therapist.bio}
        </p>
        {therapist.bio.length > UI.BIO_TRUNCATE_LENGTH && (
          <button
            onClick={() => toggleSection('bio')}
            aria-expanded={isExpanded('bio')}
            aria-label={isExpanded('bio') ? 'Show less of the bio' : 'Read more of the bio'}
            className="text-xs font-medium text-spill-blue-800 hover:text-spill-blue-400 mt-0.5 focus:outline-none focus:ring-2 focus:ring-spill-blue-400 rounded transition-colors"
          >
            {isExpanded('bio') ? 'Show less' : 'Read more'}
          </button>
        )}
      </div>

      {/* Row 3: Approach */}
      <div className="px-6">
        <CategorySection
          label={CATEGORY_LABELS.approach}
          items={therapist.approach || []}
          categoryType="approach"
          isExpanded={isExpanded('approach')}
          onToggle={() => toggleSection('approach')}
        />
      </div>

      {/* Row 4: Style */}
      <div className="px-6">
        <CategorySection
          label={CATEGORY_LABELS.style}
          items={therapist.style || []}
          categoryType="style"
          isExpanded={isExpanded('style')}
          onToggle={() => toggleSection('style')}
        />
      </div>

      {/* Row 5: Areas of Focus */}
      <div className="px-6">
        <CategorySection
          label={CATEGORY_LABELS.areasOfFocus}
          items={therapist.areasOfFocus || []}
          categoryType="areasOfFocus"
          isExpanded={isExpanded('areasOfFocus')}
          onToggle={() => toggleSection('areasOfFocus')}
        />
      </div>

      {/* Row 6: Availability title */}
      <div className="px-6 self-end">
        <span className="text-[11px] font-semibold text-spill-grey-400 uppercase tracking-wider block">
          Availability
        </span>
      </div>

      {/* Row 7: Availability content */}
      <div className="px-6">
        <AvailabilityDisplay
          availability={therapist.availability}
          isExpanded={isExpanded('availability')}
          onToggle={() => toggleSection('availability')}
        />
      </div>

      {/* Row 8: Bottom action bar */}
      <div className="px-6 pb-5">
        {/* Voucher gate: only block when voucher is required */}
        {voucherRequired && voucher && !voucher.voucherToken ? (
          <div className="text-center py-3 px-4 bg-slate-50 border border-slate-200 rounded-xl">
            <p className="text-xs text-slate-500">
              A session code is required to book. Check your email from Spill.
            </p>
          </div>
        ) : voucherRequired && voucher && voucher.isExpired ? (
          <div className="text-center py-3 px-4 bg-amber-50 border border-amber-200 rounded-xl">
            <p className="text-xs text-amber-700">
              Your session code has expired. Check your email for a new one.
            </p>
          </div>
        ) : mutation.isSuccess ? (
          <div className="text-center py-3 bg-spill-teal-100 rounded-xl">
            <div className="flex items-center justify-center gap-2">
              <svg className="w-5 h-5 text-spill-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-sm font-semibold text-spill-teal-600">Request sent!</span>
            </div>
            <p className="text-xs text-spill-grey-400 mt-1">
              We'll email you to schedule your session.
            </p>
          </div>
        ) : showBookingForm ? (
          <form onSubmit={handleSubmit} className="space-y-2.5">
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor={`firstName-${therapist.id}`} className="sr-only">
                  First name
                </label>
                <input
                  type="text"
                  id={`firstName-${therapist.id}`}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First name"
                  className="w-full px-3 py-2.5 text-sm border border-spill-grey-200 rounded-xl focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none transition-all bg-spill-grey-100"
                  disabled={mutation.isPending}
                  required
                />
              </div>
              <div className="flex-1">
                <label htmlFor={`email-${therapist.id}`} className="sr-only">
                  Email
                </label>
                <input
                  type="email"
                  id={`email-${therapist.id}`}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email"
                  className={`w-full px-3 py-2.5 text-sm border rounded-xl focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none transition-all bg-spill-grey-100 ${showEmailError ? 'border-spill-red-400' : 'border-spill-grey-200'}`}
                  disabled={mutation.isPending}
                  required
                />
              </div>
            </div>
            {showEmailError && (
              <p className="text-xs text-spill-red-600">Please enter a valid email address</p>
            )}
            {voucher?.displayCode && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-green-50 border border-green-200 rounded-lg">
                <svg className="w-3.5 h-3.5 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-xs text-green-800 font-medium">{voucher.displayCode}</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowBookingForm(false)}
                className="px-4 py-2.5 text-sm font-medium text-spill-grey-400 bg-spill-grey-100 rounded-full hover:bg-spill-grey-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex-1 py-2.5 px-4 text-sm font-semibold text-white bg-spill-teal-600 rounded-full hover:bg-spill-teal-400 focus:ring-2 focus:ring-spill-teal-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
                  'Book session'
                )}
              </button>
            </div>
            {mutation.isError && (
              <p className="text-xs text-spill-red-600 text-center">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Something went wrong. Please try again.'}
              </p>
            )}
          </form>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => setShowBookingForm(true)}
              className="px-5 py-2 text-sm font-semibold text-white bg-spill-teal-600 rounded-full hover:bg-spill-teal-400 focus:ring-2 focus:ring-spill-teal-600 focus:ring-offset-2 transition-all shadow-sm"
            >
              Get started
            </button>
            {/* Spill-style indicator tags */}
            <span className="inline-flex items-center gap-1 text-xs font-medium text-spill-teal-600">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Free session
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

export default TherapistCard;
