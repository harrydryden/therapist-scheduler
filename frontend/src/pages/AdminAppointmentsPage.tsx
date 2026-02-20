import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAdminUsers,
  getAdminTherapists,
  getAllAppointments,
  createAdminAppointment,
} from '../api/client';
import type {
  AdminUser,
  AdminTherapist,
  AdminAppointmentStage,
} from '../types';

// Status badge colors (same as existing dashboard)
const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  contacted: 'bg-blue-100 text-blue-800',
  negotiating: 'bg-purple-100 text-purple-800',
  confirmed: 'bg-green-100 text-green-800',
  session_held: 'bg-teal-100 text-teal-800',
  feedback_requested: 'bg-orange-100 text-orange-800',
  completed: 'bg-slate-100 text-slate-600',
  cancelled: 'bg-red-100 text-red-800',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  contacted: 'Contacted',
  negotiating: 'Negotiating',
  confirmed: 'Confirmed',
  session_held: 'Session Held',
  feedback_requested: 'Feedback Req.',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STAGE_OPTIONS: { value: AdminAppointmentStage; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'session_held', label: 'Session Held' },
  { value: 'feedback_requested', label: 'Feedback Requested' },
];

const ACTIVE_STATUSES = ['pending', 'contacted', 'negotiating', 'confirmed', 'session_held', 'feedback_requested'];

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-600'}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

// ============================================
// Searchable Dropdown Component
// ============================================

function SearchableSelect<T extends { label: string; value: string }>({
  options,
  value,
  onChange,
  placeholder,
  isLoading,
}: {
  options: T[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  isLoading?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const filtered = useMemo(() => {
    if (!search) return options;
    const lower = search.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(lower));
  }, [options, search]);

  const selectedLabel = options.find((o) => o.value === value)?.label;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 text-left border border-slate-200 rounded-lg bg-white text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
      >
        {isLoading ? (
          <span className="text-slate-400">Loading...</span>
        ) : selectedLabel ? (
          <span className="text-slate-900">{selectedLabel}</span>
        ) : (
          <span className="text-slate-400">{placeholder}</span>
        )}
        <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-hidden">
            <div className="p-2 border-b border-slate-100">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded focus:ring-1 focus:ring-spill-blue-800 outline-none"
                autoFocus
              />
            </div>
            <div className="overflow-y-auto max-h-48">
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-sm text-slate-400">No results found</div>
              ) : (
                filtered.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onChange(option.value);
                      setIsOpen(false);
                      setSearch('');
                    }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                      option.value === value ? 'bg-spill-blue-50 text-spill-blue-800' : 'text-slate-700'
                    }`}
                  >
                    {option.label}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================
// Create Appointment Form
// ============================================

function CreateAppointmentForm({ onSuccess }: { onSuccess: () => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [userMode, setUserMode] = useState<'existing' | 'new'>('existing');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [selectedTherapistNotionId, setSelectedTherapistNotionId] = useState('');
  const [stage, setStage] = useState<AdminAppointmentStage>('confirmed');
  const [confirmedDateTime, setConfirmedDateTime] = useState('');
  const [notes, setNotes] = useState('');
  const [successData, setSuccessData] = useState<{ trackingCode: string; id: string } | null>(null);

  const queryClient = useQueryClient();

  const { data: users = [], isLoading: loadingUsers } = useQuery({
    queryKey: ['admin-users'],
    queryFn: getAdminUsers,
    staleTime: 60000,
  });

  const { data: therapists = [], isLoading: loadingTherapists } = useQuery({
    queryKey: ['admin-therapists'],
    queryFn: getAdminTherapists,
    staleTime: 60000,
  });

  const userOptions = useMemo(() =>
    users.map((u: AdminUser) => ({
      value: u.id,
      label: `${u.name || 'Unnamed'} (${u.email})`,
      email: u.email,
      name: u.name,
    })),
    [users]
  );

  const therapistOptions = useMemo(() =>
    therapists.map((t: AdminTherapist) => ({
      value: t.notionId,
      label: `${t.name} (${t.email})`,
    })),
    [therapists]
  );

  const createMutation = useMutation({
    mutationFn: createAdminAppointment,
    onSuccess: (data) => {
      setSuccessData({ trackingCode: data.trackingCode, id: data.id });
      setSelectedUserId('');
      setNewUserEmail('');
      setNewUserName('');
      setSelectedTherapistNotionId('');
      setStage('confirmed');
      setConfirmedDateTime('');
      setNotes('');
      setUserMode('existing');
      queryClient.invalidateQueries({ queryKey: ['admin-all-appointments'] });
      onSuccess();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessData(null);

    let userEmail: string;
    let userName: string;

    if (userMode === 'existing') {
      const selectedUser = users.find((u: AdminUser) => u.id === selectedUserId);
      if (!selectedUser) return;
      userEmail = selectedUser.email;
      userName = selectedUser.name || selectedUser.email;
    } else {
      userEmail = newUserEmail;
      userName = newUserName;
    }

    if (!userEmail || !userName || !selectedTherapistNotionId || !confirmedDateTime) return;

    createMutation.mutate({
      userEmail,
      userName,
      therapistNotionId: selectedTherapistNotionId,
      stage,
      confirmedDateTime: new Date(confirmedDateTime).toISOString(),
      adminId: 'admin',
      notes: notes || undefined,
    });
  };

  const isFormValid = userMode === 'existing'
    ? !!selectedUserId && !!selectedTherapistNotionId && !!confirmedDateTime
    : !!newUserEmail && !!newUserName && !!selectedTherapistNotionId && !!confirmedDateTime;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <button
        type="button"
        onClick={() => {
          setIsExpanded(!isExpanded);
          setSuccessData(null);
        }}
        className="w-full px-6 py-4 flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-spill-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <h2 className="text-lg font-semibold text-slate-900">Create Appointment</h2>
        </div>
        <svg
          className={`w-5 h-5 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-6 pb-6 border-t border-slate-100">
          {successData && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="font-medium text-green-800">Appointment created successfully</span>
              </div>
              <p className="mt-1 text-sm text-green-700">
                Tracking Code: <span className="font-mono font-bold">{successData.trackingCode}</span>
              </p>
            </div>
          )}

          {createMutation.isError && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">
                {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create appointment'}
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {/* User Selection */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-slate-700">User</label>
                <button
                  type="button"
                  onClick={() => setUserMode(userMode === 'existing' ? 'new' : 'existing')}
                  className="text-xs text-spill-blue-600 hover:text-spill-blue-800"
                >
                  {userMode === 'existing' ? 'Add new user' : 'Select existing user'}
                </button>
              </div>
              {userMode === 'existing' ? (
                <SearchableSelect
                  options={userOptions}
                  value={selectedUserId}
                  onChange={setSelectedUserId}
                  placeholder="Select a user..."
                  isLoading={loadingUsers}
                />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    placeholder="Name"
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                  />
                  <input
                    type="email"
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    placeholder="Email"
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                  />
                </div>
              )}
            </div>

            {/* Therapist Selection */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Therapist</label>
              <SearchableSelect
                options={therapistOptions}
                value={selectedTherapistNotionId}
                onChange={setSelectedTherapistNotionId}
                placeholder="Select a therapist..."
                isLoading={loadingTherapists}
              />
            </div>

            {/* Stage + DateTime Row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Stage</label>
                <select
                  value={stage}
                  onChange={(e) => setStage(e.target.value as AdminAppointmentStage)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                >
                  {STAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Appointment Date/Time</label>
                <input
                  type="datetime-local"
                  value={confirmedDateTime}
                  onChange={(e) => setConfirmedDateTime(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Notes (optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Admin notes about this appointment..."
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none resize-none"
              />
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={!isFormValid || createMutation.isPending}
              className="px-6 py-2.5 bg-spill-blue-800 text-white rounded-lg text-sm font-medium hover:bg-spill-blue-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Appointment'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// ============================================
// Appointments Table
// ============================================

function AppointmentsTable() {
  const [showCompleted, setShowCompleted] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>('updatedAt');
  const [sortOrder, setSortOrder] = useState<string>('desc');
  const limit = 20;

  const statusFilter = useMemo(() => {
    const statuses = [...ACTIVE_STATUSES];
    if (showCompleted) statuses.push('completed');
    if (showCancelled) statuses.push('cancelled');
    return statuses.join(',');
  }, [showCompleted, showCancelled]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-all-appointments', statusFilter, search, page, limit, sortBy, sortOrder],
    queryFn: () => getAllAppointments({
      status: statusFilter,
      search: search || undefined,
      page,
      limit,
      sortBy,
      sortOrder,
    }),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const appointments = data?.data || [];
  const pagination = data?.pagination;

  const handleSort = useCallback((column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
    setPage(1);
  }, [sortBy, sortOrder]);

  const SortIcon = ({ column }: { column: string }) => {
    if (sortBy !== column) return null;
    return (
      <svg className="inline w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d={sortOrder === 'desc' ? 'M19 9l-7 7-7-7' : 'M5 15l7-7 7 7'} />
      </svg>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">All Appointments</h2>
          <div className="flex items-center gap-4 flex-wrap">
            {/* Search */}
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search user or therapist..."
                className="pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none w-56 sm:w-64"
              />
            </div>
            {/* Toggles */}
            <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(e) => { setShowCompleted(e.target.checked); setPage(1); }}
                className="rounded border-slate-300 text-spill-blue-800 focus:ring-spill-blue-800"
              />
              Completed
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={showCancelled}
                onChange={(e) => { setShowCancelled(e.target.checked); setPage(1); }}
                className="rounded border-slate-300 text-spill-blue-800 focus:ring-spill-blue-800"
              />
              Cancelled
            </label>
          </div>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 border-t-spill-blue-800" />
        </div>
      ) : error ? (
        <div className="px-6 py-8 text-center text-red-600 text-sm">
          {error instanceof Error ? error.message : 'Failed to load appointments'}
        </div>
      ) : appointments.length === 0 ? (
        <div className="px-6 py-12 text-center text-slate-400 text-sm">
          No appointments found
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-3 text-left font-medium text-slate-500">
                  <button type="button" onClick={() => handleSort('status')} className="hover:text-slate-700">
                    Status <SortIcon column="status" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">User</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Therapist</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Confirmed Date/Time</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Tracking Code</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">
                  <button type="button" onClick={() => handleSort('createdAt')} className="hover:text-slate-700">
                    Created <SortIcon column="createdAt" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">
                  <button type="button" onClick={() => handleSort('updatedAt')} className="hover:text-slate-700">
                    Updated <SortIcon column="updatedAt" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((apt) => (
                <tr
                  key={apt.id}
                  className="border-b border-slate-50 hover:bg-slate-50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <StatusBadge status={apt.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900 truncate max-w-[180px]">{apt.userName || '-'}</div>
                    <div className="text-xs text-slate-500 truncate max-w-[180px]">{apt.userEmail}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900 truncate max-w-[160px]">{apt.therapistName}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {formatDateTime(apt.confirmedDateTime)}
                  </td>
                  <td className="px-4 py-3">
                    {apt.trackingCode ? (
                      <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                        {apt.trackingCode}
                      </span>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {formatDateTime(apt.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {formatDateTime(apt.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            Showing {((pagination.page - 1) * pagination.limit) + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
              const startPage = Math.max(1, Math.min(page - 2, pagination.totalPages - 4));
              const pageNum = startPage + i;
              if (pageNum > pagination.totalPages) return null;
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={`px-2.5 py-1 text-xs border rounded ${
                    pageNum === page
                      ? 'bg-spill-blue-800 text-white border-spill-blue-800'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
            <button
              onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
              disabled={page >= pagination.totalPages}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// Main Page
// ============================================

export default function AdminAppointmentsPage() {
  const [, setRefreshKey] = useState(0);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Appointments</h1>
        <p className="text-sm text-slate-500 mt-1">
          Create new appointments and view all appointment records
        </p>
      </div>

      {/* Create Appointment Form */}
      <CreateAppointmentForm onSuccess={() => setRefreshKey((k) => k + 1)} />

      {/* Appointments Table */}
      <AppointmentsTable />
    </div>
  );
}
