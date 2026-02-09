import { useState, useMemo } from 'react';
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
} from '../api/client';
import type { AppointmentFilters, AppointmentListItem } from '../types';
import { APP } from '../config/constants';
import { getStatusColor } from '../config/color-mappings';

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
  hasConfirmed: boolean;
  pendingCount: number;
  inProgressCount: number;
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

    // Filter out confirmed if hideConfirmed is true
    const filteredAppointments = hideConfirmed
      ? appointmentsData.data.filter((apt) => apt.status !== 'confirmed')
      : appointmentsData.data;

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

    // Sort groups: those without any confirmed bookings first (need attention)
    return Array.from(groups.values()).sort((a, b) => {
      // First sort by whether they have confirmed (no confirmed = higher priority)
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
  }, [appointmentsData?.data, hideConfirmed]);

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

        {/* Filters */}
        <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100 mb-6">
          <div className="flex flex-wrap gap-4 items-center">
            {/* Hide Confirmed Toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={hideConfirmed}
                onChange={(e) => setHideConfirmed(e.target.checked)}
                className="w-4 h-4 text-spill-blue border-slate-300 rounded focus:ring-spill-blue"
              />
              <span className="text-sm text-slate-700">Hide confirmed</span>
            </label>

            <div className="h-6 w-px bg-slate-200" />

            <select
              value={filters.status || 'all'}
              onChange={(e) => handleFilterChange('status', e.target.value === 'all' ? '' : e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
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
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
            />
            <input
              type="date"
              placeholder="To date"
              value={filters.dateTo || ''}
              onChange={(e) => handleFilterChange('dateTo', e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
            />
            <select
              value={filters.sortBy || 'updatedAt'}
              onChange={(e) => handleFilterChange('sortBy', e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
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
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue mx-auto"></div>
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
                            !group.hasConfirmed ? 'bg-amber-50' : ''
                          }`}
                        >
                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-semibold text-slate-900">{group.therapistName}</p>
                                {!group.hasConfirmed && (
                                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-200 text-amber-800">
                                    Needs booking
                                  </span>
                                )}
                                {group.hasConfirmed && (
                                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">
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
                                  selectedAppointment === apt.id ? 'bg-primary-50 border-l-4 border-l-spill-blue' : ''
                                }`}
                              >
                                <div className="flex justify-between items-start mb-1">
                                  <div>
                                    <p className="font-medium text-slate-900">
                                      {apt.userName || apt.userEmail}
                                    </p>
                                    <p className="text-xs text-slate-500">{apt.userEmail}</p>
                                  </div>
                                  <div className="flex flex-col gap-1 items-end">
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
                                    {apt.isStale && (
                                      <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800">
                                        ⚠️ 48h+ No Reply
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex gap-3 text-xs text-slate-500">
                                  <span>{apt.messageCount} msgs</span>
                                  <span>{new Date(apt.updatedAt).toLocaleDateString()}</span>
                                </div>
                                {apt.status === 'confirmed' && apt.confirmedDateTime && (
                                  <p className="text-xs text-green-600 mt-1 font-medium">
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
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue mx-auto"></div>
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
                        className="w-full px-4 py-2 bg-spill-blue text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 font-medium"
                      >
                        {releaseControlMutation.isPending
                          ? 'Resuming Agent...'
                          : 'Resume Agent (Release Control)'}
                      </button>

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
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
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
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
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
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none resize-none"
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
                              className="flex-1 px-3 py-2 bg-spill-blue text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
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
