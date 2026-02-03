interface FilterBarProps {
  specialisms: string[];
  selectedSpecialism: string | null;
  onFilterChange: (specialism: string | null) => void;
}

export default function FilterBar({ specialisms, selectedSpecialism, onFilterChange }: FilterBarProps) {
  return (
    <div className="mb-8">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onFilterChange(null)}
          className={`px-5 py-2 text-sm font-semibold rounded-full transition-all ${
            selectedSpecialism === null
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          All
        </button>
        {specialisms.map((specialism) => (
          <button
            key={specialism}
            onClick={() => onFilterChange(specialism)}
            className={`px-5 py-2 text-sm font-semibold rounded-full transition-all ${
              selectedSpecialism === specialism
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {specialism}
          </button>
        ))}
      </div>
    </div>
  );
}
