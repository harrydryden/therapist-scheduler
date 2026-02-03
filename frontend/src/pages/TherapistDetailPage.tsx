import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getTherapist } from '../api/client';
import BookingForm from '../components/BookingForm';
import { sanitizeImageUrl } from '../utils/sanitize';

export default function TherapistDetailPage() {
  const { id } = useParams<{ id: string }>();

  const {
    data: therapist,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['therapist', id],
    queryFn: () => getTherapist(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (error || !therapist) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600 mb-4">Therapist not found.</p>
        <Link to="/" className="text-primary-600 hover:text-primary-700 font-medium">
          &larr; Back to all therapists
        </Link>
      </div>
    );
  }

  return (
    <div>
      <Link to="/" className="inline-flex items-center text-primary-600 hover:text-primary-700 mb-6">
        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to all therapists
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="md:flex">
              <div className="md:w-1/3">
                <div className="aspect-square bg-gray-100">
                  {sanitizeImageUrl(therapist.profileImage) ? (
                    <img src={sanitizeImageUrl(therapist.profileImage)!} alt={therapist.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      <svg className="w-24 h-24" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-6 md:w-2/3">
                <h1 className="text-2xl font-bold text-gray-900 mb-2 break-words">{therapist.name}</h1>

                <div className="flex flex-wrap gap-2 mb-4">
                  {therapist.specialisms.map((specialism) => (
                    <span
                      key={specialism}
                      className="inline-block px-3 py-1 text-sm font-medium bg-primary-100 text-primary-700 rounded-full"
                    >
                      {specialism}
                    </span>
                  ))}
                </div>

                <p className="text-gray-600 mb-4">{therapist.bio}</p>

                <div className="border-t pt-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">Availability</h3>
                  {therapist.availability && therapist.availability.slots.length > 0 ? (
                    <div className="space-y-1">
                      {therapist.availability.slots.map((slot, index) => (
                        <p key={index} className="text-sm text-gray-600">
                          <span className="font-medium">{slot.day}:</span> {slot.start} - {slot.end}
                        </p>
                      ))}
                      <p className="text-xs text-gray-500 mt-2">Timezone: {therapist.availability.timezone}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-600">{therapist.availabilitySummary}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar with booking form */}
        <div className="lg:col-span-1">
          <div className="sticky top-8">
            <BookingForm therapist={therapist} />
          </div>
        </div>
      </div>
    </div>
  );
}
