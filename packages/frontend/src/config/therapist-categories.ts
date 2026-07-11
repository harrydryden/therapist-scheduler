/**
 * Re-export shared therapist category data from @therapist-scheduler/shared,
 * plus frontend-specific display labels and colors.
 */
export {
  type CategoryOption,
  type TherapistCategories,
  APPROACH_OPTIONS,
  STYLE_OPTIONS,
  AREAS_OF_FOCUS_OPTIONS,
  ALL_CATEGORY_OPTIONS,
  getExplainer,
} from '@therapist-scheduler/shared/config/therapist-categories';

// Frontend-specific: display labels for category sections (sentence case)
export const CATEGORY_LABELS = {
  approach: 'Approach',
  style: 'Style',
  areasOfFocus: 'Areas of focus',
} as const;

// Frontend-specific: Tailwind color classes for category badges (Spill palette).
// Text is the same dark grey across all three tints for readability; the
// background/border colour alone distinguishes the category families.
export const CATEGORY_COLORS = {
  approach: 'bg-spill-grey-100 text-spill-grey-600 border-spill-grey-200',
  style: 'bg-spill-teal-100 text-spill-grey-600 border-spill-teal-200',
  areasOfFocus: 'bg-spill-blue-100 text-spill-grey-600 border-spill-blue-200',
} as const;
