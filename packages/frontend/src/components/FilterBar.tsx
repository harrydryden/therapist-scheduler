import { memo } from 'react';

interface FilterBarProps {
  categories: string[];
  selectedCategory: string | null;
  onFilterChange: (category: string | null) => void;
}

const FilterBar = memo(function FilterBar({ categories, selectedCategory, onFilterChange }: FilterBarProps) {
  return (
    <nav className="mb-8" aria-label="Filter therapists by area of focus">
      <p id="filter-label" className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
        Filter by Area of Focus
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
              className={`shrink-0 px-5 py-2 text-sm font-semibold rounded-full transition-all border focus:outline-none focus:ring-2 focus:ring-spill-blue-400 focus:ring-offset-2 ${
                isSelected
                  ? 'bg-spill-blue-200 text-spill-blue-900 border-spill-blue-200'
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
