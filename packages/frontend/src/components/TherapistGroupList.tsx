import { memo, useMemo, useCallback } from 'react';
import { List, type RowComponentProps } from 'react-window';
import type { AppointmentListItem, AppointmentFilters, PaginationInfo } from '../types';
import { getStatusColor, getStageLabel } from '../config/color-mappings';
import HealthStatusBadge from './HealthStatusBadge';
import TherapistGroupSkeleton from './skeletons/TherapistGroupSkeleton';

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
const HEADER_HEIGHT = 76;
const APPOINTMENT_ROW_HEIGHT = 120;

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
  const hasMultipleUsers = group.appointments.length > 1;

  return (
    <button
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={`${group.therapistName}: ${group.appointments.length} clients. ${isExpanded ? 'Click to collapse' : 'Click to expand'}`}
      className={`w-full p-4 text-left hover:bg-slate-50 transition-colors border-b border-slate-100 ${
        group.healthRed > 0 ? 'bg-spill-red-100' : group.healthYellow > 0 ? 'bg-spill-yellow-50' : ''
      }`}
    >
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-slate-900">{group.therapistName}</p>
            {group.healthRed > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-red-200 text-spill-red-600">
                {group.healthRed} need attention
              </span>
            )}
            {group.healthYellow > 0 && group.healthRed === 0 && (
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-yellow-200 text-spill-yellow-600">
                {group.healthYellow} monitoring
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 mt-0.5">
            {group.appointments.length} client{group.appointments.length !== 1 ? 's' : ''}
            {group.pendingCount > 0 && ` • ${group.pendingCount} pending`}
            {group.negotiatingCount > 0 && ` • ${group.negotiatingCount} negotiating`}
            {group.confirmedCount > 0 && ` • ${group.confirmedCount} confirmed`}
            {group.completedCount > 0 && ` • ${group.completedCount} completed`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasMultipleUsers && (
            <span className="px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-800">
              {group.appointments.length} users
            </span>
          )}
          <svg
            className={`w-5 h-5 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
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
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      aria-label={`View appointment for ${apt.userName || apt.userEmail}`}
      aria-pressed={isSelected}
      className={`p-4 pl-8 cursor-pointer hover:bg-slate-100 transition-colors bg-slate-50 border-b border-slate-100 h-full ${
        isSelected ? 'bg-primary-50 border-l-4 border-l-spill-blue-800' : ''
      }`}
    >
      <div className="flex justify-between items-start mb-1">
        <div className="flex items-start gap-2">
          <div className="pt-1.5">
            <HealthStatusBadge status={apt.healthStatus} size="sm" />
          </div>
          <div>
            <p className="font-medium text-slate-900">
              {apt.userName || apt.userEmail}
            </p>
            <p className="text-xs text-slate-500">{apt.userEmail}</p>
          </div>
        </div>
        <div className="flex flex-col gap-1 items-end">
          {apt.status !== 'confirmed' && apt.status !== 'cancelled' && apt.checkpointProgress > 0 && (
            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-blue-100 text-spill-blue-800">
              {apt.checkpointProgress}%
            </span>
          )}
          <span
            className={`px-2 py-0.5 text-xs font-medium rounded-full ${getStatusColor(apt.status)}`}
          >
            {apt.status}
          </span>
          {apt.humanControlEnabled && (
            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-orange-100 text-orange-800">
              Human
            </span>
          )}
        </div>
      </div>
      {apt.checkpointStage && apt.status !== 'confirmed' && apt.status !== 'cancelled' && (
        <p className="text-xs text-slate-600 mb-1 pl-4">
          Stage: {getStageLabel(apt.checkpointStage)}
        </p>
      )}
      <div className="flex flex-wrap gap-1 mb-1 pl-4">
        {apt.isStale && (
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800">
            Stale
          </span>
        )}
        {apt.isStalled && (
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-orange-100 text-orange-800">
            Stalled
          </span>
        )}
        {apt.hasThreadDivergence && (
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-800">
            Diverged
          </span>
        )}
        {apt.hasToolFailure && (
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800">
            Tool Error
          </span>
        )}
      </div>
      <div className="flex gap-3 text-xs text-slate-500 pl-4">
        <span>{apt.messageCount} msgs</span>
        <span>{new Date(apt.updatedAt).toLocaleDateString()}</span>
      </div>
      {apt.status === 'confirmed' && apt.confirmedDateTime && (
        <p className="text-xs text-green-600 mt-1 font-medium pl-4">
          Booked: {apt.confirmedDateTime}
        </p>
      )}
    </div>
  );
}

// react-window v2 row component
// RowComponentProps<VirtualRowProps> includes index + style + ariaAttributes + our custom props
function VirtualRow(props: RowComponentProps<VirtualRowProps>) {
  const { index, style, flatRows, expandedTherapists, selectedAppointment, onSelectAppointment, onToggleTherapist } = props;
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
  onToggleTherapist: (id: string) => void,
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
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
      <div className="p-4 border-b border-slate-100">
        <h2 className="font-semibold text-slate-900">By Therapist</h2>
        <p className="text-sm text-slate-500">
          {therapistGroups.length} therapist{therapistGroups.length !== 1 ? 's' : ''}
          {therapistGroups.reduce((sum, g) => sum + g.pendingCount + g.negotiatingCount, 0) > 0 &&
            ` • ${therapistGroups.reduce((sum, g) => sum + g.pendingCount + g.negotiatingCount, 0)} active conversations`}
        </p>
      </div>

      {/* Pagination Controls */}
      {pagination && pagination.total > 0 && (
        <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <span className="text-sm text-slate-600">
            {pagination.total <= (filters.limit ?? 20) ? (
              `Showing all ${pagination.total} appointment${pagination.total !== 1 ? 's' : ''}`
            ) : (
              `Showing ${(((filters.page ?? 1) - 1) * (filters.limit ?? 20)) + 1}-${Math.min((filters.page ?? 1) * (filters.limit ?? 20), pagination.total)} of ${pagination.total}`
            )}
          </span>
          {pagination.total > (filters.limit ?? 20) && (
            <div className="flex gap-2">
              <button
                onClick={() => onPageChange((filters.page ?? 1) - 1)}
                disabled={(filters.page ?? 1) <= 1}
                aria-label="Previous page"
                className="px-3 py-1 text-sm border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                &larr; Prev
              </button>
              <span className="px-3 py-1 text-sm text-slate-600">
                Page {filters.page ?? 1} of {Math.ceil(pagination.total / (filters.limit ?? 20))}
              </span>
              <button
                onClick={() => onPageChange((filters.page ?? 1) + 1)}
                disabled={(filters.page ?? 1) >= Math.ceil(pagination.total / (filters.limit ?? 20))}
                aria-label="Next page"
                className="px-3 py-1 text-sm border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next &rarr;
              </button>
            </div>
          )}
        </div>
      )}

      {loadingList ? (
        <TherapistGroupSkeleton />
      ) : therapistGroups.length === 0 ? (
        <div className="p-8 text-center text-slate-500">No appointments found</div>
      ) : useVirtualization ? (
        // Virtual scrolling for large lists (30+ rows)
        <List
          rowComponent={VirtualRow}
          rowCount={flatRows.length}
          rowHeight={getRowHeight}
          rowProps={rowProps}
          overscanCount={5}
          style={{ height: 600 }}
        />
      ) : (
        // Standard rendering for small lists
        <div className="max-h-[600px] overflow-y-auto">
          {flatRows.map((row) =>
            renderStaticRow(row, expandedTherapists, selectedAppointment, onSelectAppointment, onToggleTherapist)
          )}
        </div>
      )}
    </div>
  );
});
