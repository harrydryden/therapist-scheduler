import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getKnowledgeEntries,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
} from '../api/client';
import type { KnowledgeEntry, KnowledgeAudience } from '../types';
import { getAudienceColor } from '../config/color-mappings';

const audienceLabels: Record<KnowledgeAudience, string> = {
  therapist: 'Therapist',
  user: 'Client',
  both: 'Both',
};

export default function AdminKnowledgePage() {
  const queryClient = useQueryClient();
  const [editingEntry, setEditingEntry] = useState<KnowledgeEntry | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [audience, setAudience] = useState<KnowledgeAudience>('both');

  // Fetch entries
  const {
    data: entries,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['knowledge-entries'],
    queryFn: getKnowledgeEntries,
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: createKnowledgeEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-entries'] });
      resetForm();
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateKnowledgeEntry>[1] }) =>
      updateKnowledgeEntry(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-entries'] });
      resetForm();
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteKnowledgeEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-entries'] });
    },
  });

  const resetForm = () => {
    setTitle('');
    setContent('');
    setAudience('both');
    setEditingEntry(null);
    setIsCreating(false);
  };

  const scrollToForm = () => {
    // Use setTimeout to ensure React has rendered the form before scrolling
    setTimeout(() => {
      if (formRef.current) {
        formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 50);
  };

  const handleEdit = (entry: KnowledgeEntry) => {
    setEditingEntry(entry);
    setTitle(entry.title || '');
    setContent(entry.content);
    setAudience(entry.audience as KnowledgeAudience);
    setIsCreating(false);
    scrollToForm();
  };

  const handleCreate = () => {
    setIsCreating(true);
    setEditingEntry(null);
    setTitle('');
    setContent('');
    setAudience('both');
    scrollToForm();
  };

  const handleSubmit = () => {
    if (!content.trim()) return;

    if (editingEntry) {
      updateMutation.mutate({
        id: editingEntry.id,
        data: {
          title: title.trim() || null,
          content: content.trim(),
          audience,
        },
      });
    } else {
      createMutation.mutate({
        title: title.trim() || undefined,
        content: content.trim(),
        audience,
      });
    }
  };

  const handleToggleActive = (entry: KnowledgeEntry) => {
    updateMutation.mutate({
      id: entry.id,
      data: { active: !entry.active },
    });
  };

  const handleDelete = (entry: KnowledgeEntry) => {
    if (window.confirm('Are you sure you want to delete this knowledge entry?')) {
      deleteMutation.mutate(entry.id);
    }
  };

  const isFormOpen = isCreating || editingEntry !== null;
  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Knowledge Base</h1>
            <p className="text-slate-600 mt-1">
              Add knowledge and FAQ content for the scheduling agent
            </p>
          </div>
          {!isFormOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCreate();
              }}
              aria-label="Add new knowledge entry"
              className="px-4 py-2 bg-spill-blue text-white rounded-lg hover:bg-primary-600 transition-colors font-medium"
            >
              + Add Entry
            </button>
          )}
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
            <p className="text-red-600">
              {error instanceof Error ? error.message : 'Failed to load knowledge entries'}
            </p>
          </div>
        )}

        {/* Create/Edit Form */}
        {isFormOpen && (
          <div ref={formRef} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              {editingEntry ? 'Edit Entry' : 'New Entry'}
            </h2>

            {/* Title */}
            <div className="mb-4">
              <label htmlFor="knowledge-title" className="block text-sm font-medium text-slate-700 mb-1">
                Title (optional)
              </label>
              <input
                type="text"
                id="knowledge-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Session Prep Tips"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
              />
            </div>

            {/* Audience */}
            <div className="mb-4">
              <label htmlFor="knowledge-audience" className="block text-sm font-medium text-slate-700 mb-1">
                Audience
              </label>
              <select
                id="knowledge-audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value as KnowledgeAudience)}
                aria-describedby="audience-description"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
              >
                <option value="both">Both (Therapist & Client)</option>
                <option value="therapist">Therapist only</option>
                <option value="user">Client only</option>
              </select>
              <p id="audience-description" className="text-xs text-slate-500 mt-1">
                This determines when the agent will use this knowledge
              </p>
            </div>

            {/* Content */}
            <div className="mb-4">
              <label htmlFor="knowledge-content" className="block text-sm font-medium text-slate-700 mb-1">
                Content <span className="text-red-500">*</span>
              </label>
              <textarea
                id="knowledge-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Enter the knowledge or FAQ content that the agent should know..."
                rows={5}
                aria-required="true"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none resize-none"
              />
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  resetForm();
                }}
                aria-label="Cancel and close form"
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  handleSubmit();
                }}
                disabled={!content.trim() || isPending}
                aria-label={editingEntry ? 'Save changes to knowledge entry' : 'Create new knowledge entry'}
                aria-busy={isPending}
                className="px-4 py-2 bg-spill-blue text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 font-medium"
              >
                {isPending ? 'Saving...' : editingEntry ? 'Save Changes' : 'Create Entry'}
              </button>
            </div>

            {(createMutation.isError || updateMutation.isError) && (
              <p className="text-red-500 text-sm mt-3">
                {createMutation.error instanceof Error
                  ? createMutation.error.message
                  : updateMutation.error instanceof Error
                    ? updateMutation.error.message
                    : 'Failed to save entry'}
              </p>
            )}
          </div>
        )}

        {/* Entries List */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h2 className="font-semibold text-slate-900">Knowledge Entries</h2>
            {entries && (
              <p className="text-sm text-slate-500">{entries.length} entries</p>
            )}
          </div>

          {isLoading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue mx-auto"></div>
              <p className="text-sm text-slate-500 mt-2">Loading...</p>
            </div>
          ) : entries && entries.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`p-4 ${!entry.active ? 'bg-slate-50 opacity-60' : ''}`}
                >
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {entry.title ? (
                          <h3 className="font-medium text-slate-900">{entry.title}</h3>
                        ) : (
                          <h3 className="font-medium text-slate-400 italic">Untitled</h3>
                        )}
                        <span
                          className={`px-2 py-0.5 text-xs font-medium rounded-full ${getAudienceColor(entry.audience)}`}
                        >
                          {audienceLabels[entry.audience as KnowledgeAudience]}
                        </span>
                        {!entry.active && (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-200 text-slate-600">
                            Inactive
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 whitespace-pre-wrap line-clamp-3">
                        {entry.content}
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-between items-center mt-3">
                    <span className="text-xs text-slate-400">
                      Updated {new Date(entry.updatedAt).toLocaleDateString()}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleToggleActive(entry);
                        }}
                        aria-label={entry.active ? `Deactivate ${entry.title || 'entry'}` : `Activate ${entry.title || 'entry'}`}
                        className={`px-3 py-1 text-xs rounded border transition-colors ${
                          entry.active
                            ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                            : 'border-primary-200 text-spill-blue hover:bg-primary-50'
                        }`}
                      >
                        {entry.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleEdit(entry);
                        }}
                        aria-label={`Edit ${entry.title || 'entry'}`}
                        className="px-3 py-1 text-xs border border-slate-200 text-slate-600 rounded hover:bg-slate-50 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDelete(entry);
                        }}
                        disabled={deleteMutation.isPending}
                        aria-label={`Delete ${entry.title || 'entry'}`}
                        className="px-3 py-1 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center text-slate-500">
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
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p>No knowledge entries yet</p>
              <p className="text-sm mt-1">Add your first entry to help the scheduling agent</p>
            </div>
          )}
        </div>

        {/* Help Text */}
        <div className="mt-6 p-4 bg-slate-100 rounded-xl">
          <h3 className="font-medium text-slate-700 mb-2">How it works</h3>
          <ul className="text-sm text-slate-600 space-y-1">
            <li>
              <strong>Therapist:</strong> Knowledge shown when the agent communicates with therapists
            </li>
            <li>
              <strong>Client:</strong> Knowledge shown when the agent communicates with clients
            </li>
            <li>
              <strong>Both:</strong> Knowledge available for all communications
            </li>
          </ul>
          <p className="text-sm text-slate-500 mt-2">
            Knowledge entries are injected into the agent's system prompt and help it respond appropriately.
          </p>
        </div>
      </div>
    </div>
  );
}
