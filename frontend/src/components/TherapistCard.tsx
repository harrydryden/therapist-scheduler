import { useState, memo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitAppointmentRequest } from '../api/client';
import type { Therapist } from '../types';
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

// Category section component
interface CategorySectionProps {
  label: string;
  items: string[];
  categoryType: 'approach' | 'style' | 'areasOfFocus';
  maxItems?: number;
}

function CategorySection({ label, items, categoryType, maxItems = 3 }: CategorySectionProps) {
  if (!items || items.length === 0) return null;

  const displayItems = items.slice(0, maxItems);
  const remainingCount = items.length - maxItems;

  return (
    <div className="mb-2">
      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
      <div className="flex flex-wrap gap-1.5 mt-1">
        {displayItems.map((item) => (
          <CategoryBadge key={item} type={item} categoryType={categoryType} />
        ))}
        {remainingCount > 0 && (
          <span className="inline-block px-2 py-1 text-xs font-medium bg-slate-100 text-slate-500 rounded-full">
            +{remainingCount}
          </span>
        )}
      </div>
    </div>
  );
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

  // Check if we have new categories or need to fall back to specialisms
  const hasNewCategories =
    (therapist.approach?.length > 0) ||
    (therapist.style?.length > 0) ||
    (therapist.areasOfFocus?.length > 0);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden hover:shadow-md transition-all duration-200">
      {/* Name and categories */}
      <div className="p-6">
        <h3 className="text-xl font-bold text-slate-900 break-words line-clamp-2">{therapist.name}</h3>

        {/* New category system with tooltips */}
        {hasNewCategories ? (
          <div className="mt-4 space-y-2">
            <CategorySection
              label={CATEGORY_LABELS.areasOfFocus}
              items={therapist.areasOfFocus}
              categoryType="areasOfFocus"
              maxItems={3}
            />
            <CategorySection
              label={CATEGORY_LABELS.approach}
              items={therapist.approach}
              categoryType="approach"
              maxItems={2}
            />
            <CategorySection
              label={CATEGORY_LABELS.style}
              items={therapist.style}
              categoryType="style"
              maxItems={2}
            />
          </div>
        ) : (
          /* Fallback to old specialisms for backwards compatibility */
          <div className="flex flex-wrap gap-2 mt-3">
            {therapist.specialisms?.slice(0, 4).map((specialism) => (
              <span
                key={specialism}
                className="inline-block px-3 py-1 text-xs font-medium bg-teal-50 text-teal-700 rounded-full"
              >
                {specialism}
              </span>
            ))}
            {therapist.specialisms?.length > 4 && (
              <span className="inline-block px-3 py-1 text-xs font-medium bg-slate-100 text-slate-600 rounded-full">
                +{therapist.specialisms.length - 4}
              </span>
            )}
          </div>
        )}
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
