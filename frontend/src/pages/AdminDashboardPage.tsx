import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import {
  getAppointments,
  getAppointmentDetail,
  getDashboardStats,
  takeControl,
  releaseControl,
  sendAdminMessage,
  deleteAppointment,
  updateAppointment,
} from '../api/client';
import type { AppointmentFilters, AppointmentListItem, HealthStatus } from '../types';
import { APP } from '../config/constants';
import { getStatusColor, getStageLabel } from '../config/color-mappings';
import HealthStatusBadge from '../components/HealthStatusBadge';

// Sanitize text content to prevent XSS
function sanitizeText(text: string): string {
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [] }); // Strip all HTML
}

// Group appointments by therapist
interface TherapistGroup {
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  appointments: AppointmentListItem[];
  // Lifecycle stage counts
  pendingCount: number;
  negotiatingCount: number;
  confirmedCount: number;
  completedCount: number;
  // Health aggregates
  healthRed: number;
  healthYellow: number;
}

export default function AdminDashboardPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<AppointmentFilters>({
    page: 1,
    limit: 100, // Load more to enable proper grouping
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  });
  const [selectedAppointment, setSelectedAppointment] = useState<string | null>(null);
  const [hideConfirmed, setHideConfirmed] = useState(true); // Default to hiding confirmed
  const [expandedTherapists, setExpandedTherapists] = useState<Set<string>>(new Set());
  const [quickFilter, setQuickFilter] = useState<'red' | 'human' | 'post-session' | 'cancelled' | null>(null);

  // Human control state
  const [showComposeMessage, setShowComposeMessage] = useState(false);
  const [messageRecipient, setMessageRecipient] = useState<'client' | 'therapist'>('client');
  const [messageSubject, setMessageSubject] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [controlReason, setControlReason] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Delete appointment state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const [forceDeleteConfirmed, setForceDeleteConfirmed] = useState(false);

  // Edit appointment state
  const [showEditPanel, setShowEditPanel] = useState(false);
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [editConfirmedDateTime, setEditConfirmedDateTime] = useState('');
  const [editWarning, setEditWarning] = useState<string | null>(null);

  // Fetch appointments list with auto-refresh
  const {
    data: appointmentsData,
    isLoading: loadingList,
    error: listError,
  } = useQuery({
    queryKey: ['appointments', filters],
    queryFn: () => getAppointments(filters),
    refetchInterval: 30000, // Refresh every 30 seconds
    staleTime: 30000, // Keep data fresh for the refetch interval to avoid redundant fetches
  });

  // Fetch stats with auto-refresh every 30 seconds
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: getDashboardStats,
    refetchInterval: 30000, // Refresh every 30 seconds
    staleTime: 30000, // Keep data fresh for the refetch interval to avoid redundant fetches
  });

  // Fetch selected appointment detail
  const {
    data: appointmentDetail,
    isLoading: loadingDetail,
  } = useQuery({
    queryKey: ['appointment', selectedAppointment],
    queryFn: () => getAppointmentDetail(selectedAppointment!),
    enabled: !!selectedAppointment,
  });

  // Group appointments by therapist
  const therapistGroups = useMemo(() => {
    if (!appointmentsData?.data) return [];

    // Apply filters
    let filteredAppointments = appointmentsData.data;

    // Filter based on hideConfirmed (which means "show only active")
    if (hideConfirmed) {
      // "Active" = pre-booking stages only (pending, contacted, negotiating)
      filteredAppointments = filteredAppointments.filter((apt) =>
        ['pending', 'contacted', 'negotiating'].includes(apt.status)
      );
    }

    // Apply quick filter
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

    // Group by therapist
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

      // Count by lifecycle stage
      if (apt.status === 'pending' || apt.status === 'contacted') {
        group.pendingCount++;
      } else if (apt.status === 'negotiating') {
        group.negotiatingCount++;
      } else if (apt.status === 'confirmed') {
        group.confirmedCount++;
      } else if (apt.status === 'completed' || apt.status === 'session_held' || apt.status === 'feedback_requested') {
        group.completedCount++;
      }

      // Track health counts (only for non-terminal statuses)
      // Terminal statuses: confirmed, cancelled, completed, session_held, feedback_requested
      const terminalStatuses = ['confirmed', 'cancelled', 'completed', 'session_held', 'feedback_requested'];
      if (!terminalStatuses.includes(apt.status)) {
        if (apt.healthStatus === 'red') {
          group.healthRed++;
        } else if (apt.healthStatus === 'yellow') {
          group.healthYellow++;
        }
      }
    }

    // Sort groups: prioritize those needing attention
    return Array.from(groups.values()).sort((a, b) => {
      // First by health issues (red > yellow > green)
      if (a.healthRed !== b.healthRed) {
        return b.healthRed - a.healthRed;
      }
      if (a.healthYellow !== b.healthYellow) {
        return b.healthYellow - a.healthYellow;
      }
      // Then by earlier lifecycle stages (pending > negotiating > confirmed)
      const aActiveCount = a.pendingCount + a.negotiatingCount;
      const bActiveCount = b.pendingCount + b.negotiatingCount;
      if (aActiveCount !== bActiveCount) {
        return bActiveCount - aActiveCount;
      }
      // Then by pending count specifically
      if (a.pendingCount !== b.pendingCount) {
        return b.pendingCount - a.pendingCount;
      }
      // Then by negotiating count
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

  // Human control mutations
  const takeControlMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      takeControl(id, { adminId: 'admin', reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setControlReason('');
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to take control');
    },
  });

  const releaseControlMutation = useMutation({
    mutationFn: (id: string) => releaseControl(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to release control');
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: ({
      id,
      to,
      subject,
      body,
    }: {
      id: string;
      to: string;
      subject: string;
      body: string;
    }) => sendAdminMessage(id, { to, subject, body, adminId: 'admin' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      setShowComposeMessage(false);
      setMessageSubject('');
      setMessageBody('');
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to send message');
    },
  });

  const deleteAppointmentMutation = useMutation({
    mutationFn: ({ id, reason, forceDeleteConfirmed: force }: { id: string; reason?: string; forceDeleteConfirmed?: boolean }) =>
      deleteAppointment(id, { adminId: 'admin', reason, forceDeleteConfirmed: force }),
    onSuccess: () => {
      // Clear selection since appointment no longer exists
      setSelectedAppointment(null);
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setShowDeleteConfirm(false);
      setDeleteReason('');
      setForceDeleteConfirmed(false);
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to delete appointment');
    },
  });

  const updateAppointmentMutation = useMutation({
    mutationFn: ({
      id,
      status,
      confirmedDateTime,
    }: {
      id: string;
      status?: string;
      confirmedDateTime?: string | null;
    }) =>
      updateAppointment(id, {
        status: status as 'pending' | 'contacted' | 'negotiating' | 'confirmed' | 'cancelled' | undefined,
        confirmedDateTime,
        adminId: 'admin',
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setShowEditPanel(false);
      setMutationError(null);
      if (data.warning) {
        setEditWarning(data.warning);
        setTimeout(() => setEditWarning(null), 5000);
      }
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to update appointment');
    },
  });

  // Sync edit form state when appointment detail loads
  useEffect(() => {
    if (appointmentDetail) {
      setEditStatus(appointmentDetail.status);
      setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
    }
  }, [appointmentDetail]);

  const handleSendMessage = () => {
    if (!appointmentDetail || !messageSubject.trim() || !messageBody.trim()) return;
    const to =
      messageRecipient === 'client'
        ? appointmentDetail.userEmail
        : appointmentDetail.therapistEmail;
    sendMessageMutation.mutate({
      id: appointmentDetail.id,
      to,
      subject: messageSubject,
      body: messageBody,
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

        {/* Appointment Lifecycle Stats */}
        {stats && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
            <h2 className="font-semibold text-slate-900 mb-4">Appointment Pipeline</h2>

            {/* Pipeline Flow */}
            <div className="flex items-stretch gap-1 mb-6">
              {/* Pre-booking stages */}
              <div className="flex-1 min-w-0">
                <div className="bg-amber-50 rounded-l-xl p-4 h-full border border-amber-200">
                  <p className="text-xs font-medium text-amber-600 uppercase tracking-wide mb-1">Pending</p>
                  <p className="text-3xl font-bold text-amber-700">{stats.byStatus.pending || 0}</p>
                  <p className="text-xs text-amber-600 mt-1">Awaiting first contact</p>
                </div>
              </div>
              <div className="flex items-center text-slate-300">→</div>
              <div className="flex-1 min-w-0">
                <div className="bg-blue-50 p-4 h-full border-y border-blue-200">
                  <p className="text-xs font-medium text-blue-600 uppercase tracking-wide mb-1">Contacted</p>
                  <p className="text-3xl font-bold text-blue-700">{stats.byStatus.contacted || 0}</p>
                  <p className="text-xs text-blue-600 mt-1">Initial outreach made</p>
                </div>
              </div>
              <div className="flex items-center text-slate-300">→</div>
              <div className="flex-1 min-w-0">
                <div className="bg-indigo-50 p-4 h-full border-y border-indigo-200">
                  <p className="text-xs font-medium text-indigo-600 uppercase tracking-wide mb-1">Negotiating</p>
                  <p className="text-3xl font-bold text-indigo-700">{stats.byStatus.negotiating || 0}</p>
                  <p className="text-xs text-indigo-600 mt-1">Finding a time</p>
                </div>
              </div>
              <div className="flex items-center text-slate-300">→</div>
              {/* Post-booking stages */}
              <div className="flex-1 min-w-0">
                <div className="bg-green-50 p-4 h-full border-y border-green-200">
                  <p className="text-xs font-medium text-green-600 uppercase tracking-wide mb-1">Confirmed</p>
                  <p className="text-3xl font-bold text-green-700">{stats.byStatus.confirmed || 0}</p>
                  <p className="text-xs text-green-600 mt-1">Session booked</p>
                </div>
              </div>
              <div className="flex items-center text-slate-300">→</div>
              <div className="flex-1 min-w-0">
                <div className="bg-teal-50 p-4 h-full border-y border-teal-200">
                  <p className="text-xs font-medium text-teal-600 uppercase tracking-wide mb-1">Session Held</p>
                  <p className="text-3xl font-bold text-teal-700">{stats.byStatus.session_held || 0}</p>
                  <p className="text-xs text-teal-600 mt-1">Session complete</p>
                </div>
              </div>
              <div className="flex items-center text-slate-300">→</div>
              <div className="flex-1 min-w-0">
                <div className="bg-cyan-50 p-4 h-full border-y border-cyan-200">
                  <p className="text-xs font-medium text-cyan-600 uppercase tracking-wide mb-1">Feedback Requested</p>
                  <p className="text-3xl font-bold text-cyan-700">{stats.byStatus.feedback_requested || 0}</p>
                  <p className="text-xs text-cyan-600 mt-1">Awaiting response</p>
                </div>
              </div>
              <div className="flex items-center text-slate-300">→</div>
              <div className="flex-1 min-w-0">
                <div className="bg-emerald-50 rounded-r-xl p-4 h-full border border-emerald-200">
                  <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-1">Completed</p>
                  <p className="text-3xl font-bold text-emerald-700">{stats.byStatus.completed || 0}</p>
                  <p className="text-xs text-emerald-600 mt-1">Feedback received</p>
                </div>
              </div>
            </div>

            {/* Summary row */}
            <div className="flex items-center justify-between pt-4 border-t border-slate-100">
              <div className="flex items-center gap-6">
                <div>
                  <p className="text-sm text-slate-500">Active (pre-booking)</p>
                  <p className="text-xl font-bold text-slate-800">
                    {(stats.byStatus.pending || 0) + (stats.byStatus.contacted || 0) + (stats.byStatus.negotiating || 0)}
                  </p>
                </div>
                <div className="h-8 w-px bg-slate-200" />
                <div>
                  <p className="text-sm text-slate-500">Confirmed (7d)</p>
                  <p className="text-xl font-bold text-green-600">{stats.confirmedLast7Days}</p>
                </div>
                <div className="h-8 w-px bg-slate-200" />
                <div>
                  <p className="text-sm text-slate-500">Cancelled</p>
                  <p className="text-xl font-bold text-slate-400">{stats.byStatus.cancelled || 0}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Health & Control Overview - Combined Card */}
        {appointmentsData?.data && appointmentsData.data.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
            <div className="grid grid-cols-2 gap-8">
              {/* Health Status Section */}
              <div>
                <h3 className="font-semibold text-slate-700 mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 bg-slate-400 rounded-full"></span>
                  Health Status
                  <span className="text-xs font-normal text-slate-400">(active appointments only)</span>
                </h3>
                {(() => {
                  const activeAppointments = appointmentsData.data.filter(
                    (apt) => !['confirmed', 'session_held', 'feedback_requested', 'completed', 'cancelled'].includes(apt.status)
                  );
                  const healthCounts = activeAppointments.reduce(
                    (acc, apt) => {
                      if (apt.healthStatus && ['green', 'yellow', 'red'].includes(apt.healthStatus)) {
                        acc[apt.healthStatus as HealthStatus]++;
                      }
                      return acc;
                    },
                    { green: 0, yellow: 0, red: 0 } as Record<HealthStatus, number>
                  );
                  const total = activeAppointments.length || 1;
                  return (
                    <div className="space-y-3">
                      {/* Health bar visualization */}
                      <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
                        {healthCounts.green > 0 && (
                          <div
                            className="bg-spill-teal-400 transition-all"
                            style={{ width: `${(healthCounts.green / total) * 100}%` }}
                          />
                        )}
                        {healthCounts.yellow > 0 && (
                          <div
                            className="bg-spill-yellow-400 transition-all"
                            style={{ width: `${(healthCounts.yellow / total) * 100}%` }}
                          />
                        )}
                        {healthCounts.red > 0 && (
                          <div
                            className="bg-spill-red-400 transition-all"
                            style={{ width: `${(healthCounts.red / total) * 100}%` }}
                          />
                        )}
                      </div>
                      {/* Legend */}
                      <div className="flex items-center gap-6 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 bg-spill-teal-400 rounded-full" />
                          <span className="text-slate-600">Healthy</span>
                          <span className="font-semibold text-spill-teal-600">{healthCounts.green}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 bg-spill-yellow-400 rounded-full" />
                          <span className="text-slate-600">Monitoring</span>
                          <span className="font-semibold text-spill-yellow-600">{healthCounts.yellow}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 bg-spill-red-400 rounded-full animate-pulse" />
                          <span className="text-slate-600">Needs Attention</span>
                          <span className="font-semibold text-spill-red-600">{healthCounts.red}</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Control Status Section */}
              <div>
                <h3 className="font-semibold text-slate-700 mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 bg-slate-400 rounded-full"></span>
                  Control Status
                  <span className="text-xs font-normal text-slate-400">(all appointments)</span>
                </h3>
                {(() => {
                  const allAppointments = appointmentsData.data;
                  const humanControlCount = allAppointments.filter((apt) => apt.humanControlEnabled).length;
                  const agentControlCount = allAppointments.filter((apt) => !apt.humanControlEnabled).length;
                  const total = allAppointments.length || 1;
                  return (
                    <div className="space-y-3">
                      {/* Control bar visualization */}
                      <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
                        {agentControlCount > 0 && (
                          <div
                            className="bg-spill-blue-800 transition-all"
                            style={{ width: `${(agentControlCount / total) * 100}%` }}
                          />
                        )}
                        {humanControlCount > 0 && (
                          <div
                            className="bg-orange-400 transition-all"
                            style={{ width: `${(humanControlCount / total) * 100}%` }}
                          />
                        )}
                      </div>
                      {/* Legend */}
                      <div className="flex items-center gap-6 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">🤖</span>
                          <span className="text-slate-600">Agent Control</span>
                          <span className="font-semibold text-spill-blue-800">{agentControlCount}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">👤</span>
                          <span className="text-slate-600">Human Control</span>
                          <span className="font-semibold text-orange-600">{humanControlCount}</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Unified Filters */}
        <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100 mb-6">
          {/* Primary Filters - Quick access pills */}
          <div className="flex flex-wrap gap-2 mb-4">
            {(() => {
              const data = appointmentsData?.data || [];
              const activeAppointments = data.filter(
                (apt) => !['confirmed', 'session_held', 'feedback_requested', 'completed', 'cancelled'].includes(apt.status)
              );
              const redCount = activeAppointments.filter((apt) => apt.healthStatus === 'red').length;
              const humanCount = data.filter((apt) => apt.humanControlEnabled).length;

              // Lifecycle stage counts
              const activeCount = data.filter((apt) => ['pending', 'contacted', 'negotiating'].includes(apt.status)).length;
              const confirmedCount = data.filter((apt) => apt.status === 'confirmed').length;
              const postSessionCount = data.filter((apt) => ['session_held', 'feedback_requested', 'completed'].includes(apt.status)).length;

              type FilterValue = 'all' | 'active' | 'confirmed' | 'post-session' | 'cancelled' | 'red' | 'human';
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
                  setQuickFilter(null);
                  setHideConfirmed(false);
                  handleFilterChange('status', '');
                } else if (value === 'active') {
                  setQuickFilter(null);
                  setHideConfirmed(true);
                  handleFilterChange('status', '');
                } else if (value === 'confirmed') {
                  setQuickFilter(null);
                  setHideConfirmed(false);
                  handleFilterChange('status', 'confirmed');
                } else if (value === 'post-session') {
                  setHideConfirmed(false);
                  handleFilterChange('status', '');
                  // Use client-side filtering for multiple statuses
                  setQuickFilter('post-session');
                } else if (value === 'cancelled') {
                  setHideConfirmed(false);
                  handleFilterChange('status', '');
                  // Use client-side filtering
                  setQuickFilter('cancelled');
                } else if (value === 'red' || value === 'human') {
                  setHideConfirmed(false);
                  handleFilterChange('status', '');
                  setQuickFilter(currentFilter === value ? null : value);
                }
              };

              return (
                <>
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
                </>
              );
            })()}
          </div>

          {/* Secondary Filters - Date range and sort */}
          <div className="flex flex-wrap gap-3 items-center pt-3 border-t border-slate-100">
            <span className="text-xs text-slate-400 uppercase tracking-wide">Date Range</span>
            <input
              type="date"
              value={filters.dateFrom || ''}
              onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            />
            <span className="text-slate-400">to</span>
            <input
              type="date"
              value={filters.dateTo || ''}
              onChange={(e) => handleFilterChange('dateTo', e.target.value)}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            />

            <div className="h-5 w-px bg-slate-200 mx-1" />

            <select
              value={filters.sortBy || 'updatedAt'}
              onChange={(e) => handleFilterChange('sortBy', e.target.value)}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            >
              <option value="updatedAt">Sort by Updated</option>
              <option value="createdAt">Sort by Created</option>
            </select>
          </div>
        </div>

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
          {/* Appointments List - Grouped by Therapist */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">By Therapist</h2>
              <p className="text-sm text-slate-500">
                {therapistGroups.length} therapist{therapistGroups.length !== 1 ? 's' : ''}
                {therapistGroups.reduce((sum, g) => sum + g.pendingCount + g.negotiatingCount, 0) > 0 &&
                  ` • ${therapistGroups.reduce((sum, g) => sum + g.pendingCount + g.negotiatingCount, 0)} active conversations`}
              </p>
            </div>

            {/* FIX M6: Pagination Controls - Always show when there are results */}
            {appointmentsData && appointmentsData.pagination.total > 0 && (
              <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <span className="text-sm text-slate-600">
                  {appointmentsData.pagination.total <= (filters.limit ?? 20) ? (
                    `Showing all ${appointmentsData.pagination.total} appointment${appointmentsData.pagination.total !== 1 ? 's' : ''}`
                  ) : (
                    `Showing ${(((filters.page ?? 1) - 1) * (filters.limit ?? 20)) + 1}-${Math.min((filters.page ?? 1) * (filters.limit ?? 20), appointmentsData.pagination.total)} of ${appointmentsData.pagination.total}`
                  )}
                </span>
                {appointmentsData.pagination.total > (filters.limit ?? 20) && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setFilters(prev => ({ ...prev, page: (prev.page ?? 1) - 1 }))}
                      disabled={(filters.page ?? 1) <= 1}
                      aria-label="Previous page"
                      className="px-3 py-1 text-sm border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ← Prev
                    </button>
                    <span className="px-3 py-1 text-sm text-slate-600">
                      Page {filters.page ?? 1} of {Math.ceil(appointmentsData.pagination.total / (filters.limit ?? 20))}
                    </span>
                    <button
                      onClick={() => setFilters(prev => ({ ...prev, page: (prev.page ?? 1) + 1 }))}
                      disabled={(filters.page ?? 1) >= Math.ceil(appointmentsData.pagination.total / (filters.limit ?? 20))}
                      aria-label="Next page"
                      className="px-3 py-1 text-sm border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next →
                    </button>
                  </div>
                )}
              </div>
            )}

            {loadingList ? (
              <div className="p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800 mx-auto"></div>
                <p className="text-sm text-slate-500 mt-2">Loading...</p>
              </div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto">
                {therapistGroups.length === 0 ? (
                  <div className="p-8 text-center text-slate-500">No appointments found</div>
                ) : (
                  therapistGroups.map((group) => {
                    const isExpanded = expandedTherapists.has(group.therapistNotionId);
                    const hasMultipleUsers = group.appointments.length > 1;

                    return (
                      <div key={group.therapistNotionId} className="border-b border-slate-100 last:border-b-0">
                        {/* Therapist Header */}
                        <button
                          onClick={() => toggleTherapistExpanded(group.therapistNotionId)}
                          aria-expanded={expandedTherapists.has(group.therapistNotionId)}
                          aria-label={`${group.therapistName}: ${group.appointments.length} clients. ${expandedTherapists.has(group.therapistNotionId) ? 'Click to collapse' : 'Click to expand'}`}
                          className={`w-full p-4 text-left hover:bg-slate-50 transition-colors ${
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

                        {/* Expanded User List */}
                        {isExpanded && (
                          <div className="bg-slate-50 divide-y divide-slate-100">
                            {group.appointments.map((apt) => (
                              <div
                                key={apt.id}
                                onClick={() => setSelectedAppointment(apt.id)}
                                className={`p-4 pl-8 cursor-pointer hover:bg-slate-100 transition-colors ${
                                  selectedAppointment === apt.id ? 'bg-primary-50 border-l-4 border-l-spill-blue-800' : ''
                                }`}
                              >
                                <div className="flex justify-between items-start mb-1">
                                  <div className="flex items-start gap-2">
                                    {/* Health indicator */}
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
                                    {/* Progress indicator */}
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
                                {/* Stage label */}
                                {apt.checkpointStage && apt.status !== 'confirmed' && apt.status !== 'cancelled' && (
                                  <p className="text-xs text-slate-600 mb-1 pl-4">
                                    Stage: {getStageLabel(apt.checkpointStage)}
                                  </p>
                                )}
                                {/* Alert badges */}
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
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

          </div>

          {/* Appointment Detail */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            {!selectedAppointment ? (
              <div className="p-8 text-center text-slate-500 h-full flex items-center justify-center min-h-[400px]">
                <div>
                  <svg
                    className="w-12 h-12 text-slate-300 mx-auto mb-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                  <p>Select an appointment to view details</p>
                </div>
              </div>
            ) : loadingDetail ? (
              <div className="p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800 mx-auto"></div>
                <p className="text-sm text-slate-500 mt-2">Loading...</p>
              </div>
            ) : appointmentDetail ? (
              <div className="h-full flex flex-col">
                {/* Detail Header */}
                <div className="p-4 border-b border-slate-100">
                  <div className="flex justify-between items-start">
                    <div>
                      <h2 className="font-semibold text-slate-900">
                        {appointmentDetail.userName || 'Unknown User'}
                      </h2>
                      <p className="text-sm text-slate-500">{appointmentDetail.userEmail}</p>
                    </div>
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(appointmentDetail.status)}`}
                    >
                      {appointmentDetail.status}
                    </span>
                  </div>
                  <div className="mt-3 text-sm text-slate-600">
                    <p>
                      <span className="font-medium">Therapist:</span> {appointmentDetail.therapistName}
                    </p>
                    <p>
                      <span className="font-medium">Email:</span> {appointmentDetail.therapistEmail}
                    </p>
                  </div>
                  {appointmentDetail.confirmedAt && (
                    <div className="mt-3 p-3 bg-green-50 rounded-lg border border-green-200">
                      <p className="text-sm font-medium text-green-700">
                        Confirmed: {appointmentDetail.confirmedDateTime || new Date(appointmentDetail.confirmedAt).toLocaleString()}
                      </p>
                      <p className="text-xs text-green-600 mt-1">
                        on {new Date(appointmentDetail.confirmedAt).toLocaleString()}
                      </p>
                    </div>
                  )}
                  {/* Thread IDs for debugging */}
                  {(appointmentDetail.gmailThreadId || appointmentDetail.therapistGmailThreadId) && (
                    <div className="mt-3 p-2 bg-slate-50 rounded-lg border border-slate-200">
                      <p className="text-xs font-medium text-slate-500 mb-1">Email Thread IDs</p>
                      {appointmentDetail.gmailThreadId && (
                        <p className="text-xs text-slate-400 font-mono">
                          Client: {appointmentDetail.gmailThreadId}
                        </p>
                      )}
                      {appointmentDetail.therapistGmailThreadId && (
                        <p className="text-xs text-slate-400 font-mono">
                          Therapist: {appointmentDetail.therapistGmailThreadId}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Human Control Panel */}
                <div className="p-4 border-b border-slate-100 bg-slate-50">
                  {/* Mutation Error Display */}
                  {mutationError && (
                    <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex justify-between items-start">
                        <p className="text-sm text-red-700">{mutationError}</p>
                        <button
                          onClick={() => setMutationError(null)}
                          aria-label="Dismiss error message"
                          className="text-red-500 hover:text-red-700"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  )}

                  {!appointmentDetail.humanControlEnabled ? (
                    <div>
                      <input
                        type="text"
                        placeholder="Reason for taking control (optional)"
                        value={controlReason}
                        onChange={(e) => setControlReason(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-2 focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none"
                      />
                      <button
                        onClick={() =>
                          takeControlMutation.mutate({
                            id: appointmentDetail.id,
                            reason: controlReason || undefined,
                          })
                        }
                        disabled={takeControlMutation.isPending}
                        aria-label="Take human control and pause AI agent"
                        aria-busy={takeControlMutation.isPending}
                        className="w-full px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 font-medium"
                      >
                        {takeControlMutation.isPending
                          ? 'Taking Control...'
                          : 'Take Human Control (Pause Agent)'}
                      </button>
                      <p className="text-xs text-slate-500 mt-2 text-center">
                        Take control to edit status or confirmed time
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Control Status */}
                      <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
                        <p className="font-medium text-orange-800">Human Control Active</p>
                        <p className="text-sm text-orange-700">
                          Taken by: {appointmentDetail.humanControlTakenBy || 'Unknown'}
                          {appointmentDetail.humanControlTakenAt &&
                            ` at ${new Date(appointmentDetail.humanControlTakenAt).toLocaleString()}`}
                        </p>
                        {appointmentDetail.humanControlReason && (
                          <p className="text-sm text-orange-600 mt-1">
                            Reason: {appointmentDetail.humanControlReason}
                          </p>
                        )}
                      </div>

                      {/* Resume Button */}
                      <button
                        onClick={() => releaseControlMutation.mutate(appointmentDetail.id)}
                        disabled={releaseControlMutation.isPending}
                        aria-label="Release human control and resume AI agent"
                        aria-busy={releaseControlMutation.isPending}
                        className="w-full px-4 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 font-medium"
                      >
                        {releaseControlMutation.isPending
                          ? 'Resuming Agent...'
                          : 'Resume Agent (Release Control)'}
                      </button>

                      {/* Edit Status / Confirmed Time Panel */}
                      {!showEditPanel ? (
                        <button
                          onClick={() => setShowEditPanel(true)}
                          aria-label="Edit appointment status and confirmed time"
                          className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors font-medium"
                        >
                          Edit Status / Confirmed Time
                        </button>
                      ) : (
                        <div className="p-3 border border-slate-200 rounded-lg bg-white">
                          <h4 className="font-medium text-slate-800 mb-2">Edit Appointment</h4>

                          {/* Status Dropdown */}
                          <div className="mb-2">
                            <label className="text-sm text-slate-600 block mb-1">Status:</label>
                            <select
                              value={editStatus || ''}
                              onChange={(e) => setEditStatus(e.target.value)}
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                            >
                              <option value="pending">Pending</option>
                              <option value="contacted">Contacted</option>
                              <option value="negotiating">Negotiating</option>
                              <option value="confirmed">Confirmed</option>
                              <option value="session_held">Session Held</option>
                              <option value="feedback_requested">Feedback Requested</option>
                              <option value="completed">Completed</option>
                              <option value="cancelled">Cancelled</option>
                            </select>
                          </div>

                          {/* Confirmed DateTime (only shown when status is confirmed) */}
                          {editStatus === 'confirmed' && (
                            <div className="mb-2">
                              <label className="text-sm text-slate-600 block mb-1">
                                Confirmed Date/Time:
                                <span className="text-red-500 ml-1">*</span>
                              </label>
                              <input
                                type="text"
                                value={editConfirmedDateTime}
                                onChange={(e) => setEditConfirmedDateTime(e.target.value)}
                                placeholder="e.g., Tuesday 15th January at 2pm"
                                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                              />
                              <p className="text-xs text-slate-500 mt-1">
                                Enter the agreed appointment date and time
                              </p>
                            </div>
                          )}

                          {/* Warning for unusual transitions */}
                          {editStatus === 'pending' && appointmentDetail.status !== 'pending' && (
                            <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                              <p className="text-xs text-yellow-800">
                                ⚠️ Reverting to pending is unusual. Previous status: {appointmentDetail.status}
                              </p>
                            </div>
                          )}
                          {editStatus === 'cancelled' && appointmentDetail.status === 'confirmed' && (
                            <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded">
                              <p className="text-xs text-red-800">
                                ⚠️ Cancelling a confirmed appointment. The therapist will be unfrozen.
                              </p>
                            </div>
                          )}

                          {/* Edit warning from response */}
                          {editWarning && (
                            <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                              <p className="text-xs text-yellow-800">{editWarning}</p>
                            </div>
                          )}

                          {/* Actions */}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setShowEditPanel(false);
                                // Reset to original values
                                setEditStatus(appointmentDetail.status);
                                setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
                              }}
                              aria-label="Cancel edit"
                              className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => {
                                updateAppointmentMutation.mutate({
                                  id: appointmentDetail.id,
                                  status: editStatus || undefined,
                                  // Only send confirmedDateTime if status is confirmed, otherwise don't send it at all
                                  // (undefined means "don't change", null would clear it)
                                  confirmedDateTime: editStatus === 'confirmed' ? editConfirmedDateTime : undefined,
                                });
                              }}
                              disabled={
                                updateAppointmentMutation.isPending ||
                                (editStatus === 'confirmed' && !editConfirmedDateTime.trim())
                              }
                              aria-label="Save appointment changes"
                              aria-busy={updateAppointmentMutation.isPending}
                              className="flex-1 px-3 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
                            >
                              {updateAppointmentMutation.isPending ? 'Saving...' : 'Save Changes'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Compose Message Toggle */}
                      {!showComposeMessage ? (
                        <button
                          onClick={() => setShowComposeMessage(true)}
                          aria-label="Open message composer"
                          className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors font-medium"
                        >
                          Compose Message
                        </button>
                      ) : (
                        <div className="p-3 border border-slate-200 rounded-lg bg-white">
                          <h4 className="font-medium text-slate-800 mb-2">Send Message</h4>

                          {/* Recipient Select */}
                          <div className="mb-2">
                            <label className="text-sm text-slate-600 block mb-1">To:</label>
                            <select
                              value={messageRecipient}
                              onChange={(e) =>
                                setMessageRecipient(e.target.value as 'client' | 'therapist')
                              }
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                            >
                              <option value="client">
                                Client ({appointmentDetail.userEmail})
                              </option>
                              <option value="therapist">
                                Therapist ({appointmentDetail.therapistEmail})
                              </option>
                            </select>
                          </div>

                          {/* Subject */}
                          <div className="mb-2">
                            <label className="text-sm text-slate-600 block mb-1">Subject:</label>
                            <input
                              type="text"
                              value={messageSubject}
                              onChange={(e) => setMessageSubject(e.target.value)}
                              placeholder="Email subject"
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                            />
                          </div>

                          {/* Body */}
                          <div className="mb-3">
                            <label className="text-sm text-slate-600 block mb-1">Message:</label>
                            <textarea
                              value={messageBody}
                              onChange={(e) => setMessageBody(e.target.value)}
                              placeholder="Type your message..."
                              rows={4}
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none resize-none"
                            />
                          </div>

                          {/* Actions */}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setShowComposeMessage(false);
                                setMessageSubject('');
                                setMessageBody('');
                              }}
                              aria-label="Cancel message composition"
                              className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleSendMessage}
                              disabled={
                                sendMessageMutation.isPending ||
                                !messageSubject.trim() ||
                                !messageBody.trim()
                              }
                              aria-label="Send message to recipient"
                              aria-busy={sendMessageMutation.isPending}
                              className="flex-1 px-3 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
                            >
                              {sendMessageMutation.isPending ? 'Sending...' : 'Send'}
                            </button>
                          </div>

                          {sendMessageMutation.isError && (
                            <p className="text-red-500 text-xs mt-2">
                              {sendMessageMutation.error instanceof Error
                                ? sendMessageMutation.error.message
                                : 'Failed to send message'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Delete Appointment Section */}
                  <div className="mt-4 pt-4 border-t border-slate-200">
                    {!showDeleteConfirm ? (
                      <button
                        onClick={() => setShowDeleteConfirm(true)}
                        aria-label="Show delete appointment confirmation"
                        className="w-full px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors font-medium text-sm"
                      >
                        Delete Appointment
                      </button>
                    ) : (
                      <div className="p-3 border border-red-200 rounded-lg bg-red-50">
                        <h4 className="font-medium text-red-800 mb-2">⚠️ Delete Appointment?</h4>
                        <p className="text-sm text-red-700 mb-3">
                          This will permanently delete this appointment request and all conversation history.
                          This action cannot be undone.
                        </p>

                        {/* Extra warning for confirmed appointments */}
                        {appointmentDetail.status === 'confirmed' && (
                          <div className="mb-3 p-2 bg-red-100 border border-red-300 rounded">
                            <p className="text-sm text-red-800 font-medium mb-2">
                              ⚠️ This is a CONFIRMED appointment!
                            </p>
                            <p className="text-xs text-red-700 mb-2">
                              Deleting this will also unfreeze the therapist, allowing them to accept new bookings.
                              Only delete if the session did NOT take place.
                            </p>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={forceDeleteConfirmed}
                                onChange={(e) => setForceDeleteConfirmed(e.target.checked)}
                                className="w-4 h-4 text-red-600 border-red-300 rounded focus:ring-red-500"
                              />
                              <span className="text-sm text-red-800 font-medium">
                                I confirm the session did NOT take place
                              </span>
                            </label>
                          </div>
                        )}

                        <div className="mb-3">
                          <label className="text-sm text-red-700 block mb-1">Reason (optional):</label>
                          <input
                            type="text"
                            value={deleteReason}
                            onChange={(e) => setDeleteReason(e.target.value)}
                            placeholder="Why are you deleting this appointment?"
                            className="w-full px-3 py-2 border border-red-200 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setShowDeleteConfirm(false);
                              setDeleteReason('');
                              setForceDeleteConfirmed(false);
                            }}
                            aria-label="Cancel deletion"
                            className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-white transition-colors text-sm"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() =>
                              deleteAppointmentMutation.mutate({
                                id: appointmentDetail.id,
                                reason: deleteReason || undefined,
                                forceDeleteConfirmed: appointmentDetail.status === 'confirmed' ? true : undefined,
                              })
                            }
                            disabled={
                              deleteAppointmentMutation.isPending ||
                              (appointmentDetail.status === 'confirmed' && !forceDeleteConfirmed)
                            }
                            aria-label="Confirm permanent deletion of appointment"
                            aria-busy={deleteAppointmentMutation.isPending}
                            className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 text-sm font-medium"
                          >
                            {deleteAppointmentMutation.isPending ? 'Deleting...' : 'Yes, Delete'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Conversation */}
                <div className="flex-1 overflow-y-auto p-4 max-h-[450px]">
                  <h3 className="font-medium text-slate-700 mb-3">Conversation History</h3>
                  {appointmentDetail.conversation?.messages &&
                  appointmentDetail.conversation.messages.length > 0 ? (
                    <div className="space-y-3">
                      {appointmentDetail.conversation.messages.map((msg, idx) => (
                        <div
                          key={idx}
                          className={`p-3 rounded-lg ${
                            msg.role === 'assistant'
                              ? 'bg-primary-50 border border-primary-100'
                              : msg.role === 'admin'
                                ? 'bg-orange-50 border border-orange-100'
                                : 'bg-slate-100 border border-slate-200'
                          }`}
                        >
                          <p
                            className={`text-xs font-medium mb-1 ${
                              msg.role === 'admin' ? 'text-orange-600' : 'text-slate-500'
                            }`}
                          >
                            {msg.role === 'assistant'
                              ? APP.COORDINATOR_NAME
                              : msg.role === 'admin'
                                ? 'Admin (Human)'
                                : 'Email Received'}
                          </p>
                          <p className="text-sm text-slate-800 whitespace-pre-wrap">{sanitizeText(msg.content)}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-500 text-sm">No conversation history</p>
                  )}
                </div>
              </div>
            ) : null}
          </div>
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
