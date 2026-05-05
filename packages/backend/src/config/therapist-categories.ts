/**
 * Re-export shared therapist category data from @therapist-scheduler/shared
 * plus backend-specific validation helpers. The previous NOTION_CATEGORY_PROPERTIES
 * export has been retired alongside the Notion deprecation (PR 2).
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

import {
  APPROACH_OPTIONS,
  STYLE_OPTIONS,
  AREAS_OF_FOCUS_OPTIONS,
} from '@therapist-scheduler/shared/config/therapist-categories';

// Backend-specific: all valid type names for validation
export const VALID_APPROACH_TYPES = APPROACH_OPTIONS.map((o) => o.type);
export const VALID_STYLE_TYPES = STYLE_OPTIONS.map((o) => o.type);
export const VALID_AREAS_OF_FOCUS_TYPES = AREAS_OF_FOCUS_OPTIONS.map((o) => o.type);
