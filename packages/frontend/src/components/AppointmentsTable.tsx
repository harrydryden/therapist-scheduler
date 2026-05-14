/**
 * Single flat table of appointments for the scheduling dashboard.
 *
 * Replaces the previous "therapist group → appointment children" tree
 * on the left of a two-column layout. Each row contains all the
 * at-a-glance information for one appointment; row click opens a drawer
 * with the full control surface. Group-by-therapist remains available
 * via a toggle in the parent page (falls back to TherapistGroupList).
 *
 * Virtualises via react-window once the list exceeds VIRTUALIZATION_THRESHOLD
 * — same mechanism the group view uses. Sort + filtering are owned by the
 * parent; this component is a pure presentation of `appointments`.
 */

import { memo, useCallback } from 'react';
import { List, type RowComponentProps } from 'react-window';
import type { AppointmentListItem, AppointmentFilters, PaginationInfo } from '../types';
import { getStageLabel } from '../config/color-mappings';
import StatusBadge from './StatusBadge';
import HealthStatusBadge from './HealthStatusBadge';
import TherapistGroupSkeleton from './skeletons/TherapistGroupSkeleton';
import Pagination from './Pagination';

interface AppointmentsTableProps {
  appointments: AppointmentListItem[];
  filters: AppointmentFilters;
  pagination: PaginationInfo | undefined;
  loadingList: boolean;
  selectedAppointment: string | null;
  onSelectAppointment: (id: string) => void;
  onSortChange: (sortBy: 'updatedAt' | 'createdAt' | 'lastActivityAt') => void;
  onPageChange: (page: number) => void;
}

// Estimated row heights (px). Two-line cells (client/therapist, activity)
// drive the height up from the previous list's 72px row to 88px here.
const APPOINTMENT_ROW_HEIGHT = 88;

// Threshold for enabling virtualization (below this, render directly).
const VIRTUALIZATION_THRESHOLD = 30;

// ─── Row content ──────────────────────────────────────────────────────────

interface RowContentProps {
  appointment: AppointmentListItem;
  isSelected: boolean;
  onClick: () => void;
}

// Column template — drives both the row body and the sticky header.
// Keep them in sync.
//
//  Health │ Client │ Therapist │ Status │ Stage │ Next action │ Last activity │ Msgs │ Last message
//
// Widths balance the new "Next action" column (deserves real estate
// because it's the primary triage signal) against keeping client /
// therapist legible.
const GRID_TEMPLATE =
  'grid-cols-[24px_minmax(0,1.7fr)_minmax(0,1.7fr)_110px_minmax(0,1.6fr)_minmax(0,2fr)_minmax(0,1fr)_56px_minmax(0,2.4fr)]';

const RowContent = memo(function RowContent({
  appointment,
  isSelected,
  onClick,
}: RowContentProps) {
  const stageLabel = appointment.checkpointStage ? getStageLabel(appointment.checkpointStage) : '—';
  const lastActivity = formatRelativeTime(appointment.lastActivityAt);
  const lastActivityAbsolute = formatAbsoluteTime(appointment.lastActivityAt);

  // Stage column annotations: things layered on top of the base stage
  // label that operators need to spot quickly.
  const annotations: Array<{ label: string; tone: 'amber' | 'red' | 'slate' }> = [];
  if (appointment.chaseSentAt) {
    annotations.push({ label: `Chased${appointment.chaseSentTo ? ` (${appointment.chaseSentTo})` : ''}`, tone: 'amber' });
  }
  if (appointment.reschedulingInProgress) {
    annotations.push({ label: 'Rescheduling', tone: 'amber' });
  }
  if (appointment.closureRecommendedAt && !appointment.closureRecommendationActioned) {
    annotations.push({ label: 'Closure recommended', tone: 'red' });
  }
  if (appointment.humanControlEnabled) {
    annotations.push({ label: 'Human control', tone: 'slate' });
  }

  // Last-message preview labels are short prefixes — keeps the column
  // scannable. Empty snippet falls back to a placeholder.
  const latestLabel =
    appointment.lastMessagePreview === null
      ? null
      : appointment.lastMessagePreview.role === 'agent'
        ? 'Agent'
        : appointment.lastMessagePreview.role === 'admin'
          ? 'Admin'
          : 'Inbound';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      aria-label={`Open appointment for ${appointment.userName || appointment.userEmail} with ${appointment.therapistName}`}
      className={`w-full text-left border-b border-slate-100 px-3 py-2.5 grid ${GRID_TEMPLATE} gap-3 items-center transition-colors ${
        isSelected ? 'bg-spill-blue-50 ring-1 ring-spill-blue-200' : 'hover:bg-slate-50'
      }`}
      style={{ height: APPOINTMENT_ROW_HEIGHT }}
    >
      {/* Health dot */}
      <span className="flex justify-center" aria-hidden="false">
        <HealthStatusBadge status={appointment.healthStatus} score={appointment.healthScore} size="sm" />
      </span>

      {/* Client */}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900 truncate">
          {appointment.userName || '—'}
        </span>
        <span className="block text-xs text-slate-500 truncate">{appointment.userEmail}</span>
      </span>

      {/* Therapist */}
      <span className="min-w-0">
        <span className="block text-sm text-slate-900 truncate">{appointment.therapistName}</span>
        <span className="block text-xs text-slate-500 truncate">{appointment.therapistEmail}</span>
      </span>

      {/* Status */}
      <span>
        <StatusBadge status={appointment.status} />
      </span>

      {/* Stage (base label + annotation chips) */}
      <span className="min-w-0">
        <span className="block text-sm text-slate-700 truncate">{stageLabel}</span>
        {annotations.length > 0 && (
          <span className="flex flex-wrap gap-1 mt-0.5">
            {annotations.map((a) => (
              <span
                key={a.label}
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  a.tone === 'amber'
                    ? 'bg-amber-100 text-amber-800'
                    : a.tone === 'red'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-slate-100 text-slate-600'
                }`}
              >
                {a.label}
              </span>
            ))}
          </span>
        )}
      </span>

      {/* Next action — short imperative; wraps across up to 2 lines */}
      <span
        className="min-w-0 text-sm text-slate-700 leading-snug line-clamp-2"
        title={appointment.nextAction}
      >
        {appointment.nextAction}
      </span>

      {/* Last activity — relative time, with absolute on hover */}
      <span
        className="min-w-0 text-sm text-slate-600"
        title={lastActivityAbsolute ?? undefined}
      >
        {lastActivity}
      </span>

      {/* Messages in thread — just the count */}
      <span className="min-w-0 text-sm text-slate-700 text-right tabular-nums">
        {appointment.messageCount}
      </span>

      {/* Last message — role badge + snippet */}
      <span className="min-w-0">
        {latestLabel === null ? (
          <span className="block text-xs text-slate-400">No messages yet</span>
        ) : (
          <>
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium mb-0.5 ${
                latestLabel === 'Agent'
                  ? 'bg-spill-blue-100 text-spill-blue-800'
                  : latestLabel === 'Admin'
                    ? 'bg-slate-200 text-slate-700'
                    : 'bg-emerald-100 text-emerald-800'
              }`}
            >
              {latestLabel}
            </span>
            <span
              className="block text-xs text-slate-600 line-clamp-2 leading-snug"
              title={appointment.lastMessagePreview?.snippet}
            >
              {appointment.lastMessagePreview?.snippet}
            </span>
          </>
        )}
      </span>
    </button>
  );
});

// ─── Virtualised row wrapper ──────────────────────────────────────────────

interface VirtualRowProps {
  appointments: AppointmentListItem[];
  selectedAppointment: string | null;
  onSelectAppointment: (id: string) => void;
}

function VirtualRow({
  index,
  style,
  appointments,
  selectedAppointment,
  onSelectAppointment,
}: RowComponentProps<VirtualRowProps>) {
  const appointment = appointments[index];
  if (!appointment) return null;
  return (
    <div style={style}>
      <RowContent
        appointment={appointment}
        isSelected={selectedAppointment === appointment.id}
        onClick={() => onSelectAppointment(appointment.id)}
      />
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────

function HeaderCell({
  label,
  sortKey,
  currentSort,
  currentOrder,
  onSort,
  align = 'left',
  className = '',
}: {
  label: string;
  sortKey?: 'updatedAt' | 'createdAt' | 'lastActivityAt';
  currentSort?: string;
  currentOrder?: string;
  onSort?: (key: 'updatedAt' | 'createdAt' | 'lastActivityAt') => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const isSorted = sortKey && currentSort === sortKey;
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <span className={`text-[11px] font-semibold text-slate-500 uppercase tracking-wider ${alignClass} ${className}`}>
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={`inline-flex items-center gap-1 hover:text-slate-700 transition-colors ${isSorted ? 'text-slate-700' : ''}`}
        >
          {label}
          {isSorted && (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={currentOrder === 'asc' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'}
              />
            </svg>
          )}
        </button>
      ) : (
        label
      )}
    </span>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────

export default function AppointmentsTable({
  appointments,
  filters,
  pagination,
  loadingList,
  selectedAppointment,
  onSelectAppointment,
  onSortChange,
  onPageChange,
}: AppointmentsTableProps) {
  const totalAppointments = appointments.length;
  const shouldVirtualize = totalAppointments > VIRTUALIZATION_THRESHOLD;

  const handleSelect = useCallback(
    (id: string) => onSelectAppointment(id),
    [onSelectAppointment],
  );

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Sticky header — column template MUST match RowContent's GRID_TEMPLATE */}
      <div className={`sticky top-0 z-10 bg-slate-50 border-b border-slate-200 px-3 py-2 grid ${GRID_TEMPLATE} gap-3 items-center`}>
        {/*
          Health column placeholder. We can't render just
          `<span className="sr-only">…</span>` here: `sr-only` uses
          `position: absolute`, which removes the element from CSS
          Grid auto-placement entirely. That collapses the header
          into 8 grid items in 9 columns, shifting every visible
          header one slot left vs. the row body — visible
          misalignment.

          The outer `<span aria-hidden>` is a normal-flow element
          that occupies the 24px health column. The inner
          `sr-only` span retains the screen-reader label.
        */}
        <span aria-hidden="true">
          <span className="sr-only">Health</span>
        </span>
        <HeaderCell label="Client" />
        <HeaderCell label="Therapist" />
        <HeaderCell label="Status" />
        <HeaderCell label="Stage" />
        <HeaderCell label="Next action" />
        <HeaderCell
          label="Last activity"
          sortKey="lastActivityAt"
          currentSort={filters.sortBy}
          currentOrder={filters.sortOrder}
          onSort={onSortChange}
        />
        <HeaderCell label="Msgs" align="right" />
        <HeaderCell label="Last message" />
      </div>

      {/* Body */}
      {loadingList && appointments.length === 0 ? (
        <TherapistGroupSkeleton />
      ) : appointments.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-slate-500">
          No appointments in this view.
        </div>
      ) : shouldVirtualize ? (
        <div style={{ height: Math.min(totalAppointments * APPOINTMENT_ROW_HEIGHT, 720) }}>
          <List
            rowCount={totalAppointments}
            rowHeight={APPOINTMENT_ROW_HEIGHT}
            rowComponent={VirtualRow}
            rowProps={{ appointments, selectedAppointment, onSelectAppointment: handleSelect }}
          />
        </div>
      ) : (
        <div>
          {appointments.map((apt) => (
            <RowContent
              key={apt.id}
              appointment={apt}
              isSelected={selectedAppointment === apt.id}
              onClick={() => handleSelect(apt.id)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination && (
        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          limit={pagination.limit}
          onPageChange={onPageChange}
        />
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Absolute date+time string for the "Last activity" column's
 * native tooltip — gives admins the precise timestamp when the
 * relative form ("2d ago") is too coarse for triage.
 */
function formatAbsoluteTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
