import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTherapists } from '../api/client';
import TherapistCard from '../components/TherapistCard';
import FilterBar from '../components/FilterBar';

export default function TherapistsPage() {
  const [selectedSpecialism, setSelectedSpecialism] = useState<string | null>(null);

  const {
    data: therapists,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['therapists'],
    queryFn: getTherapists,
  });

  // Filter to only show active therapists
  const activeTherapists = useMemo(() => {
    if (!therapists) return [];
    return therapists.filter((t) => t.active);
  }, [therapists]);

  // Extract unique specialisms from active therapists only
  const allSpecialisms = useMemo(() => {
    const specialismSet = new Set<string>();
    activeTherapists.forEach((t) => t.specialisms.forEach((s) => specialismSet.add(s)));
    return Array.from(specialismSet).sort();
  }, [activeTherapists]);

  // Filter therapists by selected specialism
  const filteredTherapists = useMemo(() => {
    if (!selectedSpecialism) return activeTherapists;
    return activeTherapists.filter((t) => t.specialisms.includes(selectedSpecialism));
  }, [activeTherapists, selectedSpecialism]);

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
          onClick={() => window.location.reload()}
          className="px-6 py-3 text-sm font-semibold text-white bg-teal-500 rounded-full hover:bg-teal-600 transition-colors"
        >
          Refresh Page
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Filter Bar */}
      {allSpecialisms.length > 0 && (
        <FilterBar
          specialisms={allSpecialisms}
          selectedSpecialism={selectedSpecialism}
          onFilterChange={setSelectedSpecialism}
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
            {selectedSpecialism
              ? `No therapists available for "${selectedSpecialism}". Try a different filter.`
              : 'No therapists are currently available. Please check back soon.'}
          </p>
          {selectedSpecialism && (
            <button
              onClick={() => setSelectedSpecialism(null)}
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
            {selectedSpecialism && ` specializing in ${selectedSpecialism}`}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {filteredTherapists.map((therapist) => (
              <TherapistCard key={therapist.id} therapist={therapist} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
