/**
 * Therapist Categorization System
 *
 * This replaces the old "Specialisms" field with three distinct category types:
 * 1. Approach - The therapeutic tools/methods used
 * 2. Style - How the therapist works with clients
 * 3. Areas of Focus - Specific issues the therapist specializes in
 *
 * Each category has a type name and an explainer description for tooltips.
 */

export interface CategoryOption {
  type: string;
  explainer: string;
}

export interface TherapistCategories {
  approach: string[];
  style: string[];
  areasOfFocus: string[];
}

// Approach - The therapeutic tools/methods used
export const APPROACH_OPTIONS: CategoryOption[] = [
  {
    type: 'Cognitive & Behavioural (CBT)',
    explainer: 'Focuses on changing current thought patterns and behaviors.',
  },
  {
    type: 'Mindfulness',
    explainer: 'Using awareness and breathing techniques to manage stress and stay present.',
  },
  {
    type: 'Integrative / Holistic',
    explainer: 'Uses a mix of different methods tailored to you.',
  },
  {
    type: 'Person-Centred',
    explainer: 'A supportive, non-judgmental space to explore your own feelings.',
  },
];

// Style - How the therapist works with clients
export const STYLE_OPTIONS: CategoryOption[] = [
  {
    type: 'Directive / Guiding',
    explainer: 'The therapist leads the session, gives advice, or sets homework.',
  },
  {
    type: 'Solution Focused',
    explainer: 'Focuses on future goals and practical steps rather than the past.',
  },
  {
    type: 'Relational',
    explainer: 'Uses the trust and bond between you and the therapist to help you heal.',
  },
  {
    type: 'Working at Depth',
    explainer: 'Looks at deep-rooted patterns and unconscious causes.',
  },
];

// Areas of Focus - Specific issues the therapist specializes in
export const AREAS_OF_FOCUS_OPTIONS: CategoryOption[] = [
  {
    type: 'Mental Health & Mood',
    explainer: 'Anxiety, Depression, Self-Confidence, Perfectionism. Support for low mood, worry, and self-esteem issues.',
  },
  {
    type: 'Trauma & Crisis',
    explainer: 'Trauma, PTSD, Self-Harm, Substance Misuse. Support for shock, abuse, addiction, and acute distress.',
  },
  {
    type: 'Life Stages & Work',
    explainer: 'Bereavement, Life Transitions, Career Counselling, Work Stress, Divorce. Navigating big changes, grief, and professional pressure.',
  },
  {
    type: 'Family & Relationships',
    explainer: 'Family, Parenting, Relationships, Sex. Issues involving partners, parents, children, and intimacy.',
  },
  {
    type: 'Pregnancy & Post-Natal',
    explainer: 'Pregnancy, Post-Partum Depression. Specific support for before and after birth.',
  },
  {
    type: 'Identity & Body',
    explainer: 'Neurodiversity, Gender, Sexuality, Race, Body Image. Exploring who you are, your physical self, and your lived experience.',
  },
];

// Combined lookup for all categories
export const ALL_CATEGORY_OPTIONS = {
  approach: APPROACH_OPTIONS,
  style: STYLE_OPTIONS,
  areasOfFocus: AREAS_OF_FOCUS_OPTIONS,
} as const;

// Helper to get explainer for a category type
export function getExplainer(
  categoryType: 'approach' | 'style' | 'areasOfFocus',
  typeName: string
): string | undefined {
  const options = ALL_CATEGORY_OPTIONS[categoryType];
  const option = options.find(
    (o) => o.type.toLowerCase() === typeName.toLowerCase()
  );
  return option?.explainer;
}

// Category display labels
export const CATEGORY_LABELS = {
  approach: 'Approach',
  style: 'Style',
  areasOfFocus: 'Areas of Focus',
} as const;

// Category colors for badges
export const CATEGORY_COLORS = {
  approach: 'bg-violet-100 text-violet-800 border-violet-200',
  style: 'bg-amber-100 text-amber-800 border-amber-200',
  areasOfFocus: 'bg-primary-50 text-teal-800 border-teal-200',
} as const;
