import { CATEGORY_COLORS } from '../../config/therapist-categories';

export interface GeneralBadgeProps {
  categoryType: 'approach' | 'style' | 'areasOfFocus';
}

export function GeneralBadge({ categoryType }: GeneralBadgeProps) {
  const colorClass = CATEGORY_COLORS[categoryType];

  return (
    <span
      className={`inline-block px-2.5 py-0.5 text-xs font-medium rounded-full border ${colorClass}`}
    >
      General
    </span>
  );
}
