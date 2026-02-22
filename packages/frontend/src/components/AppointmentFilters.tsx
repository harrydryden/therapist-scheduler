import type { AppointmentFilters as AppointmentFiltersType, AppointmentListItem } from '../types';

interface AppointmentFiltersProps {
  filters: AppointmentFiltersType;
  appointments: AppointmentListItem[] | undefined;
  hideConfirmed: boolean;
  quickFilter: 'red' | 'human' | 'post-session' | 'cancelled' | null;
  onFilterChange: (key: keyof AppointmentFiltersType, value: string) => void;
  onHideConfirmedChange: (value: boolean) => void;
  onQuickFilterChange: (value: 'red' | 'human' | 'post-session' | 'cancelled' | null) => void;
}

type FilterValue = 'all' | 'active' | 'confirmed' | 'post-session' | 'cancelled' | 'red' | 'human';

export default function AppointmentFilters({
  filters,
  appointments,
  hideConfirmed,
  quickFilter,
  onFilterChange,
  onHideConfirmedChange,
  onQuickFilterChange,
}: AppointmentFiltersProps) {
  const data = appointments || [];
  const activeAppointments = data.filter(
    (apt) => !['confirmed', 'session_held', 'feedback_requested', 'completed', 'cancelled'].includes(apt.status)
  );
  const redCount = activeAppointments.filter((apt) => apt.healthStatus === 'red').length;
  const humanCount = data.filter((apt) => apt.humanControlEnabled).length;

  // Lifecycle stage counts
  const activeCount = data.filter((apt) => ['pending', 'contacted', 'negotiating'].includes(apt.status)).length;
  const confirmedCount = data.filter((apt) => apt.status === 'confirmed').length;
  const postSessionCount = data.filter((apt) => ['session_held', 'feedback_requested', 'completed'].includes(apt.status)).length;

  // Determine current filter based on state
  let currentFilter: FilterValue = 'all';
  if (quickFilter) {
    currentFilter = quickFilter;
  } else if (hideConfirmed) {
    currentFilter = 'active';
  } else if (filters.status === 'confirmed') {
    currentFilter = 'confirmed';
  }

  const filterOptions: { value: FilterValue; label: string; count?: number; color: string; activeColor: string }[] = [
    { value: 'all', label: 'All', color: 'bg-slate-100 text-slate-600 hover:bg-slate-200', activeColor: 'bg-slate-700 text-white' },
    { value: 'active', label: 'Active', count: activeCount, color: 'bg-spill-blue-100 text-spill-blue-600 hover:bg-spill-blue-200', activeColor: 'bg-spill-blue-600 text-white' },
    { value: 'confirmed', label: 'Confirmed', count: confirmedCount, color: 'bg-spill-teal-100 text-spill-teal-600 hover:bg-spill-teal-200', activeColor: 'bg-spill-teal-600 text-white' },
    { value: 'post-session', label: 'Post-Session', count: postSessionCount, color: 'bg-purple-100 text-purple-600 hover:bg-purple-200', activeColor: 'bg-purple-600 text-white' },
    { value: 'cancelled', label: 'Cancelled', color: 'bg-slate-100 text-slate-500 hover:bg-slate-200', activeColor: 'bg-slate-500 text-white' },
  ];

  const alertOptions: { value: FilterValue; label: string; count: number; color: string; activeColor: string }[] = [
    { value: 'red', label: 'Needs Attention', count: redCount, color: 'bg-spill-red-100 text-spill-red-600 hover:bg-spill-red-200', activeColor: 'bg-spill-red-600 text-white' },
    { value: 'human', label: 'Human Control', count: humanCount, color: 'bg-orange-100 text-orange-600 hover:bg-orange-200', activeColor: 'bg-orange-600 text-white' },
  ];

  const handleFilterClick = (value: FilterValue) => {
    if (value === 'all') {
      onQuickFilterChange(null);
      onHideConfirmedChange(false);
      onFilterChange('status', '');
    } else if (value === 'active') {
      onQuickFilterChange(null);
      onHideConfirmedChange(true);
      onFilterChange('status', '');
    } else if (value === 'confirmed') {
      onQuickFilterChange(null);
      onHideConfirmedChange(false);
      onFilterChange('status', 'confirmed');
    } else if (value === 'post-session') {
      onHideConfirmedChange(false);
      onFilterChange('status', '');
      onQuickFilterChange('post-session');
    } else if (value === 'cancelled') {
      onHideConfirmedChange(false);
      onFilterChange('status', '');
      onQuickFilterChange('cancelled');
    } else if (value === 'red' || value === 'human') {
      onHideConfirmedChange(false);
      onFilterChange('status', '');
      onQuickFilterChange(currentFilter === value ? null : value);
    }
  };

  return (
    <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100 mb-6">
      {/* Primary Filters - Quick access pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        {/* Lifecycle stage filters */}
        <div className="flex gap-1.5">
          {filterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleFilterClick(opt.value)}
              className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
                currentFilter === opt.value ? opt.activeColor : opt.color
              }`}
            >
              {opt.label}{opt.count !== undefined ? ` (${opt.count})` : ''}
            </button>
          ))}
        </div>

        <div className="h-6 w-px bg-slate-200 mx-1" />

        {/* Alert filters */}
        <div className="flex gap-1.5">
          {alertOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleFilterClick(opt.value)}
              className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
                currentFilter === opt.value ? opt.activeColor : opt.color
              }`}
            >
              {opt.label} ({opt.count})
            </button>
          ))}
        </div>
      </div>

      {/* Secondary Filters - Date range and sort */}
      <div className="flex flex-wrap gap-3 items-center pt-3 border-t border-slate-100">
        <span className="text-xs text-slate-400 uppercase tracking-wide">Date Range</span>
        <input
          type="date"
          value={filters.dateFrom || ''}
          onChange={(e) => onFilterChange('dateFrom', e.target.value)}
          className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
        />
        <span className="text-slate-400">to</span>
        <input
          type="date"
          value={filters.dateTo || ''}
          onChange={(e) => onFilterChange('dateTo', e.target.value)}
          className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
        />

        <div className="h-5 w-px bg-slate-200 mx-1" />

        <select
          value={filters.sortBy || 'updatedAt'}
          onChange={(e) => onFilterChange('sortBy', e.target.value)}
          className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
        >
          <option value="updatedAt">Sort by Updated</option>
          <option value="createdAt">Sort by Created</option>
        </select>
      </div>
    </div>
  );
}
