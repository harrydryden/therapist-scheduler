/**
 * Re-export shared therapist category data from @therapist-scheduler/shared,
 * plus backend-specific validation helpers and Notion property names.
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

// Backend-specific: Notion property names
export const NOTION_CATEGORY_PROPERTIES = {
  APPROACH: 'Approach',
  STYLE: 'Style',
  AREAS_OF_FOCUS: 'Areas of Focus',
} as const;
