import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { getTherapists, getFrontendSettings } from '../api/client';
import TherapistCard from '../components/TherapistCard';
import FilterBar from '../components/FilterBar';
import HoldingPage from '../components/HoldingPage';
import { useVoucher } from '../hooks/useVoucher';

const DEFAULT_HERO_HEADING = 'Book a free therapy session';
const DEFAULT_HERO_PARAGRAPH =
  "We've partnered with hand-picked, vetted therapists to offer free one-to-one sessions. " +
  "Choose a therapist below and we'll arrange a time that works for you — sessions are 50 minutes, held over video call.";

// Body text below this length renders in full — no point in a
// "Read more" toggle for a sentence or two.
const INTRO_COLLAPSE_THRESHOLD = 150;

/**
 * Admins sometimes write the intro heading in ALL CAPS. The hero h1
 * should read in sentence case, so fully-uppercase headings get
 * normalised (preserving the "Spill" brand name); mixed-case text is
 * left exactly as written.
 */
function toSentenceCase(text: string): string {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return text;
  const lower = text.toLowerCase();
  return (lower.charAt(0).toUpperCase() + lower.slice(1)).replace(/\bspill\b/g, 'Spill');
}

/**
 * The hero band sources its copy from the `frontend.therapistPageIntro`
 * markdown setting: the first heading becomes the h1, and everything
 * else renders below it as the collapsible markdown body ("Read more"
 * expands it), so the full intro text is always reachable.
 */
function parseHeroContent(markdown: string): { heading: string; body: string } {
  const stripInline = (line: string) =>
    line
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/_(.+?)_/g, '$1');

  const lines = markdown.split('\n');
  const headingIdx = lines.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
  const heading = headingIdx >= 0 ? stripInline(lines[headingIdx].trim()) : DEFAULT_HERO_HEADING;
  const body = (headingIdx >= 0 ? [...lines.slice(0, headingIdx), ...lines.slice(headingIdx + 1)] : lines)
    .join('\n')
    .trim();

  return { heading: toSentenceCase(heading), body };
}

export default function TherapistsPage() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [isIntroExpanded, setIsIntroExpanded] = useState(false);

  const {
    data: therapists,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['therapists'],
    queryFn: getTherapists,
  });

  // Fetch frontend settings for intro text
  const { data: frontendSettings } = useQuery({
    queryKey: ['frontendSettings'],
    queryFn: getFrontendSettings,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const introText = frontendSettings?.['frontend.therapistPageIntro'] || '';
  const voucherEnabled = frontendSettings?.['voucher.enabled'] ?? false;
  const voucherRequired = frontendSettings?.['voucher.required'] ?? false;
  const voucherExpiryDays = frontendSettings?.['voucher.expiryDays'] ?? 14;

  const voucher = useVoucher(voucherExpiryDays);

  const hero = useMemo(() => parseHeroContent(introText), [introText]);

  // Filter to only show active therapists
  const activeTherapists = useMemo(() => {
    if (!Array.isArray(therapists)) return [];
    return therapists.filter((t) => t.active);
  }, [therapists]);

  // Extract unique Areas of Focus from active therapists
  const areasOfFocusOptions = useMemo(() => {
    const categorySet = new Set<string>();
    activeTherapists.forEach((t) => {
      (t.areasOfFocus || []).forEach((c) => categorySet.add(c));
    });
    return Array.from(categorySet).sort();
  }, [activeTherapists]);

  // Filter therapists by selected Area of Focus
  const filteredTherapists = useMemo(() => {
    if (!selectedCategory) return activeTherapists;
    return activeTherapists.filter((t) => (t.areasOfFocus || []).includes(selectedCategory));
  }, [activeTherapists, selectedCategory]);

  // Toggle filter - clicking same option again deselects it
  const handleFilterChange = (category: string | null) => {
    if (category === selectedCategory) {
      setSelectedCategory(null); // Deselect if clicking the same option
    } else {
      setSelectedCategory(category);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-spill-grey-200 border-t-spill-blue-800"></div>
        <p className="text-sm text-spill-grey-400">Loading therapists...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center py-16">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-spill-red-100 rounded-full mb-4">
          <svg className="w-8 h-8 text-spill-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h2 className="font-display font-bold text-xl leading-[26px] tracking-[-0.4px] text-black mb-2">Unable to load therapists</h2>
        <p className="text-spill-grey-600 mb-4">Please check your connection and try again.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          aria-label="Refresh page to reload therapists"
          className="px-6 py-3 text-sm font-semibold text-white bg-black rounded-lg hover:bg-spill-grey-600 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400"
        >
          Refresh Page
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Hero band — full-bleed under the header */}
      <div className="bg-spill-teal-100 border-b border-spill-teal-200">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 md:py-12">
          <h1 className="font-display font-bold text-[40px] leading-[52px] tracking-[-0.8px] text-black mb-3">
            {hero.heading}
          </h1>
          {hero.body ? (
            <>
              <div
                className={`prose max-w-none text-base tracking-[-0.31px] leading-normal text-spill-grey-600 prose-p:my-2 prose-p:text-spill-grey-600 prose-headings:text-black prose-headings:font-display prose-strong:text-black prose-a:text-spill-blue-800 ${
                  !isIntroExpanded && hero.body.length > INTRO_COLLAPSE_THRESHOLD ? 'line-clamp-2' : ''
                }`}
              >
                <ReactMarkdown>{hero.body}</ReactMarkdown>
              </div>
              {hero.body.length > INTRO_COLLAPSE_THRESHOLD && (
                <button
                  type="button"
                  onClick={() => setIsIntroExpanded(!isIntroExpanded)}
                  className="mt-2 text-sm font-medium text-spill-blue-800 hover:underline flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
                  aria-expanded={isIntroExpanded}
                >
                  {isIntroExpanded ? 'Show less' : 'Read more'}
                  <svg
                    className={`w-4 h-4 transition-transform ${isIntroExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              )}
            </>
          ) : (
            <p className="text-base tracking-[-0.31px] leading-normal text-spill-grey-600">
              {DEFAULT_HERO_PARAGRAPH}
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-9 pb-6 w-full">
        {/* Filter Bar - Areas of Focus */}
        {areasOfFocusOptions.length > 0 && (
          <FilterBar
            categories={areasOfFocusOptions}
            selectedCategory={selectedCategory}
            onFilterChange={handleFilterChange}
          />
        )}

        {/* Therapist Grid */}
        {activeTherapists.length === 0 ? (
          // Directory is completely empty — no therapists currently
          // accepting bookings. Show the full holding page, not the
          // compact "no results for filter" empty state.
          <HoldingPage />
        ) : filteredTherapists.length === 0 ? (
          // Active therapists exist, but the current filter has narrowed
          // the list to zero. Keep the compact empty state with a
          // "Clear filter" affordance — the visitor's next move is to
          // broaden the filter, not give up.
          <div className="text-center py-16">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-spill-grey-100 rounded-full mb-4">
              <svg className="w-8 h-8 text-spill-grey-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <h2 className="font-display font-bold text-xl leading-[26px] tracking-[-0.4px] text-black mb-2">No therapists found</h2>
            <p className="text-spill-grey-600">
              No therapists available for &ldquo;{selectedCategory}&rdquo;. Try a different filter.
            </p>
            <button
              type="button"
              onClick={() => setSelectedCategory(null)}
              aria-label={`Clear filter for ${selectedCategory}`}
              className="mt-4 px-4 py-2 text-sm font-medium text-spill-blue-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
            >
              Clear filter
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm text-spill-grey-400 mb-5">
              Showing {filteredTherapists.length} therapist{filteredTherapists.length !== 1 ? 's' : ''}
              {selectedCategory && ` for "${selectedCategory}"`}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {filteredTherapists.map((therapist) => (
                <TherapistCard key={therapist.id} therapist={therapist} voucher={voucherEnabled ? voucher : undefined} voucherRequired={voucherRequired} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
