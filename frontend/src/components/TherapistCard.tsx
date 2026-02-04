import { useState, memo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitAppointmentRequest } from '../api/client';
import type { Therapist, TherapistAvailability } from '../types';
import {
  getExplainer,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
} from '../config/therapist-categories';

interface TherapistCardProps {
  therapist: Therapist;
}

// Category badge with tooltip
interface CategoryBadgeProps {
  type: string;
  categoryType: 'approach' | 'style' | 'areasOfFocus';
}

function CategoryBadge({ type, categoryType }: CategoryBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const explainer = getExplainer(categoryType, type);
  const colorClass = CATEGORY_COLORS[categoryType];

  return (
    <div className="relative inline-block">
      <span
        className={`inline-block px-3 py-1 text-xs font-medium rounded-full border cursor-help ${colorClass}`}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onBlur={() => setShowTooltip(false)}
        tabIndex={0}
        role="button"
        aria-describedby={explainer ? `tooltip-${type.replace(/\s/g, '-')}` : undefined}
      >
        {type}
      </span>
      {showTooltip && explainer && (
        <div
          id={`tooltip-${type.replace(/\s/g, '-')}`}
          role="tooltip"
          className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-white bg-slate-800 rounded-lg shadow-lg max-w-xs whitespace-normal"
        >
          {explainer}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1">
            <div className="border-4 border-transparent border-t-slate-800"></div>
          </div>
        </div>
      )}
    </div>
  );
}

// Fallback badge for when no categories are selected
function GeneralBadge({ categoryType }: { categoryType: 'approach' | 'style' | 'areasOfFocus' }) {
  const colorClass = CATEGORY_COLORS[categoryType];

  return (
    <span
      className={`inline-block px-3 py-1 text-xs font-medium rounded-full border ${colorClass}`}
    >
      General
    </span>
  );
}

// Expandable Category section component with fixed height
interface CategorySectionProps {
  label: string;
  items: string[];
  categoryType: 'approach' | 'style' | 'areasOfFocus';
  maxItems: number;
  isExpanded: boolean;
  onToggle: () => void;
}

function CategorySection({ label, items, categoryType, maxItems, isExpanded, onToggle }: CategorySectionProps) {
  const hasItems = items && items.length > 0;
  const displayItems = hasItems ? (isExpanded ? items : items.slice(0, maxItems)) : [];
  const hasOverflow = hasItems && items.length > maxItems;

  return (
    <div className="h-[52px] flex flex-col">
      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
      <div className="flex flex-wrap gap-1.5 mt-1 items-center flex-1">
        {hasItems ? (
          <>
            {displayItems.map((item) => (
              <CategoryBadge key={item} type={item} categoryType={categoryType} />
            ))}
            {hasOverflow && !isExpanded && (
              <button
                onClick={onToggle}
                className="inline-block px-2 py-1 text-xs font-medium bg-slate-100 text-slate-500 rounded-full hover:bg-slate-200 transition-colors"
              >
                +{items.length - maxItems}
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
  // Group slots by day
  const slotsByDay: Record<string, string[]> = {};

  for (const slot of availability.slots) {
    const day = slot.day;
    const timeRange = `${slot.start}-${slot.end}`;
    if (!slotsByDay[day]) {
      slotsByDay[day] = [];
    }
    slotsByDay[day].push(timeRange);
  }

  // Sort days and format output
  const sortedDays = Object.keys(slotsByDay).sort(
    (a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)
  );

  return sortedDays.map((day) => {
    const abbrev = DAY_ABBREVIATIONS[day] || day.slice(0, 3);
    const times = slotsByDay[day].join(', ');
    return `${abbrev}: ${times}`;
  });
}

const MAX_AVAILABILITY_SLOTS = 2;

function AvailabilityDisplay({ availability, isExpanded, onToggle }: AvailabilityDisplayProps) {
  const hasAvailability = availability && availability.slots && availability.slots.length > 0;

  if (!hasAvailability) {
    // Elegant fallback state
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="text-sm italic">Available on request</span>
      </div>
    );
  }

  const formattedSlots = formatAvailability(availability);
  const displaySlots = isExpanded ? formattedSlots : formattedSlots.slice(0, MAX_AVAILABILITY_SLOTS);
  const hasMore = formattedSlots.length > MAX_AVAILABILITY_SLOTS;

  return (
    <div className="text-slate-600">
      <div className="flex items-start gap-2">
        <svg className="w-4 h-4 mt-0.5 text-teal-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <div className="text-sm space-y-0.5">
          {displaySlots.map((slot, idx) => (
            <div key={idx} className="text-slate-600">{slot}</div>
          ))}
          {hasMore && !isExpanded && (
            <button
              onClick={onToggle}
              className="text-xs text-teal-600 hover:text-teal-700 font-medium"
            >
              +{formattedSlots.length - MAX_AVAILABILITY_SLOTS} more days
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Fixed heights for consistent alignment
const SECTION_HEIGHTS = {
  name: 'h-[36px]',
  areasOfFocus: 'h-[52px]',
  approach: 'h-[52px]',
  style: 'h-[52px]',
  bio: 'h-[72px]',
  availability: 'h-[72px]',
};

const TherapistCard = memo(function TherapistCard({ therapist }: TherapistCardProps) {
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const mutation = useMutation({
    mutationFn: submitAppointmentRequest,
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !email.trim()) return;

    mutation.mutate({
      userName: firstName.trim(),
      userEmail: email,
      therapistNotionId: therapist.id,
      therapistName: therapist.name,
    });
  };

  // Check if any section is expanded to adjust layout
  const hasExpandedContent = expandedSections.size > 0;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden hover:shadow-md transition-all duration-200 flex flex-col">
      {/* Name - fixed height */}
      <div className={`px-6 pt-6 ${hasExpandedContent ? '' : SECTION_HEIGHTS.name}`}>
        <h3 className="text-xl font-bold text-slate-900 break-words line-clamp-1">{therapist.name}</h3>
      </div>

      {/* Category Sections - fixed heights unless expanded */}
      <div className="px-6 pt-4 space-y-1">
        {/* Areas of Focus */}
        <div className={hasExpandedContent && isExpanded('areasOfFocus') ? '' : SECTION_HEIGHTS.areasOfFocus}>
          <CategorySection
            label={CATEGORY_LABELS.areasOfFocus}
            items={therapist.areasOfFocus || []}
            categoryType="areasOfFocus"
            maxItems={3}
            isExpanded={isExpanded('areasOfFocus')}
            onToggle={() => toggleSection('areasOfFocus')}
          />
        </div>

        {/* Approach */}
        <div className={hasExpandedContent && isExpanded('approach') ? '' : SECTION_HEIGHTS.approach}>
          <CategorySection
            label={CATEGORY_LABELS.approach}
            items={therapist.approach || []}
            categoryType="approach"
            maxItems={2}
            isExpanded={isExpanded('approach')}
            onToggle={() => toggleSection('approach')}
          />
        </div>

        {/* Style */}
        <div className={hasExpandedContent && isExpanded('style') ? '' : SECTION_HEIGHTS.style}>
          <CategorySection
            label={CATEGORY_LABELS.style}
            items={therapist.style || []}
            categoryType="style"
            maxItems={2}
            isExpanded={isExpanded('style')}
            onToggle={() => toggleSection('style')}
          />
        </div>
      </div>

      {/* Bio - fixed height unless expanded */}
      <div className={`px-6 py-3 ${hasExpandedContent && isExpanded('bio') ? '' : SECTION_HEIGHTS.bio}`}>
        <p className="text-sm text-slate-600 leading-relaxed">
          {isExpanded('bio') ? therapist.bio : therapist.bio.slice(0, 100) + (therapist.bio.length > 100 ? '...' : '')}
        </p>
        {therapist.bio.length > 100 && (
          <button
            onClick={() => toggleSection('bio')}
            className="text-sm font-medium text-teal-600 hover:text-teal-700 mt-1"
          >
            {isExpanded('bio') ? 'Show less' : 'Read more'}
          </button>
        )}
      </div>

      {/* Availability Section - fixed height unless expanded */}
      <div className={`px-6 pb-4 ${hasExpandedContent && isExpanded('availability') ? '' : SECTION_HEIGHTS.availability}`}>
        <div className="pt-3 border-t border-slate-100">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Indicative Availability</span>
          <p className="text-xs text-slate-400 mt-0.5 mb-2">More times available upon request</p>
          <AvailabilityDisplay
            availability={therapist.availability}
            isExpanded={isExpanded('availability')}
            onToggle={() => toggleSection('availability')}
          />
        </div>
      </div>

      {/* Booking Form - always at bottom */}
      <div className="border-t border-slate-100 p-6 bg-slate-50 mt-auto">
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
