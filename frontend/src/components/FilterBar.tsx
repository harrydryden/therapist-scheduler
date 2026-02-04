interface FilterBarProps {
  categories: string[];
  selectedCategory: string | null;
  onFilterChange: (category: string | null) => void;
}

export default function FilterBar({ categories, selectedCategory, onFilterChange }: FilterBarProps) {
  return (
    <div className="mb-8">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
        Filter by Area of Focus
      </p>
      <div className="flex flex-wrap gap-2">
        {categories.map((category) => (
          <button
            key={category}
            onClick={() => onFilterChange(category)}
            className={`px-5 py-2 text-sm font-semibold rounded-full transition-all ${
              selectedCategory === category
                ? 'bg-teal-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {category}
          </button>
        ))}
      </div>
    </div>
  );
}
