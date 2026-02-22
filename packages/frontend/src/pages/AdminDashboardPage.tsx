import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getAppointments,
  getAppointmentDetail,
  getDashboardStats,
} from '../api/client';
import type { AppointmentFilters } from '../types';
import { useDebounce } from '../hooks/useDebounce';
import AppointmentPipeline from '../components/AppointmentPipeline';
import AppointmentFiltersBar from '../components/AppointmentFilters';
import TherapistGroupList from '../components/TherapistGroupList';
import type { TherapistGroup } from '../components/TherapistGroupList';
import AppointmentDetailPanel from '../components/AppointmentDetailPanel';

// FIX #36: Decomposed from a single ~1400-line file into focused sub-components:
// - AppointmentPipeline (stats + health/control overview)
// - AppointmentFilters (filter bar)
// - TherapistGroupList (grouped appointment list)
// - AppointmentDetailPanel (detail + human control panel)
export default function AdminDashboardPage() {
  const [filters, setFilters] = useState<AppointmentFilters>({
    page: 1,
    limit: 100, // Load more to enable proper grouping
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  });
  const [selectedAppointment, setSelectedAppointment] = useState<string | null>(null);
  const [hideConfirmed, setHideConfirmed] = useState(true);
  const [expandedTherapists, setExpandedTherapists] = useState<Set<string>>(new Set());
  const [quickFilter, setQuickFilter] = useState<'red' | 'human' | 'post-session' | 'cancelled' | null>(null);

  // Debounce filter changes (date range, sort) to avoid excessive API calls
  // Quick filter pills and page changes apply immediately via the non-debounced filters
  const debouncedFilters = useDebounce(filters, 300);

  // Fetch appointments list with auto-refresh
  const {
    data: appointmentsData,
    isLoading: loadingList,
    error: listError,
  } = useQuery({
    queryKey: ['appointments', debouncedFilters],
    queryFn: () => getAppointments(debouncedFilters),
    refetchInterval: 30000,
    staleTime: 30000,
    refetchOnWindowFocus: false, // Polling handles freshness; avoid duplicate requests on tab switch
  });

  // Fetch stats with auto-refresh every 30 seconds
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
  } = useQuery({
    queryKey: ['appointment', selectedAppointment],
    queryFn: () => getAppointmentDetail(selectedAppointment!),
    enabled: !!selectedAppointment,
    staleTime: 30000,
  });

  // Group appointments by therapist
  const therapistGroups = useMemo(() => {
    if (!appointmentsData?.data) return [];

    let filteredAppointments = appointmentsData.data;

    if (hideConfirmed) {
      filteredAppointments = filteredAppointments.filter((apt) =>
        ['pending', 'contacted', 'negotiating'].includes(apt.status)
      );
    }

    if (quickFilter === 'red') {
      filteredAppointments = filteredAppointments.filter((apt) => apt.healthStatus === 'red');
    } else if (quickFilter === 'human') {
      filteredAppointments = filteredAppointments.filter((apt) => apt.humanControlEnabled);
    } else if (quickFilter === 'post-session') {
      filteredAppointments = filteredAppointments.filter((apt) =>
        ['session_held', 'feedback_requested', 'completed'].includes(apt.status)
      );
    } else if (quickFilter === 'cancelled') {
      filteredAppointments = filteredAppointments.filter((apt) => apt.status === 'cancelled');
    }

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
      } else if (apt.status === 'completed' || apt.status === 'session_held' || apt.status === 'feedback_requested') {
        group.completedCount++;
      }

      const terminalStatuses = ['confirmed', 'cancelled', 'completed', 'session_held', 'feedback_requested'];
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
  }, [appointmentsData?.data, hideConfirmed, quickFilter]);

  const toggleTherapistExpanded = (therapistId: string) => {
    setExpandedTherapists((prev) => {
      const next = new Set(prev);
      if (next.has(therapistId)) {
        next.delete(therapistId);
      } else {
        next.add(therapistId);
      }
      return next;
    });
  };

  const handleFilterChange = (key: keyof AppointmentFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Scheduling Dashboard</h1>
          <p className="text-slate-600 mt-1">Monitor and manage appointment requests</p>
        </div>

        {/* Pipeline Stats + Health/Control Overview */}
        <AppointmentPipeline
          stats={stats}
          appointments={appointmentsData?.data}
        />

        {/* Filter Bar */}
        <AppointmentFiltersBar
          filters={filters}
          appointments={appointmentsData?.data}
          hideConfirmed={hideConfirmed}
          quickFilter={quickFilter}
          onFilterChange={handleFilterChange}
          onHideConfirmedChange={setHideConfirmed}
          onQuickFilterChange={setQuickFilter}
        />

        {/* Error State */}
        {listError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
            <p className="text-red-600">
              {listError instanceof Error ? listError.message : 'Failed to load appointments'}
            </p>
          </div>
        )}

        {/* Main Content: List + Detail */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TherapistGroupList
            therapistGroups={therapistGroups}
            filters={filters}
            pagination={appointmentsData?.pagination}
            loadingList={loadingList}
            selectedAppointment={selectedAppointment}
            expandedTherapists={expandedTherapists}
            onSelectAppointment={setSelectedAppointment}
            onToggleTherapist={toggleTherapistExpanded}
            onPageChange={(page) => setFilters(prev => ({ ...prev, page }))}
          />

          <AppointmentDetailPanel
            selectedAppointment={selectedAppointment}
            appointmentDetail={appointmentDetail}
            loadingDetail={loadingDetail}
            onClearSelection={() => setSelectedAppointment(null)}
          />
        </div>

        {/* Top Users */}
        {stats && stats.topUsers && stats.topUsers.length > 0 && (
          <div className="mt-8 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-semibold text-slate-900 mb-4">Top Users by Bookings</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {stats.topUsers.slice(0, 5).map((user, idx) => (
                <div key={user.email} className="text-center">
                  <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-2">
                    <span className="text-lg font-bold text-slate-600">#{idx + 1}</span>
                  </div>
                  <p className="font-medium text-slate-900 text-sm">{user.name}</p>
                  <p className="text-xs text-slate-500">{user.bookingCount} bookings</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
