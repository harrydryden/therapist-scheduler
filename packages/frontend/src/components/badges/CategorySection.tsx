import { UI } from '../../config/constants';
import { CategoryBadge } from './CategoryBadge';
import { GeneralBadge } from './GeneralBadge';

export interface CategorySectionProps {
  label: string;
  items: string[];
  categoryType: 'approach' | 'style' | 'areasOfFocus';
  isExpanded: boolean;
  onToggle: () => void;
}

export function CategorySection({ label, items, categoryType, isExpanded, onToggle }: CategorySectionProps) {
  const hasItems = items && items.length > 0;
  const visibleItems = isExpanded ? items : items.slice(0, UI.MAX_VISIBLE_BADGES);
  const hiddenCount = items.length - UI.MAX_VISIBLE_BADGES;
  const hasMore = hiddenCount > 0;

  return (
    <div>
      <span className="text-[11px] font-bold text-spill-grey-400 uppercase tracking-[0.8px] block mb-1.5">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5 items-start content-start">
        {hasItems ? (
          <>
            {visibleItems.map((item) => (
              <CategoryBadge key={item} type={item} categoryType={categoryType} />
            ))}
            {hasMore && !isExpanded && (
              <button
                onClick={onToggle}
                aria-expanded={false}
                aria-label={`Show ${hiddenCount} more ${label.toLowerCase()} options`}
                className="inline-block px-2 py-0.5 text-xs font-medium bg-spill-grey-100 text-spill-grey-400 rounded-full hover:bg-spill-grey-200 transition-colors focus:outline-none focus:ring-2 focus:ring-spill-blue-400"
              >
                +{hiddenCount}
              </button>
            )}
            {hasMore && isExpanded && (
              <button
                onClick={onToggle}
                aria-expanded={true}
                aria-label={`Show fewer ${label.toLowerCase()} options`}
                className="inline-block px-2 py-0.5 text-xs font-medium text-spill-blue-800 hover:text-spill-blue-400 focus:outline-none focus:ring-2 focus:ring-spill-blue-400 rounded"
              >
                Less
              </button>
            )}
          </>
        ) : (
          <GeneralBadge categoryType={categoryType} />
        )}
      </div>
    </div>
  );
}
