import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { ReprocessPreviewResult, ReprocessThreadResult } from '../../api/client';

interface ScanResultsPanelProps {
  appointmentId: string;
  previewReprocessMutation: UseMutationResult<ReprocessPreviewResult, Error, string>;
  reprocessThreadMutation: UseMutationResult<ReprocessThreadResult, Error, { id: string; forceMessageIds?: string[] }>;
  reprocessPreview: ReprocessPreviewResult | null;
  reprocessResult: ReprocessThreadResult | null;
  onDismissPreview: () => void;
  onDismissResult: () => void;
}

export default function ScanResultsPanel({
  appointmentId,
  previewReprocessMutation,
  reprocessThreadMutation,
  reprocessPreview,
  reprocessResult,
  onDismissPreview,
  onDismissResult,
}: ScanResultsPanelProps) {
  return (
    <div>
      {previewReprocessMutation.isPending && (
        <p className="text-xs text-slate-500">Scanning Gmail threads...</p>
      )}

      {reprocessPreview && (
        <div className="p-3 border border-slate-200 rounded-lg bg-white">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-xs font-medium text-slate-800">Scan Results</h4>
            <button
              onClick={onDismissPreview}
              aria-label="Close scan results"
              className="text-slate-400 hover:text-slate-600 text-xs"
            >
              &times;
            </button>
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
                        msg.status === 'unprocessed'
                          ? 'bg-yellow-50 border-yellow-200'
                          : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <span className="font-medium truncate flex-1">{msg.from}</span>
                        <span
                          className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            msg.status === 'unprocessed'
                              ? 'bg-yellow-200 text-yellow-800'
                              : 'bg-slate-200 text-slate-600'
                          }`}
                        >
                          {msg.status === 'unprocessed' ? 'MISSED' : 'OK'}
                        </span>
                      </div>
                      {msg.snippet && (
                        <p className="text-slate-500 mt-0.5 truncate">{msg.snippet}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Action row */}
          <div className="flex gap-2 mt-3">
            <button
              onClick={onDismissPreview}
              className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
            >
              Cancel
            </button>
            {reprocessPreview.unprocessedCount > 0 && (
              <button
                onClick={() => {
                  const unprocessedIds = reprocessPreview.threads
                    .flatMap(t => t.messages)
                    .filter(m => m.status === 'unprocessed')
                    .map(m => m.messageId);
                  reprocessThreadMutation.mutate({ id: appointmentId, forceMessageIds: unprocessedIds });
                }}
                disabled={reprocessThreadMutation.isPending}
                aria-busy={reprocessThreadMutation.isPending}
                className="flex-1 px-3 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
              >
                {reprocessThreadMutation.isPending
                  ? 'Recovering...'
                  : `Recover ${reprocessPreview.unprocessedCount} Message${reprocessPreview.unprocessedCount === 1 ? '' : 's'}`}
              </button>
            )}
            {reprocessPreview.unprocessedCount === 0 && (
              <ForceReprocessButton
                appointmentId={appointmentId}
                preview={reprocessPreview}
                reprocessMutation={reprocessThreadMutation}
              />
            )}
          </div>
        </div>
      )}

      {reprocessResult && (
        <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex justify-between items-start">
            <p className="text-xs text-green-700">{reprocessResult.message}</p>
            <button onClick={onDismissResult} className="text-green-500 hover:text-green-700 text-xs ml-2">
              &times;
            </button>
          </div>
        </div>
      )}

      {reprocessThreadMutation.isError && (
        <p className="text-red-500 text-xs mt-2">
          {reprocessThreadMutation.error instanceof Error
            ? reprocessThreadMutation.error.message
            : 'Failed to reprocess thread'}
        </p>
      )}

      {previewReprocessMutation.isError && !reprocessPreview && (
        <p className="text-red-500 text-xs mt-2">
          {previewReprocessMutation.error instanceof Error
            ? previewReprocessMutation.error.message
            : 'Failed to scan thread'}
        </p>
      )}
    </div>
  );
}

function ForceReprocessButton({
  appointmentId,
  preview,
  reprocessMutation,
}: {
  appointmentId: string;
  preview: ReprocessPreviewResult;
  reprocessMutation: UseMutationResult<ReprocessThreadResult, Error, { id: string; forceMessageIds?: string[] }>;
}) {
  const [showForce, setShowForce] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const allProcessedMessages = preview.threads.flatMap((t) =>
    t.messages.filter((m) => m.status === 'processed')
  );

  if (!showForce) {
    return (
      <button
        onClick={() => setShowForce(true)}
        className="flex-1 px-3 py-2 border border-orange-300 text-orange-700 rounded-lg hover:bg-orange-50 transition-colors text-sm"
      >
        Force Reprocess...
      </button>
    );
  }

  const toggleMessage = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex-1">
      <div className="p-2 bg-orange-50 border border-orange-200 rounded-lg mb-2">
        <p className="text-xs text-orange-800 font-medium mb-1">
          Select messages to force-reprocess:
        </p>
        <p className="text-[10px] text-orange-600 mb-2">
          Warning: Force-reprocessing may cause duplicate emails or actions if the message was already fully processed.
        </p>
        <div className="space-y-1">
          {allProcessedMessages.map((msg) => (
            <label
              key={msg.messageId}
              className="flex items-start gap-2 text-xs p-1.5 rounded border border-orange-200 bg-white cursor-pointer hover:bg-orange-25"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(msg.messageId)}
                onChange={() => toggleMessage(msg.messageId)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <span className="font-medium truncate block">{msg.from}</span>
                {msg.snippet && (
                  <span className="text-slate-500 truncate block">{msg.snippet}</span>
                )}
              </div>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => { setShowForce(false); setSelectedIds(new Set()); }}
          className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            reprocessMutation.mutate({
              id: appointmentId,
              forceMessageIds: Array.from(selectedIds),
            });
          }}
          disabled={selectedIds.size === 0 || reprocessMutation.isPending}
          aria-busy={reprocessMutation.isPending}
          className="flex-1 px-3 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 text-sm font-medium"
        >
          {reprocessMutation.isPending
            ? 'Reprocessing...'
            : `Force Reprocess (${selectedIds.size})`}
        </button>
      </div>
    </div>
  );
}
