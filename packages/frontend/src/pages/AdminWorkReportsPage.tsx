import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchAdminApi } from '../api/client';

// ============================================
// Types
// ============================================

interface WorkReport {
  id: string;
  periodStart: string;
  periodEnd: string;
  emailsSent: number;
  emailsReceived: number;
  appointmentsCreated: number;
  appointmentsConfirmed: number;
  appointmentsCompleted: number;
  appointmentsCancelled: number;
  staleConversationsFlagged: number;
  humanControlTakeovers: number;
  chaseFollowUpsSent: number;
  closureRecommendations: number;
  pipelinePending: number;
  pipelineContacted: number;
  pipelineNegotiating: number;
  pipelineConfirmed: number;
  feedbackSubmissions: number;
  slackSentAt: string | null;
  createdAt: string;
}

// ============================================
// API Functions
// ============================================

async function getWorkReports(page: number): Promise<{ reports: WorkReport[]; total: number; totalPages: number }> {
  const response = await fetchAdminApi<WorkReport[]>(`/admin/work-reports?page=${page}&limit=10`);
  return {
    reports: response.data || [],
    total: (response as { pagination?: { total: number } }).pagination?.total || 0,
    totalPages: (response as { pagination?: { totalPages: number } }).pagination?.totalPages || 1,
  };
}

async function generateReport(): Promise<void> {
  await fetchAdminApi('/admin/work-reports/generate', { method: 'POST' });
}

// ============================================
// Helper Components
// ============================================

function MetricCard({ label, value, color = 'blue' }: { label: string; value: number; color?: string }) {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
  };

  return (
    <div className={`px-3 py-2 rounded-lg border ${colorClasses[color] || colorClasses.blue}`}>
      <div className="text-xs font-medium opacity-75">{label}</div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

function formatPeriod(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  };
  return `${s.toLocaleString('en-GB', opts)} \u2014 ${e.toLocaleString('en-GB', opts)}`;
}

function ReportCard({ report, isExpanded, onToggle }: { report: WorkReport; isExpanded: boolean; onToggle: () => void }) {
  const totalAlerts = report.staleConversationsFlagged + report.humanControlTakeovers + report.chaseFollowUpsSent + report.closureRecommendations;
  const totalPipeline = report.pipelinePending + report.pipelineContacted + report.pipelineNegotiating + report.pipelineConfirmed;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-900">
            {formatPeriod(report.periodStart, report.periodEnd)}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
            <span>{report.emailsSent} sent / {report.emailsReceived} received</span>
            <span>{report.appointmentsConfirmed} confirmed</span>
            <span>{totalPipeline} active</span>
            {totalAlerts > 0 && (
              <span className="text-amber-600 font-medium">{totalAlerts} alert{totalAlerts !== 1 ? 's' : ''}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 ml-4">
          {report.slackSentAt ? (
            <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">Slack sent</span>
          ) : (
            <span className="text-xs text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full">Slack pending</span>
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
      </button>

      {/* Expanded Detail */}
      {isExpanded && (
        <div className="px-5 pb-5 border-t border-slate-100">
          {/* Messages */}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Messages</h4>
            <div className="grid grid-cols-2 gap-2">
              <MetricCard label="Sent" value={report.emailsSent} color="blue" />
              <MetricCard label="Received" value={report.emailsReceived} color="slate" />
            </div>
          </div>

          {/* Appointments */}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Appointments</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MetricCard label="Created" value={report.appointmentsCreated} color="blue" />
              <MetricCard label="Confirmed" value={report.appointmentsConfirmed} color="green" />
              <MetricCard label="Completed" value={report.appointmentsCompleted} color="green" />
              <MetricCard label="Cancelled" value={report.appointmentsCancelled} color="red" />
            </div>
          </div>

          {/* Pipeline Snapshot */}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Pipeline Snapshot ({totalPipeline} active)
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MetricCard label="Pending" value={report.pipelinePending} color="slate" />
              <MetricCard label="Contacted" value={report.pipelineContacted} color="blue" />
              <MetricCard label="Negotiating" value={report.pipelineNegotiating} color="amber" />
              <MetricCard label="Confirmed" value={report.pipelineConfirmed} color="green" />
            </div>
          </div>

          {/* Alerts & Escalations */}
          {totalAlerts > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-amber-600 uppercase tracking-wider mb-2">Alerts & Escalations</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {report.staleConversationsFlagged > 0 && (
                  <MetricCard label="Stale flagged" value={report.staleConversationsFlagged} color="amber" />
                )}
                {report.humanControlTakeovers > 0 && (
                  <MetricCard label="Human takeover" value={report.humanControlTakeovers} color="red" />
                )}
                {report.chaseFollowUpsSent > 0 && (
                  <MetricCard label="Chase sent" value={report.chaseFollowUpsSent} color="amber" />
                )}
                {report.closureRecommendations > 0 && (
                  <MetricCard label="Closure rec." value={report.closureRecommendations} color="red" />
                )}
              </div>
            </div>
          )}

          {/* Feedback */}
          {report.feedbackSubmissions > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-2">Feedback</h4>
              <MetricCard label="Submissions" value={report.feedbackSubmissions} color="purple" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// Main Page
// ============================================

export default function AdminWorkReportsPage() {
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['work-reports', page],
    queryFn: () => getWorkReports(page),
  });

  const generateMutation = useMutation({
    mutationFn: generateReport,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-reports'] });
    },
  });

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Work Reports</h1>
          <p className="mt-1 text-sm text-slate-500">
            Daily summaries of agent activity, generated every weekday at 9am
          </p>
        </div>
        <button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 bg-spill-blue-600 hover:bg-spill-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {generateMutation.isPending ? (
            <>
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Generating...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Generate Now
            </>
          )}
        </button>
      </div>

      {/* Success / Error Messages */}
      {generateMutation.isSuccess && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          Report generated and sent to Slack successfully.
        </div>
      )}
      {generateMutation.isError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Failed to generate report: {(generateMutation.error as Error).message}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center p-12">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Failed to load reports: {(error as Error).message}
        </div>
      )}

      {/* Reports List */}
      {data && (
        <>
          {data.reports.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <svg className="mx-auto w-12 h-12 text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p>No work reports yet</p>
              <p className="text-sm mt-1">Reports are generated automatically every weekday at 9am, or click "Generate Now".</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.reports.map((report) => (
                <ReportCard
                  key={report.id}
                  report={report}
                  isExpanded={expandedId === report.id}
                  onToggle={() => setExpandedId(expandedId === report.id ? null : report.id)}
                />
              ))}
            </div>
          )}

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-slate-500">
                Page {page} of {data.totalPages} ({data.total} report{data.total !== 1 ? 's' : ''})
              </span>
              <button
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={page === data.totalPages}
                className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
