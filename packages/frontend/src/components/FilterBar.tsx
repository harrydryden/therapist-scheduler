import { memo } from 'react';

interface FilterBarProps {
  categories: string[];
  selectedCategory: string | null;
  onFilterChange: (category: string | null) => void;
}

const FilterBar = memo(function FilterBar({ categories, selectedCategory, onFilterChange }: FilterBarProps) {
  return (
    <nav className="mb-6" aria-label="Filter therapists by area of focus">
      <p id="filter-label" className="text-xs font-bold text-spill-grey-400 uppercase tracking-[1px] mb-3">
        Filter by area of focus
      </p>
      <div
        className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible scrollbar-hide"
        role="group"
        aria-labelledby="filter-label"
      >
        {categories.map((category) => {
          const isSelected = selectedCategory === category;
          return (
            <button
              key={category}
              onClick={() => onFilterChange(category)}
              aria-pressed={isSelected}
              aria-label={`Filter by ${category}${isSelected ? ' (selected, click to clear)' : ''}`}
              className={`shrink-0 px-[18px] py-2 text-sm font-semibold rounded-full transition-all duration-150 border focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 ${
                isSelected
                  ? 'bg-spill-blue-100 text-spill-blue-900 border-spill-blue-200'
                  : 'bg-white text-spill-grey-600 border-spill-grey-200 hover:bg-spill-grey-100'
              }`}
            >
              {category}
            </button>
          );
        })}
      </div>
    </nav>
  );
});

export default FilterBar;
