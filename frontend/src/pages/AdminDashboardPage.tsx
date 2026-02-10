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

// Get and set admin name for audit trail
function getAdminName(): string {
  return localStorage.getItem('admin_name') || '';
}

function setAdminNameStorage(name: string): void {
  localStorage.setItem('admin_name', name);
}

// Group appointments by therapist
interface TherapistGroup {
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  appointments: AppointmentListItem[];
  hasConfirmed: boolean;
  pendingCount: number;
  inProgressCount: number;
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
  const [quickFilter, setQuickFilter] = useState<'red' | 'human' | null>(null);

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

  // Admin identity for audit trail
  const [adminName, setAdminName] = useState(getAdminName);
  const [showAdminNamePrompt, setShowAdminNamePrompt] = useState(!getAdminName());

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

    // Filter out confirmed if hideConfirmed is true
    if (hideConfirmed) {
      filteredAppointments = filteredAppointments.filter((apt) => apt.status !== 'confirmed');
    }

    // Apply quick filter
    if (quickFilter === 'red') {
      filteredAppointments = filteredAppointments.filter((apt) => apt.healthStatus === 'red');
    } else if (quickFilter === 'human') {
      filteredAppointments = filteredAppointments.filter((apt) => apt.humanControlEnabled);
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
          hasConfirmed: false,
          pendingCount: 0,
          inProgressCount: 0,
          healthRed: 0,
          healthYellow: 0,
        });
      }
      const group = groups.get(key)!;
      group.appointments.push(apt);

      if (apt.status === 'confirmed') {
        group.hasConfirmed = true;
      } else if (apt.status === 'pending') {
        group.pendingCount++;
      } else if (apt.status === 'contacted' || apt.status === 'negotiating') {
        group.inProgressCount++;
      }

      // Track health counts (only for non-terminal statuses)
      if (apt.status !== 'confirmed' && apt.status !== 'cancelled') {
        if (apt.healthStatus === 'red') {
          group.healthRed++;
        } else if (apt.healthStatus === 'yellow') {
          group.healthYellow++;
        }
      }
    }

    // Check confirmed status from full data (not filtered)
    if (hideConfirmed) {
      for (const apt of appointmentsData.data) {
        if (apt.status === 'confirmed') {
          const group = groups.get(apt.therapistNotionId);
          if (group) {
            group.hasConfirmed = true;
          }
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
      // Then by whether they have confirmed (no confirmed = higher priority)
      if (a.hasConfirmed !== b.hasConfirmed) {
        return a.hasConfirmed ? 1 : -1;
      }
      // Then by pending count (more pending = higher priority)
      if (a.pendingCount !== b.pendingCount) {
        return b.pendingCount - a.pendingCount;
      }
      // Then by in-progress count
      return b.inProgressCount - a.inProgressCount;
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
      takeControl(id, { adminId: adminName || 'admin', reason }),
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
    }) => sendAdminMessage(id, { to, subject, body, adminId: adminName || 'admin' }),
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
      deleteAppointment(id, { adminId: adminName || 'admin', reason, forceDeleteConfirmed: force }),
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
        adminId: adminName || 'admin',
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
        {/* Admin Name Prompt */}
        {showAdminNamePrompt && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-xl">
            <h3 className="font-medium text-blue-900 mb-2">Welcome! Please enter your name</h3>
            <p className="text-sm text-blue-700 mb-3">
              Your name will be used in the audit trail when you take actions.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="e.g., Harry, Sarah, etc."
                className="flex-1 px-3 py-2 border border-blue-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
              <button
                onClick={() => {
                  if (adminName.trim()) {
                    setAdminNameStorage(adminName.trim());
                    setShowAdminNamePrompt(false);
                  }
                }}
                disabled={!adminName.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 font-medium"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Scheduling Dashboard</h1>
            <p className="text-slate-600 mt-1">Monitor and manage appointment requests</p>
          </div>
          {adminName && !showAdminNamePrompt && (
            <div className="text-right">
              <p className="text-sm text-slate-500">Logged in as</p>
              <button
                onClick={() => setShowAdminNamePrompt(true)}
                className="text-sm font-medium text-spill-blue-800 hover:underline"
              >
                {adminName} ✎
              </button>
            </div>
          )}
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100">
              <p className="text-sm text-slate-500">Pending</p>
              <p className="text-2xl font-bold text-yellow-600">{stats.byStatus.pending || 0}</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100">
              <p className="text-sm text-slate-500">In Progress</p>
              <p className="text-2xl font-bold text-blue-600">
                {(stats.byStatus.contacted || 0) + (stats.byStatus.negotiating || 0)}
              </p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100">
              <p className="text-sm text-slate-500">Confirmed (7d)</p>
              <p className="text-2xl font-bold text-green-600">{stats.confirmedLast7Days}</p>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100">
              <p className="text-sm text-slate-500">Total Confirmed</p>
              <p className="text-2xl font-bold text-slate-900">{stats.byStatus.confirmed || 0}</p>
            </div>
          </div>
        )}

        {/* Health Summary Cards */}
        {appointmentsData?.data && appointmentsData.data.length > 0 && (
          <div className="grid grid-cols-3 gap-4 mb-6">
            {(() => {
              const activeAppointments = appointmentsData.data.filter(
                (apt) => apt.status !== 'confirmed' && apt.status !== 'cancelled'
              );
              const healthCounts = activeAppointments.reduce(
                (acc, apt) => {
                  // Validate health status before incrementing to prevent unexpected keys
                  if (apt.healthStatus && ['green', 'yellow', 'red'].includes(apt.healthStatus)) {
                    acc[apt.healthStatus as HealthStatus]++;
                  }
                  return acc;
                },
                { green: 0, yellow: 0, red: 0 } as Record<HealthStatus, number>
              );
              return (
                <>
                  <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-l-spill-teal-400">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 bg-spill-teal-400 rounded-full" />
                      <p className="text-sm text-slate-500">Healthy</p>
                    </div>
                    <p className="text-2xl font-bold text-spill-teal-600">{healthCounts.green}</p>
                  </div>
                  <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-l-spill-yellow-400">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 bg-spill-yellow-400 rounded-full" />
                      <p className="text-sm text-slate-500">Monitoring</p>
                    </div>
                    <p className="text-2xl font-bold text-spill-yellow-600">{healthCounts.yellow}</p>
                  </div>
                  <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-l-spill-red-400">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 bg-spill-red-400 rounded-full animate-pulse" />
                      <p className="text-sm text-slate-500">Needs Attention</p>
                    </div>
                    <p className="text-2xl font-bold text-spill-red-600">{healthCounts.red}</p>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* Control Status Summary */}
        {appointmentsData?.data && appointmentsData.data.length > 0 && (
          <div className="grid grid-cols-2 gap-4 mb-6">
            {(() => {
              const activeAppointments = appointmentsData.data.filter(
                (apt) => apt.status !== 'confirmed' && apt.status !== 'cancelled'
              );
              const humanControlCount = activeAppointments.filter((apt) => apt.humanControlEnabled).length;
              const agentControlCount = activeAppointments.length - humanControlCount;
              return (
                <>
                  <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-l-spill-blue-800">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">🤖</span>
                      <p className="text-sm text-slate-500">Agent Control</p>
                    </div>
                    <p className="text-2xl font-bold text-spill-blue-800">{agentControlCount}</p>
                  </div>
                  <div className="bg-white rounded-xl p-4 shadow-sm border-l-4 border-l-orange-400">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">👤</span>
                      <p className="text-sm text-slate-500">Human Control</p>
                    </div>
                    <p className="text-2xl font-bold text-orange-600">{humanControlCount}</p>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* Quick Filters */}
        {appointmentsData?.data && appointmentsData.data.length > 0 && (
          <div className="flex gap-2 mb-4">
            {(() => {
              const activeAppointments = appointmentsData.data.filter(
                (apt) => apt.status !== 'confirmed' && apt.status !== 'cancelled'
              );
              const redCount = activeAppointments.filter((apt) => apt.healthStatus === 'red').length;
              const humanCount = activeAppointments.filter((apt) => apt.humanControlEnabled).length;
              return (
                <>
                  <button
                    onClick={() => setQuickFilter(quickFilter === 'red' ? null : 'red')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
                      quickFilter === 'red'
                        ? 'bg-spill-red-600 text-white'
                        : 'bg-spill-red-100 text-spill-red-600 hover:bg-spill-red-200'
                    }`}
                  >
                    Needs Attention ({redCount})
                  </button>
                  <button
                    onClick={() => setQuickFilter(quickFilter === 'human' ? null : 'human')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
                      quickFilter === 'human'
                        ? 'bg-orange-600 text-white'
                        : 'bg-orange-100 text-orange-600 hover:bg-orange-200'
                    }`}
                  >
                    Human Control ({humanCount})
                  </button>
                  {quickFilter && (
                    <button
                      onClick={() => setQuickFilter(null)}
                      className="px-3 py-1.5 text-sm font-medium rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                    >
                      Clear Filter
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100 mb-6">
          <div className="flex flex-wrap gap-4 items-center">
            {/* Hide Confirmed Toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={hideConfirmed}
                onChange={(e) => setHideConfirmed(e.target.checked)}
                className="w-4 h-4 text-spill-blue-800 border-slate-300 rounded focus:ring-spill-blue-800"
              />
              <span className="text-sm text-slate-700">Hide confirmed</span>
            </label>

            <div className="h-6 w-px bg-slate-200" />

            <select
              value={filters.status || 'all'}
              onChange={(e) => handleFilterChange('status', e.target.value === 'all' ? '' : e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="contacted">Contacted</option>
              <option value="negotiating">Negotiating</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <input
              type="date"
              placeholder="From date"
              value={filters.dateFrom || ''}
              onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            />
            <input
              type="date"
              placeholder="To date"
              value={filters.dateTo || ''}
              onChange={(e) => handleFilterChange('dateTo', e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            />
            <select
              value={filters.sortBy || 'updatedAt'}
              onChange={(e) => handleFilterChange('sortBy', e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            >
              <option value="updatedAt">Sort by Updated</option>
              <option value="createdAt">Sort by Created</option>
              <option value="status">Sort by Status</option>
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
                {therapistGroups.length} therapists
                {hideConfirmed && ` • ${therapistGroups.filter(g => !g.hasConfirmed).length} need booking`}
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
                            group.healthRed > 0 ? 'bg-spill-red-100' : !group.hasConfirmed ? 'bg-spill-yellow-100' : ''
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
                                {!group.hasConfirmed && group.healthRed === 0 && (
                                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-yellow-200 text-spill-yellow-600">
                                    Needs booking
                                  </span>
                                )}
                                {group.hasConfirmed && group.healthRed === 0 && group.healthYellow === 0 && (
                                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-teal-100 text-spill-teal-600">
                                    ✓ Has booking
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-slate-500 mt-0.5">
                                {group.appointments.length} client{group.appointments.length !== 1 ? 's' : ''} requesting
                                {group.pendingCount > 0 && ` • ${group.pendingCount} pending`}
                                {group.inProgressCount > 0 && ` • ${group.inProgressCount} in progress`}
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
