import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE, ADMIN_SECRET } from '../config/env';
import { HEADERS } from '../config/constants';

// ============================================
// Types
// ============================================

interface FormQuestion {
  id: string;
  type: 'text' | 'scale' | 'choice';
  question: string;
  required: boolean;
  prefilled?: boolean;
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  options?: string[];
}

interface FormConfig {
  id: string;
  formName: string;
  description: string | null;
  welcomeTitle: string;
  welcomeMessage: string;
  thankYouTitle: string;
  thankYouMessage: string;
  questions: FormQuestion[];
  isActive: boolean;
  requiresAuth: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FeedbackSubmission {
  id: string;
  trackingCode: string | null;
  userEmail: string | null;
  userName: string | null;
  therapistName: string;
  responses: Record<string, string | number>;
  safetyScore: number | null;
  listenedToScore: number | null;
  professionalScore: number | null;
  wouldBookAgain: string | null;
  syncedToNotion: boolean;
  createdAt: string;
  appointment?: {
    id: string;
    trackingCode: string;
    confirmedDateTime: string;
    status: string;
  };
}

interface FeedbackStats {
  totalSubmissions: number;
  recentSubmissions: number;
  unsyncedCount: number;
  averageScores: {
    safety: string | null;
    listenedTo: string | null;
    professional: string | null;
  };
  wouldBookAgain: Record<string, number>;
}

// ============================================
// API Functions
// ============================================

async function fetchAdminApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      [HEADERS.WEBHOOK_SECRET]: ADMIN_SECRET,
      ...options?.headers,
    },
    ...options,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'An error occurred');
  }

  return data;
}

async function getFormConfig(): Promise<FormConfig> {
  return fetchAdminApi<FormConfig>('/api/admin/forms/feedback');
}

async function updateFormConfig(updates: Partial<FormConfig>): Promise<FormConfig> {
  return fetchAdminApi<FormConfig>('/api/admin/forms/feedback', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

async function getSubmissions(params?: {
  page?: number;
  limit?: number;
  therapist?: string;
}): Promise<{
  submissions: FeedbackSubmission[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.set('page', String(params.page));
  if (params?.limit) queryParams.set('limit', String(params.limit));
  if (params?.therapist) queryParams.set('therapist', params.therapist);

  return fetchAdminApi(`/api/admin/forms/feedback/submissions?${queryParams.toString()}`);
}

async function getStats(): Promise<FeedbackStats> {
  return fetchAdminApi<FeedbackStats>('/api/admin/forms/feedback/stats');
}

// ============================================
// Components
// ============================================

function QuestionEditor({
  question,
  onChange,
  onDelete,
}: {
  question: FormQuestion;
  onChange: (updated: FormQuestion) => void;
  onDelete: () => void;
}) {
  return (
    <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
      <div className="flex justify-between items-start mb-3">
        <span className="text-xs font-medium text-slate-500 uppercase">
          {question.type === 'text' && 'Text Input'}
          {question.type === 'scale' && 'Rating Scale'}
          {question.type === 'choice' && 'Multiple Choice'}
        </span>
        <button
          onClick={onDelete}
          className="text-red-500 hover:text-red-700 text-sm"
        >
          Remove
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Question ID</label>
          <input
            type="text"
            value={question.id}
            onChange={(e) => onChange({ ...question, id: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            placeholder="unique_id"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Question Text</label>
          <input
            type="text"
            value={question.question}
            onChange={(e) => onChange({ ...question, question: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            placeholder="Enter your question..."
          />
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={question.required}
              onChange={(e) => onChange({ ...question, required: e.target.checked })}
              className="rounded border-slate-300"
            />
            <span className="text-sm text-slate-700">Required</span>
          </label>

          {question.type === 'text' && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={question.prefilled || false}
                onChange={(e) => onChange({ ...question, prefilled: e.target.checked })}
                className="rounded border-slate-300"
              />
              <span className="text-sm text-slate-700">Pre-filled from appointment</span>
            </label>
          )}
        </div>

        {question.type === 'scale' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Min Value</label>
              <input
                type="number"
                value={question.scaleMin ?? 0}
                onChange={(e) => onChange({ ...question, scaleMin: parseInt(e.target.value) })}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Max Value</label>
              <input
                type="number"
                value={question.scaleMax ?? 5}
                onChange={(e) => onChange({ ...question, scaleMax: parseInt(e.target.value) })}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Min Label</label>
              <input
                type="text"
                value={question.scaleMinLabel || ''}
                onChange={(e) => onChange({ ...question, scaleMinLabel: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="Not at all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Max Label</label>
              <input
                type="text"
                value={question.scaleMaxLabel || ''}
                onChange={(e) => onChange({ ...question, scaleMaxLabel: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="Very much"
              />
            </div>
          </div>
        )}

        {question.type === 'choice' && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Options (one per line)</label>
            <textarea
              value={(question.options || []).join('\n')}
              onChange={(e) =>
                onChange({
                  ...question,
                  options: e.target.value.split('\n').filter((o) => o.trim()),
                })
              }
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="Option 1&#10;Option 2&#10;Option 3"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function StatsCard({
  label,
  value,
  subtext,
}: {
  label: string;
  value: string | number;
  subtext?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-sm text-slate-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      {subtext && <p className="text-xs text-slate-400 mt-1">{subtext}</p>}
    </div>
  );
}

// ============================================
// Main Page Component
// ============================================

export default function AdminFormsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'config' | 'submissions' | 'stats'>('config');

  // Form config state
  const [editedConfig, setEditedConfig] = useState<Partial<FormConfig> | null>(null);
  const [page, setPage] = useState(1);

  // Fetch form config
  const {
    data: formConfig,
    isLoading: configLoading,
    error: configError,
  } = useQuery({
    queryKey: ['feedbackFormConfig'],
    queryFn: getFormConfig,
  });

  // Fetch submissions
  const {
    data: submissionsData,
    isLoading: submissionsLoading,
  } = useQuery({
    queryKey: ['feedbackSubmissions', page],
    queryFn: () => getSubmissions({ page, limit: 20 }),
    enabled: activeTab === 'submissions',
  });

  // Fetch stats
  const {
    data: stats,
    isLoading: statsLoading,
  } = useQuery({
    queryKey: ['feedbackStats'],
    queryFn: getStats,
    enabled: activeTab === 'stats',
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: updateFormConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedbackFormConfig'] });
      setEditedConfig(null);
    },
  });

  // Initialize edited config when form config loads
  useEffect(() => {
    if (formConfig && !editedConfig) {
      setEditedConfig({
        formName: formConfig.formName,
        description: formConfig.description,
        welcomeTitle: formConfig.welcomeTitle,
        welcomeMessage: formConfig.welcomeMessage,
        thankYouTitle: formConfig.thankYouTitle,
        thankYouMessage: formConfig.thankYouMessage,
        questions: formConfig.questions,
        isActive: formConfig.isActive,
        requiresAuth: formConfig.requiresAuth,
      });
    }
  }, [formConfig, editedConfig]);

  const handleSave = () => {
    if (editedConfig) {
      updateMutation.mutate(editedConfig);
    }
  };

  const handleAddQuestion = (type: 'text' | 'scale' | 'choice') => {
    if (!editedConfig) return;

    const newQuestion: FormQuestion = {
      id: `question_${Date.now()}`,
      type,
      question: '',
      required: true,
      ...(type === 'scale' && { scaleMin: 0, scaleMax: 5, scaleMinLabel: 'Not at all', scaleMaxLabel: 'Very' }),
      ...(type === 'choice' && { options: ['Yes', 'No'] }),
    };

    setEditedConfig({
      ...editedConfig,
      questions: [...(editedConfig.questions || []), newQuestion],
    });
  };

  const handleUpdateQuestion = (index: number, updated: FormQuestion) => {
    if (!editedConfig) return;
    const questions = [...(editedConfig.questions || [])];
    questions[index] = updated;
    setEditedConfig({ ...editedConfig, questions });
  };

  const handleDeleteQuestion = (index: number) => {
    if (!editedConfig) return;
    const questions = [...(editedConfig.questions || [])];
    questions.splice(index, 1);
    setEditedConfig({ ...editedConfig, questions });
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Forms Management</h1>
          <p className="text-slate-600 mt-1">Configure feedback forms and view submissions</p>
        </div>

        {/* Error State */}
        {configError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
            <p className="text-red-600">
              {configError instanceof Error ? configError.message : 'Failed to load form config'}
            </p>
          </div>
        )}

        {/* Tabs */}
        <div className="mb-6 flex gap-2 border-b border-slate-200">
          <button
            onClick={() => setActiveTab('config')}
            className={`px-4 py-2 font-medium text-sm transition-colors ${
              activeTab === 'config'
                ? 'text-spill-blue-800 border-b-2 border-spill-blue-800'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Form Configuration
          </button>
          <button
            onClick={() => setActiveTab('submissions')}
            className={`px-4 py-2 font-medium text-sm transition-colors ${
              activeTab === 'submissions'
                ? 'text-spill-blue-800 border-b-2 border-spill-blue-800'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Submissions
          </button>
          <button
            onClick={() => setActiveTab('stats')}
            className={`px-4 py-2 font-medium text-sm transition-colors ${
              activeTab === 'stats'
                ? 'text-spill-blue-800 border-b-2 border-spill-blue-800'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Statistics
          </button>
        </div>

        {/* Form Configuration Tab */}
        {activeTab === 'config' && (
          <div className="space-y-6">
            {configLoading ? (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-spill-grey-200 border-t-spill-blue-800 mx-auto"></div>
                <p className="text-sm text-slate-500 mt-2">Loading form configuration...</p>
              </div>
            ) : editedConfig && (
              <>
                {/* Basic Settings */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                  <h2 className="text-lg font-semibold text-slate-900 mb-4">Basic Settings</h2>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Form Name</label>
                      <input
                        type="text"
                        value={editedConfig.formName || ''}
                        onChange={(e) => setEditedConfig({ ...editedConfig, formName: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                      <textarea
                        value={editedConfig.description || ''}
                        onChange={(e) => setEditedConfig({ ...editedConfig, description: e.target.value })}
                        rows={2}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                      />
                    </div>

                    <div className="flex gap-4">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={editedConfig.isActive || false}
                          onChange={(e) => setEditedConfig({ ...editedConfig, isActive: e.target.checked })}
                          className="rounded border-slate-300"
                        />
                        <span className="text-sm text-slate-700">Form Active</span>
                      </label>

                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={editedConfig.requiresAuth || false}
                          onChange={(e) => setEditedConfig({ ...editedConfig, requiresAuth: e.target.checked })}
                          className="rounded border-slate-300"
                        />
                        <span className="text-sm text-slate-700">Requires SPL Code</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Welcome Screen */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                  <h2 className="text-lg font-semibold text-slate-900 mb-4">Welcome Screen</h2>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                      <input
                        type="text"
                        value={editedConfig.welcomeTitle || ''}
                        onChange={(e) => setEditedConfig({ ...editedConfig, welcomeTitle: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Message</label>
                      <textarea
                        value={editedConfig.welcomeMessage || ''}
                        onChange={(e) => setEditedConfig({ ...editedConfig, welcomeMessage: e.target.value })}
                        rows={3}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                </div>

                {/* Thank You Screen */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                  <h2 className="text-lg font-semibold text-slate-900 mb-4">Thank You Screen</h2>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                      <input
                        type="text"
                        value={editedConfig.thankYouTitle || ''}
                        onChange={(e) => setEditedConfig({ ...editedConfig, thankYouTitle: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Message</label>
                      <textarea
                        value={editedConfig.thankYouMessage || ''}
                        onChange={(e) => setEditedConfig({ ...editedConfig, thankYouMessage: e.target.value })}
                        rows={3}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                </div>

                {/* Questions */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-lg font-semibold text-slate-900">Questions</h2>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAddQuestion('text')}
                        className="px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
                      >
                        + Text
                      </button>
                      <button
                        onClick={() => handleAddQuestion('scale')}
                        className="px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
                      >
                        + Scale
                      </button>
                      <button
                        onClick={() => handleAddQuestion('choice')}
                        className="px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
                      >
                        + Choice
                      </button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    {(editedConfig.questions || []).map((question, index) => (
                      <QuestionEditor
                        key={question.id}
                        question={question}
                        onChange={(updated) => handleUpdateQuestion(index, updated)}
                        onDelete={() => handleDeleteQuestion(index)}
                      />
                    ))}

                    {(!editedConfig.questions || editedConfig.questions.length === 0) && (
                      <p className="text-center text-slate-500 py-8">
                        No questions added yet. Click the buttons above to add questions.
                      </p>
                    )}
                  </div>
                </div>

                {/* Save Button */}
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setEditedConfig(null)}
                    className="px-4 py-2 text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={updateMutation.isPending}
                    className="px-6 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-spill-blue-700 disabled:opacity-50"
                  >
                    {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>

                {updateMutation.isError && (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                    <p className="text-red-600 text-sm">
                      {updateMutation.error instanceof Error
                        ? updateMutation.error.message
                        : 'Failed to save changes'}
                    </p>
                  </div>
                )}

                {updateMutation.isSuccess && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                    <p className="text-green-600 text-sm">Changes saved successfully!</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Submissions Tab */}
        {activeTab === 'submissions' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            {submissionsLoading ? (
              <div className="p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-spill-grey-200 border-t-spill-blue-800 mx-auto"></div>
                <p className="text-sm text-slate-500 mt-2">Loading submissions...</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50 border-b border-slate-100">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Date</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Tracking Code</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Therapist</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">Safety</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">Listened</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">Professional</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">Book Again?</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">Synced</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {submissionsData?.submissions.map((submission) => (
                        <tr key={submission.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-sm text-slate-600">
                            {new Date(submission.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-sm font-mono text-slate-700">
                            {submission.trackingCode || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-700">{submission.therapistName}</td>
                          <td className="px-4 py-3 text-center">
                            <ScoreBadge score={submission.safetyScore} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <ScoreBadge score={submission.listenedToScore} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <ScoreBadge score={submission.professionalScore} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <BookAgainBadge value={submission.wouldBookAgain} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            {submission.syncedToNotion ? (
                              <span className="text-green-600">✓</span>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {submissionsData?.pagination && (
                  <div className="px-4 py-3 border-t border-slate-100 flex justify-between items-center">
                    <p className="text-sm text-slate-500">
                      Showing {((page - 1) * 20) + 1} to {Math.min(page * 20, submissionsData.pagination.total)} of{' '}
                      {submissionsData.pagination.total} submissions
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setPage(page - 1)}
                        disabled={page === 1}
                        className="px-3 py-1 text-sm border border-slate-200 rounded-lg disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <button
                        onClick={() => setPage(page + 1)}
                        disabled={page >= submissionsData.pagination.totalPages}
                        className="px-3 py-1 text-sm border border-slate-200 rounded-lg disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}

                {submissionsData?.submissions.length === 0 && (
                  <p className="text-center text-slate-500 py-8">No submissions yet.</p>
                )}
              </>
            )}
          </div>
        )}

        {/* Statistics Tab */}
        {activeTab === 'stats' && (
          <div className="space-y-6">
            {statsLoading ? (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-spill-grey-200 border-t-spill-blue-800 mx-auto"></div>
                <p className="text-sm text-slate-500 mt-2">Loading statistics...</p>
              </div>
            ) : stats && (
              <>
                {/* Overview Stats */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <StatsCard
                    label="Total Submissions"
                    value={stats.totalSubmissions}
                    subtext="All time"
                  />
                  <StatsCard
                    label="Last 30 Days"
                    value={stats.recentSubmissions}
                    subtext="Recent activity"
                  />
                  <StatsCard
                    label="Pending Sync"
                    value={stats.unsyncedCount}
                    subtext="Awaiting Notion sync"
                  />
                  <StatsCard
                    label="Avg Safety Score"
                    value={stats.averageScores.safety || '-'}
                    subtext="Out of 5"
                  />
                </div>

                {/* Average Scores */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                  <h2 className="text-lg font-semibold text-slate-900 mb-4">Average Scores (Last 30 Days)</h2>
                  <div className="grid grid-cols-3 gap-6">
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Safety & Comfort</p>
                      <p className="text-3xl font-bold text-slate-900">
                        {stats.averageScores.safety || '-'}
                        <span className="text-lg text-slate-400 font-normal"> / 5</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Listened To</p>
                      <p className="text-3xl font-bold text-slate-900">
                        {stats.averageScores.listenedTo || '-'}
                        <span className="text-lg text-slate-400 font-normal"> / 5</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Professional</p>
                      <p className="text-3xl font-bold text-slate-900">
                        {stats.averageScores.professional || '-'}
                        <span className="text-lg text-slate-400 font-normal"> / 5</span>
                      </p>
                    </div>
                  </div>
                </div>

                {/* Would Book Again */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                  <h2 className="text-lg font-semibold text-slate-900 mb-4">Would Book Again (Last 30 Days)</h2>
                  <div className="flex gap-4">
                    {['yes', 'maybe', 'no'].map((option) => (
                      <div key={option} className="flex-1">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-slate-500 capitalize">{option}</span>
                          <span className="text-sm font-medium text-slate-700">
                            {stats.wouldBookAgain[option] || 0}
                          </span>
                        </div>
                        <div className="h-4 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${
                              option === 'yes'
                                ? 'bg-green-500'
                                : option === 'maybe'
                                  ? 'bg-yellow-500'
                                  : 'bg-red-500'
                            }`}
                            style={{
                              width: `${
                                ((stats.wouldBookAgain[option] || 0) /
                                  Math.max(
                                    1,
                                    Object.values(stats.wouldBookAgain).reduce((a, b) => a + b, 0)
                                  )) *
                                100
                              }%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Helper Components

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-slate-400">-</span>;

  const color =
    score >= 4
      ? 'bg-green-100 text-green-700'
      : score >= 3
        ? 'bg-yellow-100 text-yellow-700'
        : 'bg-red-100 text-red-700';

  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {score}/5
    </span>
  );
}

function BookAgainBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-400">-</span>;

  const lower = value.toLowerCase();
  const color =
    lower === 'yes'
      ? 'bg-green-100 text-green-700'
      : lower === 'maybe'
        ? 'bg-yellow-100 text-yellow-700'
        : 'bg-red-100 text-red-700';

  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {value}
    </span>
  );
}
