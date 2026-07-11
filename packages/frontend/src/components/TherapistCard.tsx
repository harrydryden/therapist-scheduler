import { useState, memo } from 'react';
import type { Therapist } from '../types';
import {
  CATEGORY_LABELS,
} from '../config/therapist-categories';
import { UI } from '../config/constants';
import { useBookingForm } from '../hooks/useBookingForm';
import type { VoucherState } from '../hooks/useVoucher';
import { CategorySection } from './badges/CategorySection';
import { formatAvailability, getDisplayableSlots } from '../utils/availability';
import type { TherapistAvailability } from '../types';
import { getCountryFlag, getCountryLabel } from '@therapist-scheduler/shared';

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

// External link icon for Book Now button
function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

// Availability display component
interface AvailabilityDisplayProps {
  availability: TherapistAvailability | null;
  bookingLink: string | null;
  isExpanded: boolean;
  onToggle: () => void;
  /** Called when user clicks "Book now" — parent should show the booking form */
  onBookNowClick?: () => void;
}

function AvailabilityDisplay({ availability, bookingLink, isExpanded, onToggle, onBookNowClick }: AvailabilityDisplayProps) {
  // Only count display-quality slots (valid weekday + HH:MM-HH:MM). When the
  // agent or an upstream ingestion writes freeform garbage like "flexible"
  // or "Not specified", we fall through to "Available on request" rather than
  // render "Mon: flexible-flexible".
  const hasAvailability = !!availability && getDisplayableSlots(availability).length > 0;

  const formattedSlots = hasAvailability ? formatAvailability(availability!) : [];
  const displaySlots = isExpanded ? formattedSlots : formattedSlots.slice(0, UI.MAX_AVAILABILITY_SLOTS);
  const hasMore = formattedSlots.length > UI.MAX_AVAILABILITY_SLOTS;

  // Every panel is composed of the same three parts: a slot area, a toggle
  // row, and a footer row. The slot area always reserves up to
  // MAX_AVAILABILITY_SLOTS rows (real day/time lines, or a single "Available
  // on request" line when there are none, padded with blank rows); the toggle
  // and footer rows are always present. This keeps every availability panel
  // the same height by construction — no hard-coded pixel floor — so the
  // panels line up across sibling cards regardless of slot count, direct-
  // booking links, or the on-request empty state.
  const rows = hasAvailability ? displaySlots : ['Available on request'];
  const fillerRows = isExpanded ? 0 : Math.max(0, UI.MAX_AVAILABILITY_SLOTS - rows.length);

  const bookNowButton = bookingLink && (
    <button
      type="button"
      onClick={() => {
        window.open(bookingLink, '_blank', 'noopener,noreferrer');
        onBookNowClick?.();
      }}
      className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-spill-blue-800 hover:underline transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
    >
      Book now <ExternalLinkIcon />
    </button>
  );

  return (
    <div className={hasAvailability ? 'text-spill-grey-600' : 'text-spill-grey-400'}>
      <div className="space-y-1">
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-center gap-2.5">
            {idx === 0 ? <CalendarIcon /> : <div className="w-4 flex-shrink-0" />}
            <span className="text-sm">{row}</span>
          </div>
        ))}
        {Array.from({ length: fillerRows }).map((_, i) => (
          <div key={`filler-${i}`} className="flex items-center gap-2.5" aria-hidden="true">
            <div className="w-4 flex-shrink-0" />
            <span className="text-sm">&nbsp;</span>
          </div>
        ))}
        {/* Toggle row — always present so a card without a "+N more days"
            control is the same height as one that has it. */}
        <div className="ml-[26px] text-xs leading-5">
          {hasMore ? (
            <button
              onClick={onToggle}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? 'Show fewer availability times' : 'Show more availability times'}
              className="text-spill-blue-800 hover:underline font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
            >
              {isExpanded ? 'Show less' : `+${formattedSlots.length - UI.MAX_AVAILABILITY_SLOTS} more days`}
            </button>
          ) : (
            <span aria-hidden="true" className="invisible">&nbsp;</span>
          )}
        </div>
        {/* Footer row — one line either way: the direct-booking shortcut when
            the therapist has a booking link, otherwise the "more times"
            reassurance (or a reserved blank line for the on-request state). */}
        <div className="ml-[26px] mt-1.5 text-xs leading-5">
          {bookNowButton ? (
            bookNowButton
          ) : hasAvailability ? (
            <span className="text-spill-grey-400">More times available upon request</span>
          ) : (
            <span aria-hidden="true" className="invisible">&nbsp;</span>
          )}
        </div>
      </div>
    </div>
  );
}

// Small helper for the avatar initials — first letter of each name part.
function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 3)
    .join('')
    .toUpperCase();
}

// Spinner used inside pending submit buttons
function PendingLabel() {
  return (
    <span className="flex items-center justify-center gap-2">
      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      Sending...
    </span>
  );
}

// FIX #38: Booking form logic (firstName, email, mutation, handleSubmit) is now
// shared via the useBookingForm hook, eliminating duplication with BookingForm.tsx.
const TherapistCard = memo(function TherapistCard({ therapist, voucher, voucherRequired = false }: TherapistCardProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showBookingForm, setShowBookingForm] = useState(false);
  // Tracks whether user entered the form via "Book now" (direct link) vs "Get started"
  const [enteredViaDirectLink, setEnteredViaDirectLink] = useState(false);

  const { firstName, setFirstName, email, setEmail, mutation, handleSubmit, handleDirectBooking, canSubmit, showEmailError } = useBookingForm({
    therapistHandle: therapist.id,
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

  const inputClasses = 'w-full px-3 py-2.5 text-sm bg-white border rounded-lg focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none transition-shadow duration-150';

  return (
    <div className="bg-white rounded-xl border border-spill-grey-200 p-6 flex flex-col gap-4 hover:border-spill-grey-400 transition-colors duration-200">
      {/* Header row: avatar + name + country */}
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-full bg-spill-teal-100 text-spill-teal-600 flex items-center justify-center font-display font-bold text-[15px] flex-shrink-0" aria-hidden="true">
          {getInitials(therapist.name)}
        </div>
        <div className="min-w-0">
          <h3 className="font-display font-bold text-xl leading-[26px] tracking-[-0.4px] text-black">
            {therapist.name}
          </h3>
          <p className="text-[13px] text-spill-grey-400 mt-0.5">
            <span role="img" aria-label={`Based in ${getCountryLabel(therapist.country)}`}>
              {getCountryFlag(therapist.country)}
            </span>{' '}
            {getCountryLabel(therapist.country)}
          </p>
        </div>
      </div>

      {/* Bio */}
      <div>
        <p className={`text-sm text-spill-grey-600 leading-relaxed ${isExpanded('bio') ? '' : 'line-clamp-2'}`}>
          {therapist.bio ?? ''}
        </p>
        {therapist.bio !== null && therapist.bio.length > UI.BIO_TRUNCATE_LENGTH && (
          <button
            onClick={() => toggleSection('bio')}
            aria-expanded={isExpanded('bio')}
            aria-label={isExpanded('bio') ? 'Show less of the bio' : 'Read more of the bio'}
            className="text-[13px] font-medium text-spill-blue-800 hover:underline mt-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
          >
            {isExpanded('bio') ? 'Show less' : 'Read more'}
          </button>
        )}
      </div>

      {/* Category sections */}
      <div className="flex flex-col gap-3">
        <CategorySection
          label={CATEGORY_LABELS.approach}
          items={therapist.approach || []}
          categoryType="approach"
          isExpanded={isExpanded('approach')}
          onToggle={() => toggleSection('approach')}
        />
        <CategorySection
          label={CATEGORY_LABELS.style}
          items={therapist.style || []}
          categoryType="style"
          isExpanded={isExpanded('style')}
          onToggle={() => toggleSection('style')}
        />
        <CategorySection
          label={CATEGORY_LABELS.areasOfFocus}
          items={therapist.areasOfFocus || []}
          categoryType="areasOfFocus"
          isExpanded={isExpanded('areasOfFocus')}
          onToggle={() => toggleSection('areasOfFocus')}
        />
      </div>

      {/* Availability panel. Bottom-anchored via mt-auto so it lines up with
          the panels in sibling cards (which are the same height thanks to the
          grid's default stretch). The panel's own height is kept consistent by
          reserving the slot rows and toggle row inside AvailabilityDisplay,
          rather than a hard-coded min-height. */}
      <div className="mt-auto bg-spill-grey-100 rounded-lg px-3.5 py-3">
        <span className="text-[11px] font-bold text-spill-grey-400 uppercase tracking-[0.8px] block mb-2">
          Availability
        </span>
        <AvailabilityDisplay
          availability={therapist.availability}
          bookingLink={therapist.bookingLink}
          isExpanded={isExpanded('availability')}
          onToggle={() => toggleSection('availability')}
          onBookNowClick={() => {
            setEnteredViaDirectLink(true);
            setShowBookingForm(true);
          }}
        />
      </div>

      {/* Bottom action area */}
      <div>
        {/* Voucher gate: only block when voucher is required */}
        {voucherRequired && voucher && !voucher.voucherToken ? (
          <div className="text-center py-3 px-4 bg-spill-grey-100 border border-spill-grey-200 rounded-lg">
            <p className="text-xs text-spill-grey-400">
              A session code is required to book. Check your email from Spill.
            </p>
          </div>
        ) : voucherRequired && voucher && voucher.isExpired ? (
          <div className="text-center py-3 px-4 bg-spill-yellow-100 border border-spill-yellow-200 rounded-lg">
            <p className="text-xs text-spill-yellow-600">
              Your session code has expired. Check your email for a new one.
            </p>
          </div>
        ) : mutation.isSuccess ? (
          <div className="text-center py-3.5 px-4 bg-spill-teal-100 rounded-lg">
            <div className="flex items-center justify-center gap-2">
              <svg className="w-[18px] h-[18px] text-spill-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-sm font-semibold text-spill-teal-600">
                {enteredViaDirectLink ? 'Details received!' : 'Request sent!'}
              </span>
            </div>
            <p className="text-xs text-spill-grey-600 mt-1">
              {enteredViaDirectLink
                ? "We'll follow up to confirm your booking time."
                : "We'll email you to schedule your session."
              }
            </p>
          </div>
        ) : showBookingForm ? (
          <form onSubmit={enteredViaDirectLink ? (e) => { e.preventDefault(); handleDirectBooking(); } : handleSubmit} className="space-y-2.5">
            {enteredViaDirectLink && (
              <p className="text-xs text-spill-grey-400 text-center">
                Share your details so we can confirm your booking time.
              </p>
            )}
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
                  className={`${inputClasses} border-spill-grey-200`}
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
                  className={`${inputClasses} ${showEmailError ? 'border-spill-red-400' : 'border-spill-grey-200'}`}
                  disabled={mutation.isPending}
                  required
                />
              </div>
            </div>
            {showEmailError && (
              <p className="text-xs text-spill-red-600">Please enter a valid email address</p>
            )}
            {voucher?.displayCode && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-spill-teal-100 border border-spill-teal-200 rounded-lg">
                <svg className="w-3.5 h-3.5 text-spill-teal-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-xs text-spill-teal-600 font-medium">Voucher code: {voucher.displayCode}</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowBookingForm(false);
                  setEnteredViaDirectLink(false);
                }}
                className="px-4 py-2.5 text-sm font-medium text-spill-grey-600 bg-white border border-spill-grey-200 rounded-lg hover:bg-spill-grey-100 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400"
              >
                Cancel
              </button>
              {enteredViaDirectLink ? (
                /* User already opened the booking page — just capture their details */
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="flex-1 py-2.5 px-4 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {mutation.isPending ? <PendingLabel /> : 'Confirm details'}
                </button>
              ) : therapist.bookingLink ? (
                /* User entered via "Get started" but therapist has a booking link — offer both paths */
                <>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="flex-1 py-2.5 px-4 text-sm font-medium text-spill-grey-600 bg-white border border-spill-grey-200 rounded-lg hover:bg-spill-grey-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150"
                  >
                    Request booking
                  </button>
                  <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => {
                      handleDirectBooking();
                      window.open(therapist.bookingLink!, '_blank', 'noopener,noreferrer');
                    }}
                    className="flex-1 py-2.5 px-4 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150 flex items-center justify-center gap-1.5"
                  >
                    {mutation.isPending ? <PendingLabel /> : <>Book now <ExternalLinkIcon /></>}
                  </button>
                </>
              ) : (
                /* No booking link — standard flow */
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="flex-1 py-2.5 px-4 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {mutation.isPending ? <PendingLabel /> : 'Book session'}
                </button>
              )}
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
          <div className="flex items-center gap-3.5 flex-wrap">
            <button
              type="button"
              onClick={() => setShowBookingForm(true)}
              className="px-5 py-2.5 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 transition-colors duration-150"
            >
              Get started
            </button>
            {/* Spill-style indicator tags */}
            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-spill-teal-600">
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
