import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getTherapist } from '../api/client';
import BookingForm from '../components/BookingForm';
import { sanitizeImageUrl } from '../utils/sanitize';
import {
  APPROACH_OPTIONS,
  STYLE_OPTIONS,
  AREAS_OF_FOCUS_OPTIONS,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type CategoryOption,
} from '../config/therapist-categories';
import { useVoucher } from '../hooks/useVoucher';
import { getFrontendSettings } from '../api/client';
import { getCountryFlag, getCountryLabel } from '@therapist-scheduler/shared';
import placeholderImage from '../assets/placeholder-spill-grey.png';

// Shared markup for the three category groups — same eyebrow label +
// pill badge treatment as the directory cards.
function CategoryGroup({
  label,
  items,
  options,
  categoryType,
}: {
  label: string;
  items: string[];
  options: readonly CategoryOption[];
  categoryType: keyof typeof CATEGORY_COLORS;
}) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div>
      <span className="text-[11px] font-bold text-spill-grey-400 uppercase tracking-[0.8px] block mb-1.5">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => {
          const option = options.find((o) => o.type === item);
          return (
            <span
              key={item}
              className={`inline-block px-2.5 py-[3px] text-xs font-medium rounded-full border cursor-help ${CATEGORY_COLORS[categoryType]}`}
              title={option?.explainer}
            >
              {item}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function TherapistDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data: frontendSettings } = useQuery({
    queryKey: ['frontendSettings'],
    queryFn: getFrontendSettings,
    staleTime: 5 * 60 * 1000,
  });
  const voucherEnabled = frontendSettings?.['voucher.enabled'] ?? false;
  const voucherRequired = frontendSettings?.['voucher.required'] ?? false;
  const voucherExpiryDays = frontendSettings?.['voucher.expiryDays'] ?? 14;

  const voucher = useVoucher(voucherExpiryDays);

  const {
    data: therapist,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['therapist', id],
    queryFn: () => getTherapist(id!),
    enabled: !!id,
    staleTime: 5 * 60 * 1000, // Cache for 5 min to avoid refetch on back-navigation
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-12 w-12 border-2 border-spill-grey-200 border-t-spill-blue-800"></div>
      </div>
    );
  }

  if (error || !therapist) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center py-12">
        <p className="text-spill-red-600 mb-4">Therapist not found.</p>
        <Link to="/" className="text-spill-blue-800 hover:underline font-medium">
          &larr; Back to all therapists
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-7 w-full">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm font-medium text-spill-blue-800 hover:underline mb-6 focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to all therapists
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl border border-spill-grey-200 overflow-hidden">
            <div className="md:flex">
              <div className="md:w-1/3">
                {/* Full-width square photos swallow the whole first
                    viewport on phones — use a shorter crop below md. */}
                <div className="aspect-[4/3] md:aspect-square bg-spill-grey-100">
                  <img
                    src={sanitizeImageUrl(therapist.profileImage) ?? placeholderImage}
                    alt={therapist.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>

              <div className="p-7 md:w-2/3">
                <div className="flex items-baseline gap-2.5 flex-wrap mb-1.5">
                  <h2 className="font-display font-bold text-3xl leading-[39px] tracking-[-0.6px] text-black break-words">
                    {therapist.name}
                  </h2>
                  <span className="text-sm text-spill-grey-400">
                    {getCountryFlag(therapist.country)} {getCountryLabel(therapist.country)}
                  </span>
                </div>

                <p className="text-base tracking-[-0.31px] leading-normal text-spill-grey-600 mb-5">{therapist.bio}</p>

                {/* Categories */}
                <div className="flex flex-col gap-3.5 mb-5">
                  <CategoryGroup
                    label={CATEGORY_LABELS.approach}
                    items={therapist.approach || []}
                    options={APPROACH_OPTIONS}
                    categoryType="approach"
                  />
                  <CategoryGroup
                    label={CATEGORY_LABELS.style}
                    items={therapist.style || []}
                    options={STYLE_OPTIONS}
                    categoryType="style"
                  />
                  <CategoryGroup
                    label={CATEGORY_LABELS.areasOfFocus}
                    items={therapist.areasOfFocus || []}
                    options={AREAS_OF_FOCUS_OPTIONS}
                    categoryType="areasOfFocus"
                  />
                </div>

                <div className="border-t border-spill-grey-200 pt-4">
                  <span className="text-[11px] font-bold text-spill-grey-400 uppercase tracking-[0.8px] block mb-2">
                    Availability
                  </span>
                  {therapist.availability && Array.isArray(therapist.availability.slots) && therapist.availability.slots.length > 0 ? (
                    <div className="space-y-1">
                      {therapist.availability.slots.map((slot) => (
                        <p key={`${slot.day}-${slot.start}-${slot.end}`} className="text-sm text-spill-grey-600">
                          <span className="font-medium text-black">{slot.day}:</span> {slot.start} &ndash; {slot.end}
                        </p>
                      ))}
                      <p className="text-xs text-spill-grey-400 pt-1">Timezone: {therapist.availability.timezone}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-spill-grey-600">{therapist.availabilitySummary}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar with booking form */}
        <div className="lg:col-span-1">
          <div className="sticky top-8">
            <BookingForm therapist={therapist} voucher={voucherEnabled ? voucher : undefined} voucherRequired={voucherRequired} />
          </div>
        </div>
      </div>
    </div>
  );
}
