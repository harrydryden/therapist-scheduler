import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { getTherapists, getFrontendSettings } from '../api/client';
import TherapistCard from '../components/TherapistCard';
import FilterBar from '../components/FilterBar';

export default function TherapistsPage() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

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

  // Filter to only show active therapists
  const activeTherapists = useMemo(() => {
    if (!therapists) return [];
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
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-200 border-t-teal-500"></div>
        <p className="text-sm text-slate-500">Loading therapists...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-red-100 rounded-full mb-4">
          <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-2">Unable to load therapists</h2>
        <p className="text-slate-600 mb-4">Please check your connection and try again.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          aria-label="Refresh page to reload therapists"
          className="px-6 py-3 text-sm font-semibold text-white bg-teal-500 rounded-full hover:bg-teal-600 transition-colors"
        >
          Refresh Page
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Introduction Text - from admin settings */}
      {introText && (
        <div className="mb-6 prose prose-slate prose-sm max-w-none prose-headings:text-slate-900 prose-h3:text-base prose-h3:font-semibold prose-h3:mt-4 prose-h3:mb-2 first:prose-h3:mt-0 prose-p:text-slate-600 prose-p:leading-relaxed prose-p:my-2 prose-strong:text-slate-900">
          <ReactMarkdown>{introText}</ReactMarkdown>
        </div>
      )}

      {/* Filter Bar - Areas of Focus */}
      {areasOfFocusOptions.length > 0 && (
        <FilterBar
          categories={areasOfFocusOptions}
          selectedCategory={selectedCategory}
          onFilterChange={handleFilterChange}
        />
      )}

      {/* Therapist Grid */}
      {filteredTherapists.length === 0 ? (
        <div className="text-center py-16">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-slate-100 rounded-full mb-4">
            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">No therapists found</h2>
          <p className="text-slate-600">
            {selectedCategory
              ? `No therapists available for "${selectedCategory}". Try a different filter.`
              : 'No therapists are currently available. Please check back soon.'}
          </p>
          {selectedCategory && (
            <button
              type="button"
              onClick={() => setSelectedCategory(null)}
              aria-label={`Clear filter for ${selectedCategory}`}
              className="mt-4 px-4 py-2 text-sm font-medium text-teal-600 hover:text-teal-700"
            >
              Clear filter
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500 mb-6">
            Showing {filteredTherapists.length} therapist{filteredTherapists.length !== 1 ? 's' : ''}
            {selectedCategory && ` for "${selectedCategory}"`}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 items-start">
            {filteredTherapists.map((therapist) => (
              <TherapistCard key={therapist.id} therapist={therapist} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
