import { useState, memo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Therapist, TherapistAvailability } from '../types';
import {
  getExplainer,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
} from '../config/therapist-categories';
import { UI } from '../config/constants';
import { useBookingForm } from '../hooks/useBookingForm';

interface TherapistCardProps {
  therapist: Therapist;
}

// Category badge with tooltip (uses portal to escape overflow:hidden)
interface CategoryBadgeProps {
  type: string;
  categoryType: 'approach' | 'style' | 'areasOfFocus';
}

function CategoryBadge({ type, categoryType }: CategoryBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const explainer = getExplainer(categoryType, type);
  const colorClass = CATEGORY_COLORS[categoryType];

  useEffect(() => {
    if (showTooltip && badgeRef.current) {
      const rect = badgeRef.current.getBoundingClientRect();
      setTooltipPosition({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    } else if (!showTooltip) {
      setTooltipPosition(null);
    }
  }, [showTooltip]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setShowTooltip((prev) => !prev);
    }
  };

  return (
    <div className="relative inline-block">
      <span
        ref={badgeRef}
        className={`inline-block px-2.5 py-0.5 text-xs font-medium rounded-full border cursor-help ${colorClass}`}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onBlur={() => setShowTooltip(false)}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-describedby={explainer ? `tooltip-${type.replace(/\s/g, '-')}` : undefined}
      >
        {type}
      </span>
      {showTooltip && explainer && createPortal(
        <div
          id={`tooltip-${type.replace(/\s/g, '-')}`}
          role="tooltip"
          className="fixed px-3 py-2 text-xs text-white bg-spill-grey-600 rounded-lg shadow-lg max-w-xs whitespace-normal pointer-events-none"
          style={{
            zIndex: UI.Z_INDEX.TOOLTIP,
            top: tooltipPosition?.top ?? 0,
            left: tooltipPosition?.left ?? 0,
            transform: 'translate(-50%, -100%)',
            visibility: tooltipPosition ? 'visible' : 'hidden',
          }}
        >
          {explainer}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1">
            <div className="border-4 border-transparent border-t-spill-grey-600"></div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Fallback badge for when no categories are selected
function GeneralBadge({ categoryType }: { categoryType: 'approach' | 'style' | 'areasOfFocus' }) {
  const colorClass = CATEGORY_COLORS[categoryType];

  return (
    <span
      className={`inline-block px-2.5 py-0.5 text-xs font-medium rounded-full border ${colorClass}`}
    >
      General
    </span>
  );
}

// Reusable category section component
interface CategorySectionProps {
  label: string;
  items: string[];
  categoryType: 'approach' | 'style' | 'areasOfFocus';
  isExpanded: boolean;
  onToggle: () => void;
}

function CategorySection({ label, items, categoryType, isExpanded, onToggle }: CategorySectionProps) {
  const hasItems = items && items.length > 0;
  const visibleItems = isExpanded ? items : items.slice(0, UI.MAX_VISIBLE_BADGES);
  const hiddenCount = items.length - UI.MAX_VISIBLE_BADGES;
  const hasMore = hiddenCount > 0;

  return (
    <div>
      <span className="text-[11px] font-semibold text-spill-grey-400 uppercase tracking-wider block mb-1.5">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5 items-start content-start">
        {hasItems ? (
          <>
            {visibleItems.map((item) => (
              <CategoryBadge key={item} type={item} categoryType={categoryType} />
            ))}
            {hasMore && !isExpanded && (
              <button
                onClick={onToggle}
                aria-expanded={false}
                aria-label={`Show ${hiddenCount} more ${label.toLowerCase()} options`}
                className="inline-block px-2 py-0.5 text-xs font-medium bg-spill-grey-100 text-spill-grey-400 rounded-full hover:bg-spill-grey-200 transition-colors focus:outline-none focus:ring-2 focus:ring-spill-blue-400"
              >
                +{hiddenCount}
              </button>
            )}
            {hasMore && isExpanded && (
              <button
                onClick={onToggle}
                aria-expanded={true}
                aria-label={`Show fewer ${label.toLowerCase()} options`}
                className="inline-block px-2 py-0.5 text-xs font-medium text-spill-blue-800 hover:text-spill-blue-400 focus:outline-none focus:ring-2 focus:ring-spill-blue-400 rounded"
              >
                Less
              </button>
            )}
          </>
        ) : (
          <GeneralBadge categoryType={categoryType} />
        )}
      </div>
    </div>
  );
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

// Day order for sorting
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_ABBREVIATIONS: Record<string, string> = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
  Sunday: 'Sun',
};

function formatAvailability(availability: TherapistAvailability): string[] {
  const slotsByDay: Record<string, string[]> = {};

  for (const slot of availability.slots) {
    const day = slot.day;
    const timeRange = `${slot.start}-${slot.end}`;
    if (!slotsByDay[day]) {
      slotsByDay[day] = [];
    }
    slotsByDay[day].push(timeRange);
  }

  const sortedDays = Object.keys(slotsByDay).sort(
    (a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)
  );

  return sortedDays.map((day) => {
    const abbrev = DAY_ABBREVIATIONS[day] || day.slice(0, 3);
    const times = slotsByDay[day].join(', ');
    return `${abbrev}: ${times}`;
  });
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
      </div>
    </div>
  );
}

// FIX #38: Booking form logic (firstName, email, mutation, handleSubmit) is now
// shared via the useBookingForm hook, eliminating duplication with BookingForm.tsx.
const TherapistCard = memo(function TherapistCard({ therapist }: TherapistCardProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showBookingForm, setShowBookingForm] = useState(false);

  const { firstName, setFirstName, email, setEmail, mutation, handleSubmit, canSubmit, showEmailError } = useBookingForm({
    therapistNotionId: therapist.id,
    therapistName: therapist.name,
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
    <div className="bg-white rounded-2xl border border-spill-grey-200 overflow-hidden hover:shadow-lg transition-all duration-300 grid grid-rows-subgrid row-span-7 group">
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

      {/* Row 6: Availability */}
      <div className="px-6 self-end">
        <span className="text-[11px] font-semibold text-spill-grey-400 uppercase tracking-wider block mb-1.5">
          Availability
        </span>
        <AvailabilityDisplay
          availability={therapist.availability}
          isExpanded={isExpanded('availability')}
          onToggle={() => toggleSection('availability')}
        />
      </div>

      {/* Row 7: Bottom action bar */}
      <div className="px-6 pb-5">
        {mutation.isSuccess ? (
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
