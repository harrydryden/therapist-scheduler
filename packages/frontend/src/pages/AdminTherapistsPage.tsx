import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToastContext } from '../components/Toast';
import {
  listAdminTherapists,
  getAdminTherapist,
  updateAdminTherapist,
  unfreezeAdminTherapist,
} from '../api/admin-therapists';
import type {
  TherapistListItem,
  TherapistDetail,
  TherapistFilters,
  TherapistUpdate,
} from '../api/admin-therapists';
import { getErrorMessage } from '../api/core';
import { useDebounce } from '../hooks/useDebounce';
import Pagination from '../components/Pagination';
import {
  APPROACH_OPTIONS,
  STYLE_OPTIONS,
  AREAS_OF_FOCUS_OPTIONS,
} from '@therapist-scheduler/shared/config/therapist-categories';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function CategoryChips({
  options,
  selected,
  onChange,
}: {
  options: { type: string; explainer: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (type: string) => {
    if (selected.includes(type)) {
      onChange(selected.filter((s) => s !== type));
    } else {
      onChange([...selected, type]);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = selected.includes(opt.type);
        return (
          <button
            key={opt.type}
            type="button"
            onClick={() => toggle(opt.type)}
            title={opt.explainer}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              active
                ? 'border-spill-blue-800 bg-spill-blue-800 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {opt.type}
          </button>
        );
      })}
    </div>
  );
}

function StatusBadges({ row }: { row: TherapistListItem }) {
  return (
    <div className="flex flex-wrap gap-1">
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
          row.active ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'
        }`}
      >
        {row.active ? 'Active' : 'Archived'}
      </span>
      {row.frozen && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
          Frozen
        </span>
      )}
    </div>
  );
}

interface DetailDrawerProps {
  therapistId: string;
  onClose: () => void;
}

function TherapistDetailDrawer({ therapistId, onClose }: DetailDrawerProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-therapist', therapistId],
    queryFn: () => getAdminTherapist(therapistId),
  });

  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex justify-end" onClick={onClose}>
      <div
        className="bg-white w-full max-w-3xl h-full overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold text-slate-900">Therapist detail</h2>
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
          {data && (
            <DetailEditor
              data={data}
              therapistId={therapistId}
              onSaved={() => {
                queryClient.invalidateQueries({ queryKey: ['admin-therapist', therapistId] });
                queryClient.invalidateQueries({ queryKey: ['admin-therapists'] });
                showToast('Therapist updated', 'success');
              }}
              onError={(err) => showToast(getErrorMessage(err, 'Failed to save'), 'error')}
              onUnfrozen={() => {
                queryClient.invalidateQueries({ queryKey: ['admin-therapist', therapistId] });
                queryClient.invalidateQueries({ queryKey: ['admin-therapists'] });
                showToast('Therapist unfrozen', 'success');
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface DetailEditorProps {
  data: TherapistDetail;
  therapistId: string;
  onSaved: () => void;
  onError: (err: unknown) => void;
  onUnfrozen: () => void;
}

function DetailEditor({ data, therapistId, onSaved, onError, onUnfrozen }: DetailEditorProps) {
  // Local edit state. Initialised from the server payload and re-synced when
  // the server data changes (e.g. after a save invalidates the query).
  const [draft, setDraft] = useState<TherapistUpdate>({});
  const [availabilityText, setAvailabilityText] = useState<string>(
    data.availability ? JSON.stringify(data.availability, null, 2) : '',
  );
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  useEffect(() => {
    setDraft({});
    setAvailabilityText(data.availability ? JSON.stringify(data.availability, null, 2) : '');
    setAvailabilityError(null);
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: (updates: TherapistUpdate) => updateAdminTherapist(therapistId, updates),
    onSuccess: () => {
      onSaved();
      setDraft({});
    },
    onError,
  });

  const unfreezeMutation = useMutation({
    mutationFn: () => unfreezeAdminTherapist(therapistId),
    onSuccess: onUnfrozen,
    onError,
  });

  // Dedicated mutation for the archive/restore one-click action. We don't
  // route through `updateMutation` so the in-progress draft (bio edits etc.)
  // isn't accidentally saved alongside the archive flip.
  const archiveMutation = useMutation({
    mutationFn: (active: boolean) => updateAdminTherapist(therapistId, { active }),
    onSuccess: onSaved,
    onError,
  });

  const merged = { ...data, ...draft } as TherapistDetail & TherapistUpdate;

  const setField = <K extends keyof TherapistUpdate>(key: K, value: TherapistUpdate[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const hasChanges = Object.keys(draft).length > 0;

  const handleSave = () => {
    // Parse availability JSON if it was edited.
    if (availabilityText !== (data.availability ? JSON.stringify(data.availability, null, 2) : '')) {
      try {
        const parsed = availabilityText.trim() === '' ? null : JSON.parse(availabilityText);
        setAvailabilityError(null);
        updateMutation.mutate({ ...draft, availability: parsed });
        return;
      } catch (err) {
        setAvailabilityError(err instanceof Error ? err.message : 'Invalid JSON');
        return;
      }
    }
    updateMutation.mutate(draft);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        {data.profileImage && (
          <img
            src={data.profileImage}
            alt={data.name}
            className="w-16 h-16 rounded-full object-cover border border-slate-200"
          />
        )}
        <div className="flex-1">
          <h3 className="text-xl font-semibold text-slate-900">{data.name}</h3>
          <p className="text-sm text-slate-500">{data.email}</p>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            ID: {data.odId}
          </p>
        </div>
        <div className="flex flex-col gap-1 items-end">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
              merged.active ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {merged.active ? 'Active' : 'Archived'}
          </span>
          {data.bookingStatus?.frozen && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
              Frozen
            </span>
          )}
          <button
            type="button"
            onClick={() => archiveMutation.mutate(!data.active)}
            disabled={archiveMutation.isPending}
            className={`mt-1 px-2.5 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-50 ${
              data.active
                ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                : 'border-spill-blue-800 bg-spill-blue-800 text-white hover:bg-spill-blue-400'
            }`}
            title={data.active
              ? 'Hide from public listing and the default admin view'
              : 'Restore to active and bookable'}
          >
            {archiveMutation.isPending
              ? '…'
              : data.active ? 'Archive' : 'Restore'}
          </button>
        </div>
      </div>

      {/* Toggles + simple fields */}
      <div className="grid grid-cols-2 gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={merged.active ?? false}
            onChange={(e) => setField('active', e.target.checked)}
            className="rounded border-slate-300 text-spill-blue-800 focus:ring-spill-blue-400"
          />
          <span className="text-slate-700">Active (accepting bookings)</span>
        </label>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Country</label>
          <input
            value={merged.country ?? ''}
            onChange={(e) => setField('country', e.target.value.toUpperCase())}
            maxLength={4}
            className="w-full px-2 py-1 text-sm border border-slate-300 rounded font-mono"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Profile image URL</label>
          <input
            value={merged.profileImage ?? ''}
            onChange={(e) => setField('profileImage', e.target.value || null)}
            placeholder="https://…"
            className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Booking link</label>
          <input
            value={merged.bookingLink ?? ''}
            onChange={(e) => setField('bookingLink', e.target.value || null)}
            placeholder="https://calendly.com/…"
            className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
          />
        </div>
      </div>

      {/* Bio */}
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">Bio</label>
        <textarea
          value={merged.bio ?? ''}
          onChange={(e) => setField('bio', e.target.value || null)}
          rows={5}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded"
          placeholder="Therapist bio shown on the public profile"
        />
      </div>

      {/* Categories */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 mb-2">Approach</h4>
          <CategoryChips
            options={APPROACH_OPTIONS}
            selected={merged.approach ?? []}
            onChange={(next) => setField('approach', next)}
          />
        </div>
        <div>
          <h4 className="text-sm font-semibold text-slate-900 mb-2">Style</h4>
          <CategoryChips
            options={STYLE_OPTIONS}
            selected={merged.style ?? []}
            onChange={(next) => setField('style', next)}
          />
        </div>
        <div>
          <h4 className="text-sm font-semibold text-slate-900 mb-2">Areas of focus</h4>
          <CategoryChips
            options={AREAS_OF_FOCUS_OPTIONS}
            selected={merged.areasOfFocus ?? []}
            onChange={(next) => setField('areasOfFocus', next)}
          />
        </div>
      </div>

      {/* Availability JSON */}
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">
          Availability (JSON)
        </label>
        <textarea
          value={availabilityText}
          onChange={(e) => setAvailabilityText(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded"
          placeholder='{"timezone":"Europe/London","slots":[]}'
        />
        {availabilityError && (
          <p className="mt-1 text-xs text-red-600">JSON parse error: {availabilityError}</p>
        )}
      </div>

      {/* Booking status */}
      {data.bookingStatus && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="text-sm font-semibold text-slate-900 mb-2">Booking status</h4>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Has confirmed booking</dt>
                  <dd className="text-slate-700">
                    {data.bookingStatus.hasConfirmedBooking ? 'Yes' : 'No'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Active requests</dt>
                  <dd className="text-slate-700">{data.bookingStatus.uniqueRequestCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Frozen at</dt>
                  <dd className="text-slate-700">{formatDate(data.bookingStatus.frozenAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Confirmed at</dt>
                  <dd className="text-slate-700">{formatDate(data.bookingStatus.confirmedAt)}</dd>
                </div>
              </dl>
            </div>
            {data.bookingStatus.frozen && !data.bookingStatus.hasConfirmedBooking && (
              <button
                type="button"
                onClick={() => unfreezeMutation.mutate()}
                disabled={unfreezeMutation.isPending}
                className="px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-100 border border-amber-200 rounded hover:bg-amber-200 disabled:opacity-50"
              >
                {unfreezeMutation.isPending ? 'Unfreezing…' : 'Force unfreeze'}
              </button>
            )}
          </div>
          {data.bookingStatus.hasConfirmedBooking && data.bookingStatus.frozen && (
            <p className="mt-2 text-xs text-slate-500">
              Therapist is frozen due to a confirmed booking. Cancel the booking via the
              Appointments admin to unfreeze.
            </p>
          )}
        </div>
      )}

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
                  <th className="text-left px-3 py-2">User</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Session</th>
                  <th className="text-left px-3 py-2">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.appointments.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-2 text-slate-900">{a.userName || a.userEmail}</td>
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

      {/* Save bar */}
      <div className="sticky bottom-0 -mx-6 px-6 py-3 bg-white border-t border-slate-200 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setDraft({});
            setAvailabilityText(data.availability ? JSON.stringify(data.availability, null, 2) : '');
            setAvailabilityError(null);
          }}
          disabled={!hasChanges && !availabilityError}
          className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="px-4 py-1.5 text-sm font-medium text-white bg-spill-blue-800 rounded hover:bg-spill-blue-400 disabled:opacity-50"
        >
          {updateMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

export default function AdminTherapistsPage() {
  const [search, setSearch] = useState('');
  // Default to Active so archived (active=false) therapists are out of the
  // way until explicitly looked for. The filter dropdown still exposes them.
  const [active, setActive] = useState<TherapistFilters['active']>('true');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-therapists', { search: debouncedSearch, active, page }],
    queryFn: () =>
      listAdminTherapists({
        search: debouncedSearch || undefined,
        active,
        page,
        limit: 50,
      }),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="py-6 px-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Therapists</h1>
        <p className="mt-1 text-sm text-slate-500">
          Therapist database. Edits save to Postgres directly &mdash; this is the single source of truth for the public site.
        </p>
      </div>

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
          <label className="block text-xs font-medium text-slate-500 mb-1">Show</label>
          <select
            value={active}
            onChange={(e) => {
              setActive(e.target.value as TherapistFilters['active']);
              setPage(1);
            }}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 outline-none"
          >
            <option value="true">Active</option>
            <option value="false">Archived</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {isLoading && !data ? (
        <div className="bg-white border border-slate-200 rounded-lg p-12 text-center text-sm text-slate-500">
          Loading…
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          {getErrorMessage(error, 'Failed to load therapists')}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-12 text-center text-sm text-slate-500">
          No therapists match the current filters.
        </div>
      ) : data ? (
        <>
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-2.5">Therapist</th>
                  <th className="text-left px-4 py-2.5">Email</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Country</th>
                  <th className="text-left px-4 py-2.5">Appointments</th>
                  <th className="text-left px-4 py-2.5">Ingested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.items.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    className="hover:bg-slate-50 cursor-pointer"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {t.profileImage && (
                          <img
                            src={t.profileImage}
                            alt=""
                            className="w-7 h-7 rounded-full object-cover border border-slate-200"
                          />
                        )}
                        <span className="text-slate-900 font-medium">{t.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{t.email}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadges row={t} />
                    </td>
                    <td className="px-4 py-2.5 text-slate-700 font-mono text-xs">{t.country}</td>
                    <td className="px-4 py-2.5 text-slate-700">{t.appointmentCount}</td>
                    <td className="px-4 py-2.5 text-slate-500">{formatDate(t.ingestedAt)}</td>
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

      {selectedId && (
        <TherapistDetailDrawer therapistId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
