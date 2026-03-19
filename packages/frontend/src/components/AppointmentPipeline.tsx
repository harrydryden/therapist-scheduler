import { memo, useMemo } from 'react';
import type { DashboardStats, AppointmentListItem } from '../types';
import { PRE_BOOKING_STATUSES } from '../types';

export type DashboardTileFilter =
  | 'active'
  | 'confirmed'
  | 'post-session'
  | 'attention'
  | 'human'
  | null;

interface AppointmentPipelineProps {
  stats: DashboardStats | undefined;
  appointments: AppointmentListItem[] | undefined;
  selectedTile: DashboardTileFilter;
  onTileSelect: (tile: DashboardTileFilter) => void;
}

interface TileConfig {
  key: DashboardTileFilter;
  label: string;
  count: number;
  sublabel: string;
  accent: string;
  selectedBg: string;
  selectedBorder: string;
  selectedText: string;
  pulse?: boolean;
}

export default memo(function AppointmentPipeline({
  stats,
  appointments,
  selectedTile,
  onTileSelect,
}: AppointmentPipelineProps) {
  const counts = useMemo(() => {
    if (!appointments || !stats) {
      return {
        active: 0,
        pending: 0,
        contacted: 0,
        negotiating: 0,
        confirmed: 0,
        postSession: 0,
        attention: 0,
        human: 0,
        cancelled: 0,
        confirmedWeek: 0,
      };
    }

    const preBookingStatuses = PRE_BOOKING_STATUSES as readonly string[];
    let attention = 0;
    let human = 0;

    for (const apt of appointments) {
      if (preBookingStatuses.includes(apt.status) && apt.healthStatus === 'red') {
        attention++;
      }
      if (apt.humanControlEnabled) {
        human++;
      }
    }

    return {
      active:
        (stats.byStatus.pending || 0) +
        (stats.byStatus.contacted || 0) +
        (stats.byStatus.negotiating || 0),
      pending: stats.byStatus.pending || 0,
      contacted: stats.byStatus.contacted || 0,
      negotiating: stats.byStatus.negotiating || 0,
      confirmed: stats.byStatus.confirmed || 0,
      postSession:
        (stats.byStatus.session_held || 0) +
        (stats.byStatus.feedback_requested || 0) +
        (stats.byStatus.completed || 0),
      attention,
      human,
      cancelled: stats.byStatus.cancelled || 0,
      confirmedWeek: stats.confirmedLast7Days || 0,
    };
  }, [appointments, stats]);

  if (!stats) return null;

  const tiles: TileConfig[] = [
    {
      key: 'active',
      label: 'Active',
      count: counts.active,
      sublabel: `${counts.pending} pending · ${counts.contacted} contacted · ${counts.negotiating} negotiating`,
      accent: 'text-spill-blue-800',
      selectedBg: 'bg-spill-blue-100',
      selectedBorder: 'border-spill-blue-800',
      selectedText: 'text-spill-blue-900',
    },
    {
      key: 'confirmed',
      label: 'Confirmed',
      count: counts.confirmed,
      sublabel: `${counts.confirmedWeek} this week`,
      accent: 'text-spill-teal-600',
      selectedBg: 'bg-spill-teal-100',
      selectedBorder: 'border-spill-teal-600',
      selectedText: 'text-spill-teal-600',
    },
    {
      key: 'post-session',
      label: 'Post-Session',
      count: counts.postSession,
      sublabel: 'session held · feedback · completed',
      accent: 'text-purple-600',
      selectedBg: 'bg-purple-50',
      selectedBorder: 'border-purple-600',
      selectedText: 'text-purple-700',
    },
    {
      key: 'attention',
      label: 'Needs Attention',
      count: counts.attention,
      sublabel: 'unhealthy conversations',
      accent: 'text-spill-red-600',
      selectedBg: 'bg-spill-red-100',
      selectedBorder: 'border-spill-red-600',
      selectedText: 'text-spill-red-600',
      pulse: counts.attention > 0,
    },
    {
      key: 'human',
      label: 'Human Control',
      count: counts.human,
      sublabel: 'manual override active',
      accent: 'text-orange-600',
      selectedBg: 'bg-orange-50',
      selectedBorder: 'border-orange-500',
      selectedText: 'text-orange-700',
    },
  ];

  const handleTileClick = (key: DashboardTileFilter) => {
    onTileSelect(selectedTile === key ? null : key);
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
      {tiles.map((tile) => {
        const isSelected = selectedTile === tile.key;
        return (
          <button
            key={tile.key}
            onClick={() => handleTileClick(tile.key)}
            className={`
              relative text-left rounded-xl p-4 transition-all border-2
              ${isSelected
                ? `${tile.selectedBg} ${tile.selectedBorder} shadow-sm`
                : 'bg-white border-transparent shadow-sm hover:border-slate-200'
              }
            `}
          >
            {/* Pulse indicator for attention */}
            {tile.pulse && !isSelected && (
              <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-spill-red-400 animate-pulse" />
            )}

            <p className={`text-xs font-medium uppercase tracking-wide mb-1 ${
              isSelected ? tile.selectedText : 'text-slate-500'
            }`}>
              {tile.label}
            </p>

            <p className={`text-2xl font-bold mb-1 ${
              isSelected ? tile.selectedText : tile.accent
            }`}>
              {tile.count}
            </p>

            <p className={`text-xs leading-snug ${
              isSelected ? tile.selectedText + ' opacity-70' : 'text-slate-400'
            }`}>
              {tile.sublabel}
            </p>
          </button>
        );
      })}

      {/* Cancelled count - small, inline, non-tile */}
      {counts.cancelled > 0 && (
        <div className="col-span-full flex items-center gap-2 text-xs text-slate-400 px-1">
          <span>{counts.cancelled} cancelled</span>
          <span>·</span>
          <span>{stats.totalRequests} total requests</span>
        </div>
      )}
    </div>
  );
});
