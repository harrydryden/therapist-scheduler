/**
 * AgentProfilePanel — admin UI for the Layer C agent profile.
 *
 * Shown inside the User and Therapist detail drawers. Lists existing
 * notes grouped by category, exposes a small "Add note" form, and
 * provides a clear-profile action gated by a confirmation dialog.
 *
 * The panel is deliberately entity-aware via the `entity` prop rather
 * than two near-identical components: the backend keeps user and
 * therapist code paths fully separate (privacy contract), but the UI
 * surface area is identical from the admin's point of view, so the
 * single-component-with-discriminator shape is appropriate.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getUserAgentProfile,
  addUserAgentProfileNote,
  clearUserAgentProfile,
  getTherapistAgentProfile,
  addTherapistAgentProfileNote,
  clearTherapistAgentProfile,
  type AgentProfile,
  type ProfileCategory,
  type ProfileNote,
} from '../api/agent-profile';
import { getErrorMessage } from '../api/core';
import { useToastContext } from './Toast';
import ConfirmDialog from './ConfirmDialog';

const NOTE_MAX_LENGTH = 280;

const CATEGORY_LABELS: Record<ProfileCategory, string> = {
  communication: 'Communication',
  scheduling: 'Scheduling',
  context: 'Context',
};

const CATEGORY_DESCRIPTIONS: Record<ProfileCategory, string> = {
  communication: 'How they prefer to communicate ("brief replies", "responds before 10am UK").',
  scheduling: 'Time-of-day / cadence patterns ("books afternoons", "weekly on Mondays").',
  context: 'Stable scheduling-relevant background ("travels frequently").',
};

interface AgentProfilePanelProps {
  entity: 'user' | 'therapist';
  id: string;
}

function entityApi(entity: 'user' | 'therapist') {
  return entity === 'user'
    ? {
        get: getUserAgentProfile,
        add: addUserAgentProfileNote,
        clear: clearUserAgentProfile,
        queryKey: (id: string) => ['admin-user-agent-profile', id] as const,
      }
    : {
        get: getTherapistAgentProfile,
        add: addTherapistAgentProfileNote,
        clear: clearTherapistAgentProfile,
        queryKey: (id: string) => ['admin-therapist-agent-profile', id] as const,
      };
}

function formatDate(value: string): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function groupByCategory(notes: ProfileNote[]): Record<ProfileCategory, ProfileNote[]> {
  const groups: Record<ProfileCategory, ProfileNote[]> = {
    communication: [],
    scheduling: [],
    context: [],
  };
  for (const n of notes) {
    if (n.category in groups) groups[n.category].push(n);
  }
  return groups;
}

export default function AgentProfilePanel({ entity, id }: AgentProfilePanelProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const api = entityApi(entity);

  const { data, isLoading, error } = useQuery({
    queryKey: api.queryKey(id),
    queryFn: () => api.get(id),
  });

  const [draftCategory, setDraftCategory] = useState<ProfileCategory>('communication');
  const [draftText, setDraftText] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const addMutation = useMutation({
    mutationFn: (note: { category: ProfileCategory; text: string }) => api.add(id, note),
    onSuccess: (result) => {
      queryClient.setQueryData<AgentProfile>(api.queryKey(id), result.profile);
      setDraftText('');
      showToast(result.added ? 'Note added' : 'Note already present (no change)', 'success');
    },
    onError: (err) => showToast(getErrorMessage(err, 'Failed to add note'), 'error'),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clear(id),
    onSuccess: () => {
      queryClient.setQueryData<AgentProfile>(api.queryKey(id), {
        notes: [],
        updatedAt: '',
        version: 'v1',
      });
      setShowClearConfirm(false);
      showToast('Profile cleared', 'success');
    },
    onError: (err) => {
      setShowClearConfirm(false);
      showToast(getErrorMessage(err, 'Failed to clear profile'), 'error');
    },
  });

  const trimmedDraft = draftText.trim();
  const canSubmit = trimmedDraft.length > 0 && trimmedDraft.length <= NOTE_MAX_LENGTH && !addMutation.isPending;

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-slate-900">Agent profile</h4>
        {data && data.notes.length > 0 && (
          <button
            type="button"
            onClick={() => setShowClearConfirm(true)}
            className="text-xs text-red-600 hover:text-red-800"
          >
            Clear profile
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Cross-appointment observations the scheduling agent uses to start warm on this {entity}&apos;s
        next booking. Notes are capped at {NOTE_MAX_LENGTH} characters and rotate FIFO after 10 entries.
      </p>

      {isLoading && <p className="text-xs text-slate-500">Loading…</p>}
      {error && (
        <p className="text-xs text-red-600">{getErrorMessage(error, 'Failed to load profile')}</p>
      )}

      {data && (
        <>
          {data.notes.length === 0 ? (
            <p className="text-xs text-slate-500 italic mb-3">No notes yet.</p>
          ) : (
            <div className="space-y-3 mb-4">
              {(() => {
                const groups = groupByCategory(data.notes);
                return (Object.keys(CATEGORY_LABELS) as ProfileCategory[])
                  .filter((cat) => groups[cat].length > 0)
                  .map((cat) => (
                    <div key={cat}>
                      <h5 className="text-xs font-semibold text-slate-700 mb-1">
                        {CATEGORY_LABELS[cat]}
                      </h5>
                      <ul className="space-y-1.5">
                        {groups[cat].map((n) => (
                          <li
                            key={n.id}
                            className="text-sm text-slate-800 bg-white border border-slate-200 rounded px-3 py-2"
                          >
                            <div>{n.text}</div>
                            <div className="text-[11px] text-slate-400 mt-1">
                              {n.source === 'admin' ? 'admin' : 'distilled'} · {formatDate(n.createdAt)}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ));
              })()}
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded p-3">
            <h5 className="text-xs font-semibold text-slate-700 mb-2">Add a note</h5>
            <div className="flex flex-col gap-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Category</label>
                <select
                  value={draftCategory}
                  onChange={(e) => setDraftCategory(e.target.value as ProfileCategory)}
                  className="w-full px-2 py-1 text-sm border border-slate-300 rounded focus:ring-2 focus:ring-spill-blue-400 outline-none"
                >
                  {(Object.keys(CATEGORY_LABELS) as ProfileCategory[]).map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">{CATEGORY_DESCRIPTIONS[draftCategory]}</p>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Text</label>
                <textarea
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  maxLength={NOTE_MAX_LENGTH}
                  rows={3}
                  placeholder={
                    entity === 'user'
                      ? 'e.g. Prefers brief replies, books mid-afternoon weekday slots.'
                      : 'e.g. Replies within an hour during UK business hours.'
                  }
                  className="w-full px-2 py-1 text-sm border border-slate-300 rounded focus:ring-2 focus:ring-spill-blue-400 outline-none resize-none"
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[11px] text-slate-400">
                    {trimmedDraft.length}/{NOTE_MAX_LENGTH}
                  </span>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    canSubmit && addMutation.mutate({ category: draftCategory, text: trimmedDraft })
                  }
                  disabled={!canSubmit}
                  className="px-3 py-1.5 text-xs font-medium bg-spill-blue-800 text-white rounded hover:bg-spill-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {addMutation.isPending ? 'Saving…' : 'Add note'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {showClearConfirm && (
        <ConfirmDialog
          title="Clear agent profile"
          confirmLabel="Clear profile"
          confirmVariant="danger"
          isPending={clearMutation.isPending}
          onConfirm={() => clearMutation.mutate()}
          onCancel={() => setShowClearConfirm(false)}
        >
          <p className="text-slate-600">
            This wipes every note from this {entity}&apos;s agent profile. The agent will start cold
            on their next booking. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
