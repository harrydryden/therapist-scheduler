import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToastContext } from '../components/Toast';
import {
  listInvitations,
  createInvitation,
  createBulkInvitations,
  revokeInvitation,
  resendInvitation,
} from '../api/invitations';
import type {
  Invitation,
  InvitationFilters,
  InvitationStatus,
  CreateInvitationResponse,
  BulkInvitationResponse,
} from '../api/invitations';
import { listUsers } from '../api/users';
import { getErrorMessage } from '../api/core';
import { useDebounce } from '../hooks/useDebounce';
import Pagination from '../components/Pagination';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const STATUS_COLORS: Record<InvitationStatus, string> = {
  pending: 'bg-spill-blue-100 text-spill-blue-800',
  accepted: 'bg-green-100 text-green-800',
  revoked: 'bg-slate-100 text-slate-600',
  expired: 'bg-amber-100 text-amber-800',
};

function StatusBadge({ status }: { status: InvitationStatus }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

interface InviteModalProps {
  onClose: () => void;
  onCreated: (result: CreateInvitationResponse) => void;
}

function InviteModal({ onClose, onCreated }: InviteModalProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [invitedBy, setInvitedBy] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [result, setResult] = useState<CreateInvitationResponse | null>(null);

  // Debounced lookup against the admin users list to surface a warning
  // if we're inviting an email that already has a User row. Inviting an
  // existing user is allowed (re-signup is idempotent) but it's almost
  // always a mistake — usually the admin meant to invite someone else.
  const debouncedEmail = useDebounce(email.trim(), 300);
  const existingUserQuery = useQuery({
    queryKey: ['invite-existing-user-check', debouncedEmail],
    queryFn: () => listUsers({ search: debouncedEmail, limit: 1 }),
    enabled: debouncedEmail.includes('@') && debouncedEmail.length > 5,
    staleTime: 30_000,
  });
  const existingUser = existingUserQuery.data?.items.find(
    (u) => u.email.toLowerCase() === debouncedEmail.toLowerCase(),
  );

  const mutation = useMutation({
    mutationFn: () =>
      createInvitation({
        email: email.trim(),
        name: name.trim() || undefined,
        invitedBy: invitedBy.trim() || undefined,
        sendEmail,
      }),
    onSuccess: (data) => {
      setResult(data);
      onCreated(data);
    },
  });

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url);
  };

  // Result screen — shown after successful creation so admin can grab the URL
  if (result) {
    return (
      <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
          <svg className="w-12 h-12 text-green-500 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <h3 className="text-lg font-semibold text-slate-900 text-center mb-1">Invitation created</h3>
          <p className="text-sm text-slate-500 text-center mb-4">{result.invitation.email}</p>

          <div className="mb-4">
            <p className="text-xs text-slate-500 mb-1">Invitation link</p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={result.invitationUrl}
                className="flex-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg font-mono text-slate-700 truncate"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button
                type="button"
                onClick={() => handleCopy(result.invitationUrl)}
                className="px-3 py-1.5 text-xs font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400 flex-shrink-0"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              This is the only time you&rsquo;ll see this link &mdash; copy it now if you didn&rsquo;t send the email.
            </p>
          </div>

          {sendEmail && (
            <p className={`text-sm text-center ${result.emailSent ? 'text-green-600' : 'text-amber-600'}`}>
              {result.emailSent
                ? `Email sent to ${result.invitation.email}`
                : 'Email send failed — share the link above manually.'}
            </p>
          )}

          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full px-4 py-2 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Invite a user</h3>

        <div className="space-y-4">
          <div>
            <label htmlFor="invite-email" className="block text-sm font-medium text-slate-700 mb-1">
              Email address
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
              autoFocus
            />
            {existingUser && (
              <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-800">
                A user with this email already exists{existingUser.name ? ` (${existingUser.name})` : ''}.
                Re-inviting is allowed but probably a mistake — they can already sign in.
              </div>
            )}
          </div>

          <div>
            <label htmlFor="invite-name" className="block text-sm font-medium text-slate-700 mb-1">
              Name <span className="text-slate-400 font-normal">(optional &mdash; pre-fills the signup form)</span>
            </label>
            <input
              id="invite-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
            />
          </div>

          <div>
            <label htmlFor="invite-by" className="block text-sm font-medium text-slate-700 mb-1">
              Invited by <span className="text-slate-400 font-normal">(audit label)</span>
            </label>
            <input
              id="invite-by"
              type="text"
              value={invitedBy}
              onChange={(e) => setInvitedBy(e.target.value)}
              placeholder="Your name (defaults to 'admin')"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
            />
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-spill-blue-800 focus:ring-spill-blue-400"
            />
            <span className="text-sm text-slate-700">
              Email the invitation. Uncheck to copy the link and share it manually.
            </span>
          </label>
        </div>

        {mutation.isError && (
          <p className="mt-3 text-sm text-red-600">
            {getErrorMessage(mutation.error, 'Failed to create invitation')}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!email.trim() || mutation.isPending}
            className="px-4 py-1.5 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400 disabled:opacity-50"
          >
            {mutation.isPending ? 'Creating…' : sendEmail ? 'Create & email' : 'Create invitation'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminInvitationsPage() {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<InvitationFilters['status']>('all');
  const [page, setPage] = useState(1);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-invitations', { search: debouncedSearch, status, page }],
    queryFn: () =>
      listInvitations({
        search: debouncedSearch || undefined,
        status,
        page,
        limit: 50,
      }),
    placeholderData: (prev) => prev,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeInvitation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-invitations'] });
      showToast('Invitation revoked', 'success');
    },
    onError: (err) => showToast(getErrorMessage(err, 'Failed to revoke'), 'error'),
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) => resendInvitation(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin-invitations'] });
      showToast(
        result.emailSent ? 'Reminder email sent' : 'Send failed — please try again',
        result.emailSent ? 'success' : 'error',
      );
    },
    onError: (err) => showToast(getErrorMessage(err, 'Failed to resend'), 'error'),
  });

  const summary = data?.summary;

  return (
    <div className="py-6 px-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invitations</h1>
          <p className="mt-1 text-sm text-slate-500">
            Send one-time signup links to prospective users. Each invitation expires after 14 days unless overridden.
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setShowBulkModal(true)}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Bulk invite
          </button>
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="px-4 py-2 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400"
          >
            Invite user
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <SummaryCard label="Total" value={summary.total} />
          <SummaryCard label="Pending" value={summary.pending} accent="bg-spill-blue-50 text-spill-blue-800" />
          <SummaryCard label="Accepted" value={summary.accepted} accent="bg-green-50 text-green-800" />
          <SummaryCard label="Expired" value={summary.expired} accent="bg-amber-50 text-amber-800" />
          <SummaryCard label="Revoked" value={summary.revoked} />
        </div>
      )}

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
            placeholder="Email or name"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as InvitationFilters['status']);
              setPage(1);
            }}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 outline-none"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
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
          {getErrorMessage(error, 'Failed to load invitations')}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-12 text-center text-sm text-slate-500">
          No invitations match the current filters. Click <strong>Invite user</strong> to send a new one.
        </div>
      ) : data ? (
        <>
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-2.5">Email</th>
                  <th className="text-left px-4 py-2.5">Name</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Invited by</th>
                  <th className="text-left px-4 py-2.5">Created</th>
                  <th className="text-left px-4 py-2.5">Expires</th>
                  <th className="text-right px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.items.map((inv) => (
                  <InvitationRow
                    key={inv.id}
                    invitation={inv}
                    onRevoke={() => revokeMutation.mutate(inv.id)}
                    onResend={() => resendMutation.mutate(inv.id)}
                    actionsPending={revokeMutation.isPending || resendMutation.isPending}
                  />
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

      {showInviteModal && (
        <InviteModal
          onClose={() => setShowInviteModal(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['admin-invitations'] });
          }}
        />
      )}

      {showBulkModal && (
        <BulkInviteModal
          onClose={() => setShowBulkModal(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['admin-invitations'] });
          }}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${accent ? `inline-flex items-center px-2 py-0.5 rounded ${accent}` : 'text-slate-900'}`}>
        {value}
      </div>
    </div>
  );
}

interface RowProps {
  invitation: Invitation;
  onRevoke: () => void;
  onResend: () => void;
  actionsPending: boolean;
}

function InvitationRow({ invitation, onRevoke, onResend, actionsPending }: RowProps) {
  const isPending = invitation.status === 'pending';
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-4 py-2.5 text-slate-900">{invitation.email}</td>
      <td className="px-4 py-2.5 text-slate-700">{invitation.name || '—'}</td>
      <td className="px-4 py-2.5">
        <StatusBadge status={invitation.status} />
      </td>
      <td className="px-4 py-2.5 text-slate-600 text-xs">{invitation.invitedBy}</td>
      <td className="px-4 py-2.5 text-slate-500">{formatDate(invitation.createdAt)}</td>
      <td className="px-4 py-2.5 text-slate-500">{formatDate(invitation.expiresAt)}</td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        {isPending ? (
          <>
            <button
              type="button"
              onClick={onResend}
              disabled={actionsPending}
              className="px-2 py-1 text-xs font-medium text-spill-blue-800 hover:bg-spill-blue-50 rounded disabled:opacity-50"
              title={
                'Send a reminder email asking the recipient to use the original invitation link. ' +
                `Sent ${invitation.sendCount}× so far. (The reminder does NOT contain the link — ` +
                'we don\'t store raw tokens. If the recipient lost the original, revoke and re-invite.)'
              }
            >
              Send reminder
            </button>
            <button
              type="button"
              onClick={onRevoke}
              disabled={actionsPending}
              className="px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 rounded disabled:opacity-50 ml-1"
            >
              Revoke
            </button>
          </>
        ) : invitation.status === 'accepted' && invitation.acceptedUserId ? (
          // Link to the accepted user's row in the users admin so admins can
          // jump straight from "I invited Alice" to "here's Alice's row".
          // The /admin/users page filters by email substring; passing the
          // email lands the operator on the right row.
          <Link
            to={`/admin/users?search=${encodeURIComponent(invitation.email)}`}
            className="text-xs text-spill-blue-800 hover:underline"
          >
            View user &rarr;
          </Link>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}

// ============================================================================
// Bulk invite modal
// ============================================================================

interface BulkInviteModalProps {
  onClose: () => void;
  onCreated: (response: BulkInvitationResponse) => void;
}

/** Parses a textarea where each line is `email` or `email,name`. */
function parseBulkInput(raw: string): { entries: { email: string; name?: string }[]; errors: string[] } {
  const entries: { email: string; name?: string }[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (const [idx, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const [email, ...rest] = line.split(',').map((s) => s.trim());
    const name = rest.length > 0 ? rest.join(',').trim() : undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`Line ${idx + 1}: "${line}" is not a valid email`);
      continue;
    }
    entries.push({ email, name: name || undefined });
  }
  return { entries, errors };
}

function BulkInviteModal({ onClose, onCreated }: BulkInviteModalProps) {
  const [raw, setRaw] = useState('');
  const [invitedBy, setInvitedBy] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [result, setResult] = useState<BulkInvitationResponse | null>(null);

  const { entries, errors: parseErrors } = parseBulkInput(raw);

  const mutation = useMutation({
    mutationFn: () =>
      createBulkInvitations({
        entries,
        invitedBy: invitedBy.trim() || undefined,
        sendEmail,
      }),
    onSuccess: (data) => {
      setResult(data);
      onCreated(data);
    },
  });

  if (result) {
    return (
      <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-semibold text-slate-900 mb-3">Bulk invitation results</h3>
          <p className="text-sm text-slate-600 mb-4">
            <span className="text-green-700 font-medium">{result.summary.succeeded} succeeded</span>,{' '}
            <span className="text-red-600 font-medium">{result.summary.failed} failed</span>,{' '}
            of {result.summary.total} total.
          </p>
          <div className="border border-slate-200 rounded-lg max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {result.results.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-slate-700">{r.email}</td>
                    <td className="px-3 py-2">
                      {r.ok ? (
                        <span className="text-green-700 text-xs font-medium">
                          Created{r.emailSent ? ' (emailed)' : ''}
                        </span>
                      ) : (
                        <span className="text-red-600 text-xs">{r.error || 'Failed'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full px-4 py-2 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-slate-900 mb-2">Bulk invite</h3>
        <p className="text-sm text-slate-500 mb-4">
          One per line, in <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">email</code> or{' '}
          <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">email,name</code> format. Up to 100 per batch.
        </p>

        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={10}
          placeholder={'jane@example.com,Jane Doe\nbob@example.com\nalice@example.com,Alice'}
          spellCheck={false}
          className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:ring-2 focus:ring-spill-blue-400 outline-none"
        />

        <div className="flex items-center justify-between mt-2 text-xs text-slate-500">
          <span>{entries.length} valid {entries.length === 1 ? 'entry' : 'entries'}</span>
          {entries.length > 100 && (
            <span className="text-red-600">Over 100 — only the first 100 will be sent.</span>
          )}
        </div>

        {parseErrors.length > 0 && (
          <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 space-y-0.5 max-h-24 overflow-y-auto">
            {parseErrors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
            {parseErrors.length > 5 && <div className="font-medium">…and {parseErrors.length - 5} more</div>}
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="bulk-invitedby" className="block text-sm font-medium text-slate-700 mb-1">
              Invited by <span className="text-slate-400 font-normal">(audit label, applied to all)</span>
            </label>
            <input
              id="bulk-invitedby"
              type="text"
              value={invitedBy}
              onChange={(e) => setInvitedBy(e.target.value)}
              placeholder="Your name (defaults to 'admin')"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none"
            />
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-spill-blue-800 focus:ring-spill-blue-400"
            />
            <span className="text-sm text-slate-700">
              Email each invitation. Uncheck to copy links from the result list and share manually.
            </span>
          </label>
        </div>

        {mutation.isError && (
          <p className="mt-3 text-sm text-red-600">
            {getErrorMessage(mutation.error, 'Bulk invitation failed')}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={entries.length === 0 || mutation.isPending}
            className="px-4 py-1.5 text-sm font-medium text-white bg-spill-blue-800 rounded-lg hover:bg-spill-blue-400 disabled:opacity-50"
          >
            {mutation.isPending
              ? 'Processing…'
              : `Send ${Math.min(entries.length, 100)} ${entries.length === 1 ? 'invitation' : 'invitations'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
