import { useState, useCallback } from 'react';
import { useToastContext } from '../components/Toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getVouchers,
  issueVoucher,
  resetStrikes,
  resubscribeUser,
  revokeVoucher,
} from '../api/client';
import { getErrorMessage } from '../api/core';
import type { VoucherRecord, VoucherFilters } from '../api/vouchers';
import Pagination from '../components/Pagination';
import ConfirmDialog from '../components/ConfirmDialog';
import { useDebounce } from '../hooks/useDebounce';
import { formatTimeAgo, formatExpiryDate } from '../utils/date-format';

// ============================================
// Status Badge
// ============================================

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  used: 'bg-teal-100 text-teal-800',
  expired: 'bg-amber-100 text-amber-800',
  unsubscribed: 'bg-red-100 text-red-800',
};

function VoucherStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-800'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ============================================
// Strike Indicator
// ============================================

function StrikeIndicator({ count, max }: { count: number; max: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex gap-0.5">
        {Array.from({ length: max }).map((_, i) => (
          <div
            key={i}
            className={`w-2 h-2 rounded-full ${i < count ? 'bg-red-400' : 'bg-slate-200'}`}
          />
        ))}
      </div>
      <span className="text-xs text-slate-500">{count}/{max}</span>
    </div>
  );
}

// ============================================
// Issue Voucher Modal
// ============================================

interface IssueResult {
  displayCode: string;
  email: string;
  expiresAt: string;
  voucherUrl: string;
  emailSent: boolean;
}

function IssueVoucherModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (result: IssueResult) => void }) {
  const [email, setEmail] = useState('');
  const [expiryDays, setExpiryDays] = useState(14);
  const [sendEmail, setSendEmail] = useState(true);
  const [result, setResult] = useState<IssueResult | null>(null);

  const mutation = useMutation({
    mutationFn: () => issueVoucher({ email: email.trim(), expiryDays, sendEmail }),
    onSuccess: (data) => {
      setResult(data);
      onSuccess(data);
    },
  });

  // Show result screen after successful creation
  if (result) {
    return (
      <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
          <div className="text-center">
            <svg className="w-12 h-12 text-green-500 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <h3 className="text-lg font-semibold text-slate-900 mb-1">Voucher Issued</h3>
            <p className="text-sm text-slate-500 mb-4">{result.email}</p>

            <div className="bg-slate-50 rounded-lg p-4 mb-4">
              <p className="text-xs text-slate-500 mb-1">Session Code</p>
              <code className="text-lg font-mono font-bold text-slate-900">{result.displayCode}</code>
              <p className="text-xs text-slate-500 mt-2">
                Expires {new Date(result.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>
            </div>

            <div className="mb-4">
              <p className="text-xs text-slate-500 mb-1">Booking Link</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={result.voucherUrl}
                  className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg font-mono text-slate-600 truncate"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(result.voucherUrl); }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors flex-shrink-0"
                >
                  Copy
                </button>
              </div>
            </div>

            {!result.emailSent && sendEmail && (
              <p className="text-sm text-amber-600 mb-3">
                Email sending failed — voucher was still created. Share the link above manually.
              </p>
            )}
            {result.emailSent && (
              <p className="text-sm text-green-600 mb-3">Email sent to {result.email}</p>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Issue Voucher</h3>

        <div className="space-y-4">
          <div>
            <label htmlFor="issue-email" className="block text-sm font-medium text-slate-700 mb-1">
              Email address
            </label>
            <input
              id="issue-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
            />
          </div>

          <div>
            <label htmlFor="issue-expiry" className="block text-sm font-medium text-slate-700 mb-1">
              Expiry (days)
            </label>
            <input
              id="issue-expiry"
              type="number"
              min={7}
              max={30}
              value={expiryDays}
              onChange={(e) => setExpiryDays(Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="rounded border-slate-300 text-spill-blue-800 focus:ring-spill-blue-400"
            />
            <span className="text-sm text-slate-700">Send voucher email to user</span>
          </label>
        </div>

        {mutation.isError && (
          <p className="mt-3 text-sm text-red-600">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to issue voucher'}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!email.trim() || mutation.isPending}
            className="px-4 py-2 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {mutation.isPending ? 'Issuing...' : 'Issue Voucher'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Row Actions Dropdown
// ============================================

type VoucherAction = 'revoke' | 'resubscribe';

const ACTION_CONFIG: Record<VoucherAction, {
  title: string;
  confirmLabel: string;
  confirmVariant: 'danger' | 'primary';
  description: (email: string) => string;
}> = {
  revoke: {
    title: 'Revoke Voucher',
    confirmLabel: 'Revoke',
    confirmVariant: 'danger',
    description: (email) =>
      `Revoke the active voucher for ${email}? They won't be able to book until a new code is issued.`,
  },
  resubscribe: {
    title: 'Resubscribe User',
    confirmLabel: 'Resubscribe',
    confirmVariant: 'primary',
    description: (email) =>
      `Resubscribe ${email}? This will reset strikes and issue a fresh voucher.`,
  },
};

function RowActions({ record }: { record: VoucherRecord }) {
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<VoucherAction | null>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['vouchers'] });

  const resetMutation = useMutation({
    mutationFn: () => resetStrikes(record.email),
    onSuccess: () => {
      invalidate();
      showToast(`Strikes reset for ${record.email}`, 'success');
    },
    onError: (error) => {
      showToast(getErrorMessage(error, `Failed to reset strikes for ${record.email}`), 'error');
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => revokeVoucher(record.email),
    onSuccess: () => {
      invalidate();
      setPendingAction(null);
      showToast(`Voucher revoked for ${record.email}`, 'success');
    },
    onError: (error) => {
      // Keep the confirm dialog open so the user can retry or cancel.
      showToast(getErrorMessage(error, `Failed to revoke voucher for ${record.email}`), 'error');
    },
  });

  const resubMutation = useMutation({
    mutationFn: () => resubscribeUser(record.email),
    onSuccess: () => {
      invalidate();
      setPendingAction(null);
      showToast(`${record.email} resubscribed with fresh voucher`, 'success');
    },
    onError: (error) => {
      showToast(getErrorMessage(error, `Failed to resubscribe ${record.email}`), 'error');
    },
  });

  const confirmMutation = pendingAction === 'revoke' ? revokeMutation : resubMutation;
  const isConfirmPending = confirmMutation.isPending;
  const isRowPending = resetMutation.isPending || revokeMutation.isPending || resubMutation.isPending;

  const handleAction = (action: 'reset' | VoucherAction) => {
    setOpen(false);
    if (action === 'reset') {
      resetMutation.mutate();
      return;
    }
    // Destructive/destructive-adjacent actions go through a ConfirmDialog
    // rather than window.confirm, so they match the rest of the admin UI and
    // can surface a loading state + error in context.
    revokeMutation.reset();
    resubMutation.reset();
    setPendingAction(action);
  };

  const handleConfirm = () => {
    if (!pendingAction || isConfirmPending) return;
    if (pendingAction === 'revoke') {
      revokeMutation.mutate();
    } else {
      resubMutation.mutate();
    }
  };

  const handleCancel = () => {
    if (isConfirmPending) return;
    setPendingAction(null);
  };

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={isRowPending}
          aria-label={`Actions for ${record.email}`}
          className="p-1 text-slate-400 hover:text-slate-600 rounded transition-colors disabled:opacity-50"
        >
          {isRowPending ? (
            <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          )}
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute right-0 z-20 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-lg py-1">
              {record.strikeCount > 0 && (
                <button
                  type="button"
                  onClick={() => handleAction('reset')}
                  className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  Reset Strikes
                </button>
              )}
              {record.displayCode && record.status !== 'unsubscribed' && (
                <button
                  type="button"
                  onClick={() => handleAction('revoke')}
                  className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                >
                  Revoke Voucher
                </button>
              )}
              {record.status === 'unsubscribed' && (
                <button
                  type="button"
                  onClick={() => handleAction('resubscribe')}
                  className="w-full px-3 py-2 text-left text-sm text-green-700 hover:bg-green-50"
                >
                  Resubscribe
                </button>
              )}
              {!record.displayCode && record.status !== 'unsubscribed' && record.strikeCount === 0 && (
                <span className="block px-3 py-2 text-xs text-slate-400">No actions available</span>
              )}
            </div>
          </>
        )}
      </div>

      {pendingAction && (
        <ConfirmDialog
          title={ACTION_CONFIG[pendingAction].title}
          confirmLabel={ACTION_CONFIG[pendingAction].confirmLabel}
          confirmVariant={ACTION_CONFIG[pendingAction].confirmVariant}
          isPending={isConfirmPending}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        >
          <p className="text-slate-600">
            {ACTION_CONFIG[pendingAction].description(record.email)}
          </p>
          {confirmMutation.isError && (
            <p className="mt-3 text-sm text-red-600">
              {getErrorMessage(confirmMutation.error, 'Action failed — please try again.')}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

// ============================================
// Summary Tiles
// ============================================

interface SummaryTileProps {
  label: string;
  value: number;
  color: string;
  active: boolean;
  onClick: () => void;
}

function SummaryTile({ label, value, color, active, onClick }: SummaryTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 min-w-[120px] rounded-xl border px-4 py-3 text-left transition-all ${
        active ? `${color} border-current shadow-sm` : 'bg-white border-slate-200 hover:border-slate-300'
      }`}
    >
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs font-medium mt-0.5 opacity-75">{label}</p>
    </button>
  );
}

// ============================================
// Main Page
// ============================================

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'used', label: 'Used' },
  { value: 'expired', label: 'Expired' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
];

export default function AdminVouchersPage() {
  const [filters, setFilters] = useState<VoucherFilters>({ status: 'all', page: 1, limit: 50 });
  const [searchInput, setSearchInput] = useState('');
  const [showIssueModal, setShowIssueModal] = useState(false);
  const debouncedSearch = useDebounce(searchInput, 300);
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();

  const effectiveFilters = { ...filters, search: debouncedSearch || undefined };

  const { data, isLoading, error } = useQuery({
    queryKey: ['vouchers', effectiveFilters],
    queryFn: () => getVouchers(effectiveFilters),
    staleTime: 15000,
  });

  const setStatus = useCallback((status: string) => {
    setFilters((prev) => ({ ...prev, status, page: 1, minStrikes: undefined }));
  }, []);

  const setPage = useCallback((page: number) => {
    setFilters((prev) => ({ ...prev, page }));
  }, []);

  const summary = data?.summary || { total: 0, active: 0, used: 0, atRisk: 0, unsubscribed: 0, maxStrikes: 3 };
  const items = data?.items || [];
  const pagination = data?.pagination || { page: 1, limit: 50, total: 0, totalPages: 0 };

  return (
    <div className="py-6 px-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Voucher Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">View and manage session codes for the weekly mailing system</p>
        </div>
        <button
          type="button"
          onClick={() => setShowIssueModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Issue Voucher
        </button>
      </div>

      {/* Summary Tiles */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <SummaryTile
          label="Total"
          value={summary.total}
          color="bg-slate-50 text-slate-700"
          active={filters.status === 'all'}
          onClick={() => setStatus('all')}
        />
        <SummaryTile
          label="Active"
          value={summary.active}
          color="bg-green-50 text-green-700"
          active={filters.status === 'active'}
          onClick={() => setStatus('active')}
        />
        <SummaryTile
          label="Used"
          value={summary.used}
          color="bg-teal-50 text-teal-700"
          active={filters.status === 'used'}
          onClick={() => setStatus('used')}
        />
        <SummaryTile
          label="At Risk"
          value={summary.atRisk}
          color="bg-amber-50 text-amber-700"
          active={false}
          onClick={() => {
            setFilters((prev) => ({ ...prev, minStrikes: Math.max(1, summary.maxStrikes - 1), status: 'all', page: 1 }));
          }}
        />
        <SummaryTile
          label="Unsubscribed"
          value={summary.unsubscribed}
          color="bg-red-50 text-red-700"
          active={filters.status === 'unsubscribed'}
          onClick={() => setStatus('unsubscribed')}
        />
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatus(opt.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                filters.status === opt.value
                  ? 'bg-spill-blue-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => { setSearchInput(e.target.value); setFilters((prev) => ({ ...prev, page: 1 })); }}
          placeholder="Search by email..."
          className="w-64 px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
        />
      </div>

      {/* Loading / Error States */}
      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 text-red-600">
          Failed to load vouchers. Please try again.
        </div>
      )}

      {/* Table */}
      {!isLoading && !error && (
        <>
          {items.length === 0 ? (
            <div className="text-center py-16 text-slate-500">
              <p className="text-lg font-medium">No vouchers found</p>
              <p className="text-sm mt-1">
                {searchInput ? 'Try a different search term.' : 'Issue a voucher to get started.'}
              </p>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Email</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Code</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Strikes</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Issued</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Expires</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Last Used</th>
                      <th className="px-4 py-3 text-center font-medium text-slate-600 w-12" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((record) => (
                      <VoucherRow key={record.email} record={record} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="mt-4">
              <Pagination
                page={pagination.page}
                totalPages={pagination.totalPages}
                onPageChange={setPage}
              />
            </div>
          )}
        </>
      )}

      {/* Issue Voucher Modal */}
      {showIssueModal && (
        <IssueVoucherModal
          onClose={() => setShowIssueModal(false)}
          onSuccess={(result) => {
            queryClient.invalidateQueries({ queryKey: ['vouchers'] });
            if (result.emailSent) {
              showToast(`Voucher ${result.displayCode} issued and emailed to ${result.email}`, 'success');
            } else {
              showToast(`Voucher ${result.displayCode} created for ${result.email} (email not sent)`, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

// ============================================
// Table Row
// ============================================

function VoucherRow({ record }: { record: VoucherRecord }) {
  return (
    <tr className="hover:bg-slate-50 transition-colors">
      <td className="px-4 py-3">
        <span className="font-medium text-slate-900">{record.email}</span>
      </td>
      <td className="px-4 py-3">
        {record.displayCode ? (
          <code className="text-xs bg-slate-100 px-2 py-1 rounded font-mono">{record.displayCode}</code>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <VoucherStatusBadge status={record.status} />
      </td>
      <td className="px-4 py-3">
        <StrikeIndicator count={record.strikeCount} max={record.maxStrikes} />
      </td>
      <td className="px-4 py-3 text-slate-600">{formatTimeAgo(record.lastVoucherSentAt)}</td>
      <td className="px-4 py-3 text-slate-600">{formatExpiryDate(record.expiresAt)}</td>
      <td className="px-4 py-3 text-slate-600">{formatTimeAgo(record.lastVoucherUsedAt)}</td>
      <td className="px-4 py-3 text-center">
        <RowActions record={record} />
      </td>
    </tr>
  );
}
