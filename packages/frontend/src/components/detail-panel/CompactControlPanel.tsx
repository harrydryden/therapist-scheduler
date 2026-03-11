import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AppointmentDetail } from '../../types';
import type { ReprocessPreviewResult, ReprocessThreadResult } from '../../api/client';
import HumanControlSection from './HumanControlSection';
import DeleteSection from './DeleteSection';

type ControlView = null | 'control' | 'scan' | 'delete';

interface CompactControlPanelProps {
  appointment: AppointmentDetail;
  mutationError: string | null;
  onDismissError: () => void;
  takeControlMutation: UseMutationResult<unknown, Error, { id: string; reason?: string }>;
  releaseControlMutation: UseMutationResult<unknown, Error, string>;
  updateAppointmentMutation: UseMutationResult<{ warning?: string }, Error, { id: string; status?: string; confirmedDateTime?: string | null }>;
  sendMessageMutation: UseMutationResult<unknown, Error, { id: string; to: string; subject: string; body: string }>;
  previewReprocessMutation: UseMutationResult<ReprocessPreviewResult, Error, string>;
  reprocessThreadMutation: UseMutationResult<ReprocessThreadResult, Error, { id: string; forceMessageIds?: string[] }>;
  reprocessPreview: ReprocessPreviewResult | null;
  reprocessResult: ReprocessThreadResult | null;
  onDismissReprocessPreview: () => void;
  onDismissReprocessResult: () => void;
  showEditPanel: boolean;
  onShowEditPanel: (show: boolean) => void;
  editStatus: string | null;
  onEditStatusChange: (status: string) => void;
  editConfirmedDateTime: string;
  onEditConfirmedDateTimeChange: (value: string) => void;
  editWarning: string | null;
  deleteAppointmentMutation: UseMutationResult<unknown, Error, { id: string; reason?: string; forceDeleteConfirmed?: boolean }>;
}

export default function CompactControlPanel({
  appointment,
  mutationError,
  onDismissError,
  takeControlMutation,
  releaseControlMutation,
  updateAppointmentMutation,
  sendMessageMutation,
  previewReprocessMutation,
  reprocessThreadMutation,
  reprocessPreview,
  reprocessResult,
  onDismissReprocessPreview,
  onDismissReprocessResult,
  showEditPanel,
  onShowEditPanel,
  editStatus,
  onEditStatusChange,
  editConfirmedDateTime,
  onEditConfirmedDateTimeChange,
  editWarning,
  deleteAppointmentMutation,
}: CompactControlPanelProps) {
  const [expandedView, setExpandedView] = useState<ControlView>(null);

  const hasThreads = appointment.gmailThreadId || appointment.therapistGmailThreadId;
  const isControlActive = appointment.humanControlEnabled;

  // Auto-expand human control section if control is active
  const effectiveExpanded = isControlActive && expandedView === null ? 'control' : expandedView;

  return (
    <div className="border-b border-slate-100">
      {/* Compact button row */}
      <div className="px-4 py-2 flex gap-2">
        <button
          onClick={() => setExpandedView(effectiveExpanded === 'control' ? null : 'control')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            isControlActive
              ? 'bg-orange-50 border-orange-300 text-orange-700 hover:bg-orange-100'
              : effectiveExpanded === 'control'
                ? 'bg-slate-100 border-slate-300 text-slate-700'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          {isControlActive ? 'Human Control' : 'Take Control'}
        </button>

        {hasThreads && (
          <button
            onClick={() => {
              if (effectiveExpanded !== 'scan') {
                setExpandedView('scan');
                // Auto-trigger scan
                if (!reprocessPreview && !previewReprocessMutation.isPending) {
                  previewReprocessMutation.mutate(appointment.id);
                }
              } else {
                setExpandedView(null);
              }
            }}
            disabled={previewReprocessMutation.isPending}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              effectiveExpanded === 'scan'
                ? 'bg-slate-100 border-slate-300 text-slate-700'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            } disabled:opacity-50`}
          >
            {previewReprocessMutation.isPending ? 'Scanning...' : 'Scan Messages'}
          </button>
        )}

        <button
          onClick={() => setExpandedView(effectiveExpanded === 'delete' ? null : 'delete')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            effectiveExpanded === 'delete'
              ? 'bg-red-50 border-red-300 text-red-600'
              : 'border-red-200 text-red-500 hover:bg-red-50'
          }`}
        >
          Delete
        </button>
      </div>

      {/* Expanded panels */}
      {effectiveExpanded === 'control' && (
        <HumanControlSection
          appointment={appointment}
          mutationError={mutationError}
          onDismissError={onDismissError}
          takeControlMutation={takeControlMutation}
          releaseControlMutation={releaseControlMutation}
          updateAppointmentMutation={updateAppointmentMutation}
          sendMessageMutation={sendMessageMutation}
          previewReprocessMutation={previewReprocessMutation}
          reprocessThreadMutation={reprocessThreadMutation}
          reprocessPreview={reprocessPreview}
          reprocessResult={reprocessResult}
          onDismissReprocessPreview={onDismissReprocessPreview}
          onDismissReprocessResult={onDismissReprocessResult}
          showEditPanel={showEditPanel}
          onShowEditPanel={onShowEditPanel}
          editStatus={editStatus}
          onEditStatusChange={onEditStatusChange}
          editConfirmedDateTime={editConfirmedDateTime}
          onEditConfirmedDateTimeChange={onEditConfirmedDateTimeChange}
          editWarning={editWarning}
        />
      )}

      {effectiveExpanded === 'scan' && !isControlActive && (
        <ScanPanel
          appointment={appointment}
          previewReprocessMutation={previewReprocessMutation}
          reprocessThreadMutation={reprocessThreadMutation}
          reprocessPreview={reprocessPreview}
          reprocessResult={reprocessResult}
          onDismissReprocessPreview={onDismissReprocessPreview}
          onDismissReprocessResult={onDismissReprocessResult}
        />
      )}

      {effectiveExpanded === 'delete' && (
        <div className="px-4 pb-3">
          <DeleteSection
            appointment={appointment}
            deleteMutation={deleteAppointmentMutation}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Standalone scan panel for when human control is not active.
 * When human control IS active, the scan UI is embedded inside HumanControlSection.
 */
function ScanPanel({
  appointment,
  previewReprocessMutation,
  reprocessThreadMutation,
  reprocessPreview,
  reprocessResult,
  onDismissReprocessPreview,
  onDismissReprocessResult,
}: {
  appointment: AppointmentDetail;
  previewReprocessMutation: UseMutationResult<ReprocessPreviewResult, Error, string>;
  reprocessThreadMutation: UseMutationResult<ReprocessThreadResult, Error, { id: string; forceMessageIds?: string[] }>;
  reprocessPreview: ReprocessPreviewResult | null;
  reprocessResult: ReprocessThreadResult | null;
  onDismissReprocessPreview: () => void;
  onDismissReprocessResult: () => void;
}) {
  return (
    <div className="px-4 pb-3">
      {previewReprocessMutation.isPending && (
        <p className="text-xs text-slate-500">Scanning Gmail threads...</p>
      )}

      {reprocessPreview && (
        <div className="p-3 border border-slate-200 rounded-lg bg-white">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-xs font-medium text-slate-800">Scan Results</h4>
            <button onClick={onDismissReprocessPreview} className="text-slate-400 hover:text-slate-600 text-xs">&times;</button>
          </div>
          <p className="text-xs text-slate-600 mb-2">{reprocessPreview.message}</p>
          {reprocessPreview.threads.map((thread) => (
            <div key={thread.threadId} className="mb-2">
              <p className="text-xs font-medium text-slate-700 mb-1">
                {thread.type === 'therapist' ? 'Therapist' : 'Client'} thread:
              </p>
              {thread.messages.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No inbound messages</p>
              ) : (
                <div className="space-y-1">
                  {thread.messages.map((msg) => (
                    <div
                      key={msg.messageId}
                      className={`text-xs p-1.5 rounded border ${
                        msg.status === 'unprocessed' ? 'bg-yellow-50 border-yellow-200' : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <span className="font-medium truncate flex-1">{msg.from}</span>
                        <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          msg.status === 'unprocessed' ? 'bg-yellow-200 text-yellow-800' : 'bg-slate-200 text-slate-600'
                        }`}>
                          {msg.status === 'unprocessed' ? 'MISSED' : 'OK'}
                        </span>
                      </div>
                      {msg.snippet && <p className="text-slate-500 mt-0.5 truncate">{msg.snippet}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {reprocessPreview.unprocessedCount > 0 && (
            <button
              onClick={() => {
                const unprocessedIds = reprocessPreview.threads
                  .flatMap(t => t.messages)
                  .filter(m => m.status === 'unprocessed')
                  .map(m => m.messageId);
                reprocessThreadMutation.mutate({ id: appointment.id, forceMessageIds: unprocessedIds });
              }}
              disabled={reprocessThreadMutation.isPending}
              className="w-full mt-2 px-3 py-1.5 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-xs font-medium"
            >
              {reprocessThreadMutation.isPending
                ? 'Recovering...'
                : `Recover ${reprocessPreview.unprocessedCount} Message${reprocessPreview.unprocessedCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}

      {reprocessResult && (
        <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex justify-between items-start">
            <p className="text-xs text-green-700">{reprocessResult.message}</p>
            <button onClick={onDismissReprocessResult} className="text-green-500 hover:text-green-700 text-xs ml-2">&times;</button>
          </div>
        </div>
      )}

      {previewReprocessMutation.isError && !reprocessPreview && (
        <p className="text-red-500 text-xs mt-1">
          {previewReprocessMutation.error instanceof Error
            ? previewReprocessMutation.error.message
            : 'Failed to scan thread'}
        </p>
      )}
    </div>
  );
}
