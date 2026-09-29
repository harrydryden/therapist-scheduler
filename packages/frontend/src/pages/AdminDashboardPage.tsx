import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  getAppointments,
  getAppointmentDetail,
  getDashboardStats,
  getCeilingTrippedCount,
  releaseCeilingTripped,
} from '../api/client';
import { useDebounce } from '../hooks/useDebounce';
import { useSSE } from '../hooks/useSSE';
import AppointmentPipeline from '../components/AppointmentPipeline';
import TherapistGroupList from '../components/TherapistGroupList';
import type { TherapistGroup } from '../components/TherapistGroupList';
import AppointmentsTable from '../components/AppointmentsTable';
import AppointmentDetailDrawer from '../components/AppointmentDetailDrawer';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToastContext } from '../components/Toast';
import {
  buildDashboardQuery,
  dashboardParamsFromState,
  parseDashboardParams,
  type DashboardState,
} from '../utils/dashboard-filters';

export default function AdminDashboardPage() {
  // Tile, search, sort, page, view and the open drawer all live in the URL,
  // so a reload, a shared link or the back button keeps the view.
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseDashboardParams(searchParams), [searchParams]);
  const updateState = useCallback(
    (patch: Partial<DashboardState>) => {
      setSearchParams(
        (current) => dashboardParamsFromState({ ...parseDashboardParams(current), ...patch }),
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const selectedAppointment = state.appointment;
  const setSelectedAppointment = useCallback(
    (id: string | null) => updateState({ appointment: id }),
    [updateState],
  );
  const [expandedTherapists, setExpandedTherapists] = useState<Set<string>>(new Set());

  // Search box: typed text is local, the URL (and so the query) follows 300ms later.
  const [searchInput, setSearchInput] = useState(state.q);
  const debouncedSearch = useDebounce(searchInput, 300);
  useEffect(() => {
    if (debouncedSearch.trim() !== state.q) updateState({ q: debouncedSearch, page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the debounced input
  }, [debouncedSearch]);

  const listQuery = useMemo(() => buildDashboardQuery(state), [state]);

  // SSE: real-time updates
  useSSE();

  // Fetch appointments list — filtered, sorted and paged by the server.
  const {
    data: appointmentsData,
    isLoading: loadingList,
    error: listError,
  } = useQuery({
    queryKey: ['appointments', listQuery],
    queryFn: () => getAppointments(listQuery),
    refetchInterval: 30000,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  // Fetch stats (the tile counts, over the whole table)
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: getDashboardStats,
    refetchInterval: 30000,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  // Count of appointments paused by the tool-call ceiling. Polled on the
  // same cadence as stats so the banner stays in sync after an SSE-driven
  // change elsewhere on the page.
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { data: ceilingTripped } = useQuery({
    queryKey: ['ceiling-tripped-count'],
    queryFn: getCeilingTrippedCount,
    refetchInterval: 30000,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const [confirmingBulkRelease, setConfirmingBulkRelease] = useState(false);

  const bulkReleaseMutation = useMutation({
    mutationFn: releaseCeilingTripped,
    onSuccess: (result) => {
      setConfirmingBulkRelease(false);
      const releasedCount = result.released.length;
      const failedCount = result.failed.length;
      if (releasedCount > 0 && failedCount === 0) {
        showToast(`Released ${releasedCount} appointment${releasedCount === 1 ? '' : 's'}.`, 'success');
      } else if (releasedCount > 0 && failedCount > 0) {
        showToast(`Released ${releasedCount}, failed ${failedCount}. Check logs.`, 'error');
      } else if (releasedCount === 0 && failedCount > 0) {
        showToast(`All ${failedCount} releases failed. Check logs.`, 'error');
      } else {
        showToast('Nothing to release.', 'success');
      }
      // Refresh the count, appointments, and stats so the dashboard reflects
      // the new state immediately rather than waiting for the 30s poll.
      void queryClient.invalidateQueries({ queryKey: ['ceiling-tripped-count'] });
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : 'Bulk release failed', 'error');
    },
  });

  // Fetch selected appointment detail
  const {
    data: appointmentDetail,
    isLoading: loadingDetail,
    error: detailError,
  } = useQuery({
    queryKey: ['appointment', selectedAppointment],
    queryFn: () => getAppointmentDetail(selectedAppointment!),
    enabled: !!selectedAppointment,
    staleTime: 30000,
    // SSE `appointment:activity` refetches the open drawer immediately; this
    // poll is the fallback when the stream is down.
    refetchInterval: 30000,
  });

  // The server already applied the tile, search and paging.
  const filteredAppointments = useMemo(
    () => (Array.isArray(appointmentsData?.data) ? appointmentsData.data : []),
    [appointmentsData?.data],
  );

  // Group filtered appointments by therapist
  const therapistGroups = useMemo(() => {
    const groups = new Map<string, TherapistGroup>();

    for (const apt of filteredAppointments) {
      const key = apt.therapistHandle;
      if (!groups.has(key)) {
        groups.set(key, {
          therapistName: apt.therapistName,
          therapistEmail: apt.therapistEmail,
          therapistHandle: apt.therapistHandle,
          appointments: [],
          pendingCount: 0,
          negotiatingCount: 0,
          confirmedCount: 0,
          completedCount: 0,
          healthRed: 0,
          healthYellow: 0,
        });
      }
      const group = groups.get(key)!;
      group.appointments.push(apt);

      if (apt.status === 'pending' || apt.status === 'contacted') {
        group.pendingCount++;
      } else if (apt.status === 'negotiating') {
        group.negotiatingCount++;
      } else if (apt.status === 'confirmed') {
        group.confirmedCount++;
      } else if (
        apt.status === 'completed' ||
        apt.status === 'session_held' ||
        apt.status === 'feedback_requested'
      ) {
        group.completedCount++;
      }

      const terminalStatuses = [
        'confirmed',
        'cancelled',
        'completed',
        'session_held',
        'feedback_requested',
      ];
      if (!terminalStatuses.includes(apt.status)) {
        if (apt.healthStatus === 'red') {
          group.healthRed++;
        } else if (apt.healthStatus === 'yellow') {
          group.healthYellow++;
        }
      }
    }

    return Array.from(groups.values()).sort((a, b) => {
      if (a.healthRed !== b.healthRed) return b.healthRed - a.healthRed;
      if (a.healthYellow !== b.healthYellow) return b.healthYellow - a.healthYellow;
      const aActiveCount = a.pendingCount + a.negotiatingCount;
      const bActiveCount = b.pendingCount + b.negotiatingCount;
      if (aActiveCount !== bActiveCount) return bActiveCount - aActiveCount;
      if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount;
      return b.negotiatingCount - a.negotiatingCount;
    });
  }, [filteredAppointments]);

  const toggleTherapistExpanded = useCallback((therapistId: string) => {
    setExpandedTherapists((prev) => {
      const next = new Set(prev);
      if (next.has(therapistId)) {
        next.delete(therapistId);
      } else {
        next.add(therapistId);
      }
      return next;
    });
  }, []);

  // Tile label for list header
  const tileLabel: Record<string, string> = {
    active: 'Active (Pre-booking)',
    confirmed: 'Confirmed',
    'post-session': 'Post-Session',
    attention: 'Needs Attention',
    human: 'Human Control',
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Scheduling Dashboard</h1>
        </div>

        {/* Bulk-release banner: appointments paused by the tool-call ceiling.
            Only renders when the count is positive so the dashboard stays
            clean in the normal case. */}
        {ceilingTripped && ceilingTripped.count > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-orange-50 border border-orange-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-orange-900">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-200 text-orange-700 text-xs font-bold flex-shrink-0">!</span>
              <span>
                <strong>{ceilingTripped.count}</strong> appointment{ceilingTripped.count === 1 ? '' : 's'} paused by the tool-call ceiling
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmingBulkRelease(true)}
              disabled={bulkReleaseMutation.isPending}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              {bulkReleaseMutation.isPending ? 'Releasing…' : 'Release all'}
            </button>
          </div>
        )}

        {confirmingBulkRelease && ceilingTripped && (
          <ConfirmDialog
            title="Release all ceiling-tripped appointments?"
            confirmLabel={`Release ${ceilingTripped.count}`}
            confirmVariant="primary"
            isPending={bulkReleaseMutation.isPending}
            onConfirm={() => bulkReleaseMutation.mutate()}
            onCancel={() => setConfirmingBulkRelease(false)}
          >
            <p>
              This will resume agent automation on <strong>{ceilingTripped.count}</strong> appointment
              {ceilingTripped.count === 1 ? '' : 's'} currently paused because the tool-call ceiling was reached.
            </p>
            <p className="mt-2 text-slate-600">
              Each appointment's tool-count counter will be reset so the ceiling doesn't re-trip immediately.
              Other agent-flagged appointments (genuine uncertainty, error breaker, etc.) are not affected and still need per-thread review.
            </p>
          </ConfirmDialog>
        )}

        {/* Summary Tiles */}
        <AppointmentPipeline
          stats={stats}
          selectedTile={state.tile}
          onTileSelect={(tile) => updateState({ tile, page: 1 })}
        />

        {/* Error State */}
        {listError && (
          <div className="bg-spill-red-100 border border-spill-red-200 rounded-xl p-4 mb-6">
            <p className="text-spill-red-600 text-sm">
              {listError instanceof Error ? listError.message : 'Failed to load appointments'}
            </p>
          </div>
        )}

        {/* Toolbar: tile-derived heading + count, view-mode toggle, sort. */}
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-slate-700">
            {state.tile ? tileLabel[state.tile] || 'All' : 'All Appointments'}
            <span className="text-slate-400 font-normal ml-1.5">
              ({appointmentsData?.pagination.total ?? filteredAppointments.length})
            </span>
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="dashboard-search" className="sr-only">
              Search by tracking code, client or therapist
            </label>
            <input
              id="dashboard-search"
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search SPL code, email, name…"
              className="text-xs px-2.5 py-1 w-56 border border-slate-200 rounded-lg focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            />
            {/* View mode toggle: flat table is the default; grouped falls
                back to the (existing) TherapistGroupList for admins
                triaging a single therapist's load. */}
            <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs" role="group" aria-label="View mode">
              <button
                type="button"
                onClick={() => updateState({ view: 'flat' })}
                aria-pressed={state.view === 'flat'}
                className={`px-2.5 py-1 transition-colors ${state.view === 'flat' ? 'bg-slate-100 text-slate-900 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                Flat
              </button>
              <button
                type="button"
                onClick={() => updateState({ view: 'grouped' })}
                aria-pressed={state.view === 'grouped'}
                className={`px-2.5 py-1 transition-colors border-l border-slate-200 ${state.view === 'grouped' ? 'bg-slate-100 text-slate-900 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                By therapist
              </button>
            </div>
            <select
              value={state.sortBy}
              onChange={(e) =>
                updateState({ sortBy: e.target.value as DashboardState['sortBy'], page: 1 })
              }
              className="text-xs px-2 py-1 border border-slate-200 rounded-lg text-slate-500 focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
              aria-label="Sort by"
            >
              <option value="updatedAt">Last updated</option>
              <option value="createdAt">Date created</option>
            </select>
          </div>
        </div>

        {/* Main content: one container, not two. Drawer slides over from
            the right when a row is selected. */}
        {state.view === 'flat' ? (
          <AppointmentsTable
            appointments={filteredAppointments}
            filters={listQuery}
            pagination={appointmentsData?.pagination}
            loadingList={loadingList}
            selectedAppointment={selectedAppointment}
            onSelectAppointment={setSelectedAppointment}
            onSortChange={(sortBy) =>
              updateState({
                sortBy,
                sortOrder: state.sortBy === sortBy && state.sortOrder === 'desc' ? 'asc' : 'desc',
                page: 1,
              })
            }
            onPageChange={(page) => updateState({ page })}
          />
        ) : (
          <TherapistGroupList
            therapistGroups={therapistGroups}
            filters={listQuery}
            pagination={appointmentsData?.pagination}
            loadingList={loadingList}
            selectedAppointment={selectedAppointment}
            expandedTherapists={expandedTherapists}
            onSelectAppointment={setSelectedAppointment}
            onToggleTherapist={toggleTherapistExpanded}
            onPageChange={(page) => updateState({ page })}
          />
        )}

        <AppointmentDetailDrawer
          selectedAppointment={selectedAppointment}
          appointmentDetail={appointmentDetail}
          loadingDetail={loadingDetail}
          detailError={detailError}
          onClearSelection={() => setSelectedAppointment(null)}
        />
      </div>
    </div>
  );
}
