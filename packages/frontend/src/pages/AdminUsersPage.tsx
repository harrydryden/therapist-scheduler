import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToastContext } from '../components/Toast';
import { listUsers, getUser, updateUser } from '../api/users';
import type { UserListItem, UserDetail, UserFilters } from '../api/users';
import { getErrorMessage } from '../api/core';
import { useDebounce } from '../hooks/useDebounce';
import Pagination from '../components/Pagination';
import AgentProfilePanel from '../components/AgentProfilePanel';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function ConsentBadge({ given }: { given: boolean | null }) {
  if (given === null) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
        given ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-700'
      }`}
    >
      {given ? 'Yes' : 'No'}
    </span>
  );
}

function SourceBadge({ source }: { source: UserListItem['signupSource'] }) {
  const colors: Record<string, string> = {
    signup_form: 'bg-spill-blue-100 text-spill-blue-800',
    invitation: 'bg-indigo-100 text-indigo-800',
    booking: 'bg-teal-100 text-teal-800',
    admin: 'bg-purple-100 text-purple-800',
    legacy: 'bg-slate-100 text-slate-600',
  };
  const label = source ?? 'unknown';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[label] ?? 'bg-slate-100 text-slate-600'}`}>
      {label.replace('_', ' ')}
    </span>
  );
}

interface DetailDrawerProps {
  userId: string;
  onClose: () => void;
}

function UserDetailDrawer({ userId, onClose }: DetailDrawerProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-user', userId],
    queryFn: () => getUser(userId),
  });

  const [editName, setEditName] = useState<string | null>(null);
  const [editCountry, setEditCountry] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (updates: { name?: string; country?: string; subscribed?: boolean }) =>
      updateUser(userId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-user', userId] });
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditName(null);
      setEditCountry(null);
      showToast('User updated', 'success');
    },
    onError: (err) => showToast(getErrorMessage(err, 'Failed to update user'), 'error'),
  });

  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex justify-end" onClick={onClose}>
      <div
        className="bg-white w-full max-w-2xl h-full overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">User detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-6">
          {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {error && <p className="text-sm text-red-600">{getErrorMessage(error)}</p>}
          {data && <DetailBody data={data} editName={editName} setEditName={setEditName} editCountry={editCountry} setEditCountry={setEditCountry} updateMutation={updateMutation} />}
        </div>
      </div>
    </div>
  );
}

interface DetailBodyProps {
  data: UserDetail;
  editName: string | null;
  setEditName: (v: string | null) => void;
  editCountry: string | null;
  setEditCountry: (v: string | null) => void;
  updateMutation: ReturnType<typeof useMutation<unknown, unknown, { name?: string; country?: string; subscribed?: boolean }>>;
}

function DetailBody({ data, editName, setEditName, editCountry, setEditCountry, updateMutation }: DetailBodyProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-xl font-semibold text-slate-900">{data.name || '(no name)'}</h3>
        <p className="text-sm text-slate-500">{data.email}</p>
        <p className="text-xs text-slate-400 mt-1 font-mono">ID: {data.odId}</p>
      </div>

      {/* Editable fields */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
          {editName !== null ? (
            <div className="flex gap-1">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="flex-1 px-2 py-1 text-sm border border-slate-300 rounded"
              />
              <button
                onClick={() => updateMutation.mutate({ name: editName })}
                disabled={updateMutation.isPending}
                className="px-2 py-1 text-xs bg-spill-blue-800 text-white rounded hover:bg-spill-blue-400 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => setEditName(null)}
                className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditName(data.name ?? '')}
              className="text-sm text-slate-900 hover:text-spill-blue-800 text-left"
            >
              {data.name || '(set name)'}
            </button>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Country</label>
          {editCountry !== null ? (
            <div className="flex gap-1">
              <input
                value={editCountry}
                onChange={(e) => setEditCountry(e.target.value.toUpperCase())}
                maxLength={4}
                className="flex-1 px-2 py-1 text-sm border border-slate-300 rounded font-mono"
              />
              <button
                onClick={() => updateMutation.mutate({ country: editCountry })}
                disabled={updateMutation.isPending}
                className="px-2 py-1 text-xs bg-spill-blue-800 text-white rounded hover:bg-spill-blue-400 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => setEditCountry(null)}
                className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditCountry(data.country)}
              className="text-sm text-slate-900 hover:text-spill-blue-800 text-left font-mono"
            >
              {data.country}
            </button>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Subscribed</label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={data.subscribed}
              onChange={(e) => updateMutation.mutate({ subscribed: e.target.checked })}
              disabled={updateMutation.isPending}
              className="rounded border-slate-300 text-spill-blue-800 focus:ring-spill-blue-400"
            />
            <span className="text-sm text-slate-700">Receives weekly mailing</span>
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Source</label>
          <SourceBadge source={data.signupSource} />
        </div>
      </div>

      {/* Consent */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-slate-900 mb-3">Consent</h4>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Prior therapy</dt>
            <dd className="mt-0.5"><ConsentBadge given={data.priorTherapy} /></dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Acknowledged real session</dt>
            <dd className="mt-0.5"><ConsentBadge given={data.acknowledgedRealSession} /></dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Agreed to feedback</dt>
            <dd className="mt-0.5"><ConsentBadge given={data.agreedToFeedback} /></dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Consent given at</dt>
            <dd className="mt-0.5 text-slate-700">{formatDate(data.consentGivenAt)}</dd>
          </div>
        </dl>
      </div>

      {/* Voucher */}
      {data.voucher && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-slate-900 mb-3">Voucher</h4>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Strikes</dt>
              <dd className="mt-0.5 text-slate-700">{data.voucher.strikeCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Last sent</dt>
              <dd className="mt-0.5 text-slate-700">{formatDate(data.voucher.lastVoucherSentAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Last used</dt>
              <dd className="mt-0.5 text-slate-700">{formatDate(data.voucher.lastVoucherUsedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Unsubscribed at</dt>
              <dd className="mt-0.5 text-slate-700">{formatDate(data.voucher.unsubscribedAt)}</dd>
            </div>
          </dl>
        </div>
      )}

      {/* Agent profile (Layer C cross-appointment notes) */}
      <AgentProfilePanel entity="user" id={data.id} />

      {/* Appointments */}
      <div>
        <h4 className="text-sm font-semibold text-slate-900 mb-3">
          Appointments ({data.appointments.length})
        </h4>
        {data.appointments.length === 0 ? (
          <p className="text-sm text-slate-500">No appointments yet.</p>
        ) : (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Therapist</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Session</th>
                  <th className="text-left px-3 py-2">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.appointments.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-2 text-slate-900">{a.therapistName}</td>
                    <td className="px-3 py-2 text-slate-600">{a.status}</td>
                    <td className="px-3 py-2 text-slate-600">{formatDate(a.confirmedDateTimeParsed)}</td>
                    <td className="px-3 py-2 text-slate-500">{formatDate(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminUsersPage() {
  // Allow deep links like /admin/users?search=alice@example.com (used by
  // the Invitations page "View user" link) to seed the search box. We
  // only seed on first render — subsequent edits are local-only so the
  // URL doesn't churn on every keystroke.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
  const [subscribed, setSubscribed] = useState<UserFilters['subscribed']>('all');
  const [signupSource, setSignupSource] = useState<UserFilters['signupSource']>('all');
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-users', { search: debouncedSearch, subscribed, signupSource, page }],
    queryFn: () =>
      listUsers({
        search: debouncedSearch || undefined,
        subscribed,
        signupSource,
        page,
        limit: 50,
      }),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="py-6 px-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Users</h1>
        <p className="mt-1 text-sm text-slate-500">
          User database. Reads and edits are Postgres-backed.
        </p>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Email, name, or ID"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Subscribed</label>
          <select
            value={subscribed}
            onChange={(e) => {
              setSubscribed(e.target.value as UserFilters['subscribed']);
              setPage(1);
            }}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 outline-none"
          >
            <option value="all">All</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Source</label>
          <select
            value={signupSource}
            onChange={(e) => {
              setSignupSource(e.target.value as UserFilters['signupSource']);
              setPage(1);
            }}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 outline-none"
          >
            <option value="all">All</option>
            <option value="signup_form">Signup form</option>
            <option value="invitation">Invitation</option>
            <option value="booking">Booking</option>
            <option value="admin">Admin</option>
            <option value="legacy">Legacy</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {isLoading && !data ? (
        <div className="bg-white border border-slate-200 rounded-lg p-12 text-center text-sm text-slate-500">
          Loading…
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          {getErrorMessage(error, 'Failed to load users')}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-12 text-center text-sm text-slate-500">
          No users match the current filters.
        </div>
      ) : data ? (
        <>
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-2.5">Name</th>
                  <th className="text-left px-4 py-2.5">Email</th>
                  <th className="text-left px-4 py-2.5">Source</th>
                  <th className="text-left px-4 py-2.5">Subscribed</th>
                  <th className="text-left px-4 py-2.5">Appointments</th>
                  <th className="text-left px-4 py-2.5">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.items.map((user) => (
                  <tr
                    key={user.id}
                    onClick={() => setSelectedUserId(user.id)}
                    className="hover:bg-slate-50 cursor-pointer"
                  >
                    <td className="px-4 py-2.5 text-slate-900">{user.name || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-700">{user.email}</td>
                    <td className="px-4 py-2.5"><SourceBadge source={user.signupSource} /></td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${user.subscribed ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}>
                        {user.subscribed ? 'Yes' : 'No'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{user.appointmentCount}</td>
                    <td className="px-4 py-2.5 text-slate-500">{formatDate(user.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pagination.totalPages > 1 && (
            <div className="mt-4">
              <Pagination
                page={data.pagination.page}
                totalPages={data.pagination.totalPages}
                total={data.pagination.total}
                limit={data.pagination.limit}
                onPageChange={setPage}
              />
            </div>
          )}
        </>
      ) : null}

      {selectedUserId && (
        <UserDetailDrawer userId={selectedUserId} onClose={() => setSelectedUserId(null)} />
      )}
    </div>
  );
}
