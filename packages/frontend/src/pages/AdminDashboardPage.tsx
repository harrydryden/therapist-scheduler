import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  getAppointments,
  getAppointmentDetail,
  getDashboardStats,
} from '../api/client';
import type { AppointmentFilters } from '../types';
import { useDebounce } from '../hooks/useDebounce';
import { useSSE } from '../hooks/useSSE';
import AppointmentPipeline from '../components/AppointmentPipeline';
import type { DashboardTileFilter } from '../components/AppointmentPipeline';
import TherapistGroupList from '../components/TherapistGroupList';
import type { TherapistGroup } from '../components/TherapistGroupList';
import AppointmentDetailPanel from '../components/AppointmentDetailPanel';

export default function AdminDashboardPage() {
  const [filters, setFilters] = useState<AppointmentFilters>({
    page: 1,
    limit: 100,
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedAppointment, setSelectedAppointment] = useState<string | null>(
    searchParams.get('appointment') || null
  );
  const [selectedTile, setSelectedTile] = useState<DashboardTileFilter>('active');
  const [expandedTherapists, setExpandedTherapists] = useState<Set<string>>(new Set());

  // Sync URL search param when selection changes
  useEffect(() => {
    const currentParam = searchParams.get('appointment');
    if (selectedAppointment && currentParam !== selectedAppointment) {
      setSearchParams({ appointment: selectedAppointment }, { replace: true });
    } else if (!selectedAppointment && currentParam) {
      searchParams.delete('appointment');
      setSearchParams(searchParams, { replace: true });
    }
  }, [selectedAppointment, searchParams, setSearchParams]);

  const debouncedFilters = useDebounce(filters, 300);

  // SSE: real-time updates
  useSSE();

  // Fetch appointments list
  const {
    data: appointmentsData,
    isLoading: loadingList,
    error: listError,
  } = useQuery({
    queryKey: ['appointments', debouncedFilters],
    queryFn: () => getAppointments(debouncedFilters),
    refetchInterval: 30000,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  // Fetch stats
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: getDashboardStats,
    refetchInterval: 30000,
    staleTime: 30000,
    refetchOnWindowFocus: false,
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
  });

  // Filter appointments based on selected tile
  const filteredAppointments = useMemo(() => {
    if (!Array.isArray(appointmentsData?.data)) return [];

    const all = appointmentsData.data;

    switch (selectedTile) {
      case 'active':
        return all.filter((apt) =>
          ['pending', 'contacted', 'negotiating'].includes(apt.status)
        );
      case 'confirmed':
        return all.filter((apt) => apt.status === 'confirmed');
      case 'post-session':
        return all.filter((apt) =>
          ['session_held', 'feedback_requested', 'completed'].includes(apt.status)
        );
      case 'attention':
        return all.filter(
          (apt) =>
            apt.healthStatus === 'red' &&
            ['pending', 'contacted', 'negotiating'].includes(apt.status)
        );
      case 'human':
        return all.filter((apt) => apt.humanControlEnabled);
      default:
        return all;
    }
  }, [appointmentsData?.data, selectedTile]);

  // Group filtered appointments by therapist
  const therapistGroups = useMemo(() => {
    const groups = new Map<string, TherapistGroup>();

    for (const apt of filteredAppointments) {
      const key = apt.therapistNotionId;
      if (!groups.has(key)) {
        groups.set(key, {
          therapistName: apt.therapistName,
          therapistEmail: apt.therapistEmail,
          therapistNotionId: apt.therapistNotionId,
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

        {/* Summary Tiles */}
        <AppointmentPipeline
          stats={stats}
          appointments={appointmentsData?.data}
          selectedTile={selectedTile}
          onTileSelect={setSelectedTile}
        />

        {/* Error State */}
        {listError && (
          <div className="bg-spill-red-100 border border-spill-red-200 rounded-xl p-4 mb-6">
            <p className="text-spill-red-600 text-sm">
              {listError instanceof Error ? listError.message : 'Failed to load appointments'}
            </p>
          </div>
        )}

        {/* Main Content: List + Detail */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            {/* Sort control */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-slate-700">
                {selectedTile ? tileLabel[selectedTile] || 'All' : 'All Appointments'}
                <span className="text-slate-400 font-normal ml-1.5">
                  ({filteredAppointments.length})
                </span>
              </h2>
              <select
                value={filters.sortBy || 'updatedAt'}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, sortBy: e.target.value, page: 1 }))
                }
                className="text-xs px-2 py-1 border border-slate-200 rounded-lg text-slate-500 focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
              >
                <option value="updatedAt">Last updated</option>
                <option value="createdAt">Date created</option>
              </select>
            </div>

            <TherapistGroupList
              therapistGroups={therapistGroups}
              filters={filters}
              pagination={appointmentsData?.pagination}
              loadingList={loadingList}
              selectedAppointment={selectedAppointment}
              expandedTherapists={expandedTherapists}
              onSelectAppointment={setSelectedAppointment}
              onToggleTherapist={toggleTherapistExpanded}
              onPageChange={(page) => setFilters((prev) => ({ ...prev, page }))}
            />
          </div>

          <div className="lg:sticky lg:top-4 lg:self-start">
            <AppointmentDetailPanel
              selectedAppointment={selectedAppointment}
              appointmentDetail={appointmentDetail}
              loadingDetail={loadingDetail}
              detailError={detailError}
              onClearSelection={() => setSelectedAppointment(null)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
