import { memo, useMemo, useCallback } from 'react';
import { List, type RowComponentProps } from 'react-window';
import type { AppointmentListItem, AppointmentFilters, PaginationInfo } from '../types';
import { getStatusColor, getStageLabel } from '../config/color-mappings';
import HealthStatusBadge from './HealthStatusBadge';
import TherapistGroupSkeleton from './skeletons/TherapistGroupSkeleton';
import Pagination from './Pagination';

// Group appointments by therapist
interface TherapistGroup {
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  appointments: AppointmentListItem[];
  pendingCount: number;
  negotiatingCount: number;
  confirmedCount: number;
  completedCount: number;
  healthRed: number;
  healthYellow: number;
}

interface TherapistGroupListProps {
  therapistGroups: TherapistGroup[];
  filters: AppointmentFilters;
  pagination: PaginationInfo | undefined;
  loadingList: boolean;
  selectedAppointment: string | null;
  expandedTherapists: Set<string>;
  onSelectAppointment: (id: string) => void;
  onToggleTherapist: (id: string) => void;
  onPageChange: (page: number) => void;
}

export type { TherapistGroup };

// Row types for the flattened virtual list
type FlatRow =
  | { type: 'header'; group: TherapistGroup }
  | { type: 'appointment'; apt: AppointmentListItem; groupId: string };

// Estimated row heights (px)
const HEADER_HEIGHT = 56;
const APPOINTMENT_ROW_HEIGHT = 72;

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 30;

// Row props passed to the List component
interface VirtualRowProps {
  flatRows: FlatRow[];
  expandedTherapists: Set<string>;
  selectedAppointment: string | null;
  onSelectAppointment: (id: string) => void;
  onToggleTherapist: (id: string) => void;
}

function TherapistHeaderContent({
  group,
  isExpanded,
  onToggle,
}: {
  group: TherapistGroup;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={`${group.therapistName}: ${group.appointments.length} clients. ${isExpanded ? 'Click to collapse' : 'Click to expand'}`}
      className={`w-full px-4 py-3 text-left hover:bg-slate-50 transition-colors border-b border-slate-100 ${
        group.healthRed > 0 ? 'bg-spill-red-100/50' : ''
      }`}
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 min-w-0">
          <p className="font-medium text-sm text-slate-900 truncate">{group.therapistName}</p>
          <span className="text-xs text-slate-400 flex-shrink-0">
            {group.appointments.length}
          </span>
          {group.healthRed > 0 && (
            <span className="w-2 h-2 rounded-full bg-spill-red-400 animate-pulse flex-shrink-0" />
          )}
        </div>
        <svg
          className={`w-4 h-4 text-slate-300 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </button>
  );
}

function AppointmentRowContent({
  apt,
  isSelected,
  onSelect,
}: {
  apt: AppointmentListItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  // Collect attention flags
  const flags: { label: string; color: string }[] = [];
  if (apt.isStale) flags.push({ label: 'Stale', color: 'text-spill-red-600' });
  if (apt.isStalled) flags.push({ label: 'Stalled', color: 'text-orange-600' });
  if (apt.hasToolFailure) flags.push({ label: 'Error', color: 'text-spill-red-600' });
  if (apt.closureRecommendedAt && !apt.closureRecommendationActioned) {
    flags.push({ label: 'Close?', color: 'text-spill-red-600' });
  }
  if (apt.chaseSentAt && !apt.closureRecommendedAt) {
    flags.push({ label: 'Chased', color: 'text-amber-600' });
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-label={`View appointment for ${apt.userName || apt.userEmail}`}
      aria-pressed={isSelected}
      className={`px-4 py-3 pl-6 cursor-pointer transition-colors border-b border-slate-50 ${
        isSelected
          ? 'bg-spill-blue-100 border-l-2 border-l-spill-blue-800'
          : 'bg-white hover:bg-slate-50'
      }`}
    >
      <div className="flex justify-between items-center gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <HealthStatusBadge status={apt.healthStatus} size="sm" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 truncate">
              {apt.userName || apt.userEmail}
            </p>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-0.5">
              {apt.checkpointStage &&
                apt.status !== 'confirmed' &&
                apt.status !== 'cancelled' && (
                  <span>{getStageLabel(apt.checkpointStage)}</span>
                )}
              {apt.status === 'confirmed' && apt.confirmedDateTime && (
                <span className="text-spill-teal-600 font-medium">{apt.confirmedDateTime}</span>
              )}
              <span>{apt.messageCount} msgs</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Attention flags as dots/labels */}
          {flags.length > 0 && (
            <span className={`text-[10px] font-medium ${flags[0].color}`}>
              {flags[0].label}
            </span>
          )}
          {apt.humanControlEnabled && (
            <span className="text-[10px] font-medium text-orange-600">
              HC
            </span>
          )}
          <span
            className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${getStatusColor(apt.status)}`}
          >
            {apt.status}
          </span>
        </div>
      </div>
    </div>
  );
}

// react-window v2 row component
function VirtualRow(props: RowComponentProps<VirtualRowProps>) {
  const {
    index,
    style,
    flatRows,
    expandedTherapists,
    selectedAppointment,
    onSelectAppointment,
    onToggleTherapist,
  } = props;
  const row = flatRows[index];
  if (!row) return null;

  if (row.type === 'header') {
    return (
      <div style={style}>
        <TherapistHeaderContent
          group={row.group}
          isExpanded={expandedTherapists.has(row.group.therapistNotionId)}
          onToggle={() => onToggleTherapist(row.group.therapistNotionId)}
        />
      </div>
    );
  }

  return (
    <div style={style}>
      <AppointmentRowContent
        apt={row.apt}
        isSelected={selectedAppointment === row.apt.id}
        onSelect={() => onSelectAppointment(row.apt.id)}
      />
    </div>
  );
}

// Non-virtualized row rendering for small lists
function renderStaticRow(
  row: FlatRow,
  expandedTherapists: Set<string>,
  selectedAppointment: string | null,
  onSelectAppointment: (id: string) => void,
  onToggleTherapist: (id: string) => void
) {
  if (row.type === 'header') {
    return (
      <div key={`header-${row.group.therapistNotionId}`}>
        <TherapistHeaderContent
          group={row.group}
          isExpanded={expandedTherapists.has(row.group.therapistNotionId)}
          onToggle={() => onToggleTherapist(row.group.therapistNotionId)}
        />
      </div>
    );
  }
  return (
    <div key={row.apt.id}>
      <AppointmentRowContent
        apt={row.apt}
        isSelected={selectedAppointment === row.apt.id}
        onSelect={() => onSelectAppointment(row.apt.id)}
      />
    </div>
  );
}

export default memo(function TherapistGroupList({
  therapistGroups,
  filters,
  pagination,
  loadingList,
  selectedAppointment,
  expandedTherapists,
  onSelectAppointment,
  onToggleTherapist,
  onPageChange,
}: TherapistGroupListProps) {
  // Flatten groups into a single row list for virtualization
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const group of therapistGroups) {
      rows.push({ type: 'header', group });
      if (expandedTherapists.has(group.therapistNotionId)) {
        for (const apt of group.appointments) {
          rows.push({ type: 'appointment', apt, groupId: group.therapistNotionId });
        }
      }
    }
    return rows;
  }, [therapistGroups, expandedTherapists]);

  const getRowHeight = useCallback(
    (index: number) => {
      const row = flatRows[index];
      return row?.type === 'header' ? HEADER_HEIGHT : APPOINTMENT_ROW_HEIGHT;
    },
    [flatRows]
  );

  const useVirtualization = flatRows.length > VIRTUALIZATION_THRESHOLD;

  const rowProps = useMemo<VirtualRowProps>(
    () => ({
      flatRows,
      expandedTherapists,
      selectedAppointment,
      onSelectAppointment,
      onToggleTherapist,
    }),
    [flatRows, expandedTherapists, selectedAppointment, onSelectAppointment, onToggleTherapist]
  );

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {loadingList ? (
        <TherapistGroupSkeleton />
      ) : therapistGroups.length === 0 ? (
        <div className="p-8 text-center text-slate-400 text-sm">No appointments found</div>
      ) : useVirtualization ? (
        <List
          rowComponent={VirtualRow}
          rowCount={flatRows.length}
          rowHeight={getRowHeight}
          rowProps={rowProps}
          overscanCount={3}
          style={{ height: 560 }}
        />
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          {flatRows.map((row) =>
            renderStaticRow(
              row,
              expandedTherapists,
              selectedAppointment,
              onSelectAppointment,
              onToggleTherapist
            )
          )}
        </div>
      )}

      <Pagination
        page={filters.page ?? 1}
        totalPages={Math.ceil((pagination?.total ?? 0) / (filters.limit ?? 20))}
        onPageChange={onPageChange}
      />
    </div>
  );
});
