import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AppointmentDetail } from '../../types';
import type { ReprocessPreviewResult, ReprocessThreadResult } from '../../api/client';

interface HumanControlSectionProps {
  appointment: AppointmentDetail;
  mutationError: string | null;
  onDismissError: () => void;
  // Mutations
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
  // Edit state (managed by parent for timeout cleanup)
  showEditPanel: boolean;
  onShowEditPanel: (show: boolean) => void;
  editStatus: string | null;
  onEditStatusChange: (status: string) => void;
  editConfirmedDateTime: string;
  onEditConfirmedDateTimeChange: (value: string) => void;
  editWarning: string | null;
}

export default function HumanControlSection({
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
}: HumanControlSectionProps) {
  const [controlReason, setControlReason] = useState('');
  const [showComposeMessage, setShowComposeMessage] = useState(false);
  const [messageRecipient, setMessageRecipient] = useState<'client' | 'therapist'>('client');
  const [messageSubject, setMessageSubject] = useState('');
  const [messageBody, setMessageBody] = useState('');

  const handleSendMessage = () => {
    if (!messageSubject.trim() || !messageBody.trim()) return;
    const to =
      messageRecipient === 'client'
        ? appointment.userEmail
        : appointment.therapistEmail;
    sendMessageMutation.mutate(
      { id: appointment.id, to, subject: messageSubject, body: messageBody },
      {
        onSuccess: () => {
          setShowComposeMessage(false);
          setMessageSubject('');
          setMessageBody('');
        },
      }
    );
  };

  return (
    <div className="p-4 border-b border-slate-100 bg-slate-50">
      {/* Mutation Error Display */}
      {mutationError && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex justify-between items-start">
            <p className="text-sm text-red-700">{mutationError}</p>
            <button
              onClick={onDismissError}
              aria-label="Dismiss error message"
              className="text-red-500 hover:text-red-700"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {!appointment.humanControlEnabled ? (
        <div>
          <input
            type="text"
            placeholder="Reason for taking control (optional)"
            value={controlReason}
            onChange={(e) => setControlReason(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-2 focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none"
          />
          <button
            onClick={() => {
              takeControlMutation.mutate(
                { id: appointment.id, reason: controlReason || undefined },
                { onSuccess: () => setControlReason('') }
              );
            }}
            disabled={takeControlMutation.isPending}
            aria-label="Take human control and pause AI agent"
            aria-busy={takeControlMutation.isPending}
            className="w-full px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 font-medium"
          >
            {takeControlMutation.isPending ? 'Taking Control...' : 'Take Human Control (Pause Agent)'}
          </button>
          <p className="text-xs text-slate-500 mt-2 text-center">
            Take control to edit status or confirmed time
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Control Status */}
          <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
            <p className="font-medium text-orange-800">Human Control Active</p>
            <p className="text-sm text-orange-700">
              Taken by: {appointment.humanControlTakenBy || 'Unknown'}
              {appointment.humanControlTakenAt &&
                ` at ${new Date(appointment.humanControlTakenAt).toLocaleString()}`}
            </p>
            {appointment.humanControlReason && (
              <p className="text-sm text-orange-600 mt-1">
                Reason: {appointment.humanControlReason}
              </p>
            )}
          </div>

          {/* Resume Button */}
          <button
            onClick={() => releaseControlMutation.mutate(appointment.id)}
            disabled={releaseControlMutation.isPending}
            aria-label="Release human control and resume AI agent"
            aria-busy={releaseControlMutation.isPending}
            className="w-full px-4 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 font-medium"
          >
            {releaseControlMutation.isPending ? 'Resuming Agent...' : 'Resume Agent (Release Control)'}
          </button>

          {/* Edit Status / Confirmed Time Panel */}
          {!showEditPanel ? (
            <button
              onClick={() => onShowEditPanel(true)}
              aria-label="Edit appointment status and confirmed time"
              className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors font-medium"
            >
              Edit Status / Confirmed Time
            </button>
          ) : (
            <div className="p-3 border border-slate-200 rounded-lg bg-white">
              <h4 className="font-medium text-slate-800 mb-2">Edit Appointment</h4>

              <div className="mb-2">
                <label className="text-sm text-slate-600 block mb-1">Status:</label>
                <select
                  value={editStatus || ''}
                  onChange={(e) => onEditStatusChange(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                >
                  <option value="pending">Pending</option>
                  <option value="contacted">Contacted</option>
                  <option value="negotiating">Negotiating</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="session_held">Session Held</option>
                  <option value="feedback_requested">Feedback Requested</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>

              {editStatus === 'confirmed' && (
                <div className="mb-2">
                  <label className="text-sm text-slate-600 block mb-1">
                    Confirmed Date/Time:
                    <span className="text-red-500 ml-1">*</span>
                  </label>
                  <input
                    type="text"
                    value={editConfirmedDateTime}
                    onChange={(e) => onEditConfirmedDateTimeChange(e.target.value)}
                    placeholder="e.g., Tuesday 15th January at 2pm"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Enter the agreed appointment date and time
                  </p>
                </div>
              )}

              {editStatus === 'pending' && appointment.status !== 'pending' && (
                <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                  <p className="text-xs text-yellow-800">
                    Warning: Reverting to pending is unusual. Previous status: {appointment.status}
                  </p>
                </div>
              )}
              {editStatus === 'cancelled' && appointment.status === 'confirmed' && (
                <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded">
                  <p className="text-xs text-red-800">
                    Warning: Cancelling a confirmed appointment. The therapist will be unfrozen.
                  </p>
                </div>
              )}

              {editWarning && (
                <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                  <p className="text-xs text-yellow-800">{editWarning}</p>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    onShowEditPanel(false);
                    onEditStatusChange(appointment.status);
                    onEditConfirmedDateTimeChange(appointment.confirmedDateTime || '');
                  }}
                  aria-label="Cancel edit"
                  className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    updateAppointmentMutation.mutate({
                      id: appointment.id,
                      status: editStatus || undefined,
                      confirmedDateTime: editStatus === 'confirmed' ? editConfirmedDateTime : undefined,
                    });
                  }}
                  disabled={
                    updateAppointmentMutation.isPending ||
                    (editStatus === 'confirmed' && !editConfirmedDateTime.trim())
                  }
                  aria-label="Save appointment changes"
                  aria-busy={updateAppointmentMutation.isPending}
                  className="flex-1 px-3 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
                >
                  {updateAppointmentMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* Compose Message Toggle */}
          {!showComposeMessage ? (
            <button
              onClick={() => setShowComposeMessage(true)}
              aria-label="Open message composer"
              className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors font-medium"
            >
              Compose Message
            </button>
          ) : (
            <div className="p-3 border border-slate-200 rounded-lg bg-white">
              <h4 className="font-medium text-slate-800 mb-2">Send Message</h4>

              <div className="mb-2">
                <label className="text-sm text-slate-600 block mb-1">To:</label>
                <select
                  value={messageRecipient}
                  onChange={(e) => setMessageRecipient(e.target.value as 'client' | 'therapist')}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                >
                  <option value="client">Client ({appointment.userEmail})</option>
                  <option value="therapist">Therapist ({appointment.therapistEmail})</option>
                </select>
              </div>

              <div className="mb-2">
                <label className="text-sm text-slate-600 block mb-1">Subject:</label>
                <input
                  type="text"
                  value={messageSubject}
                  onChange={(e) => setMessageSubject(e.target.value)}
                  placeholder="Email subject"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                />
              </div>

              <div className="mb-3">
                <label className="text-sm text-slate-600 block mb-1">Message:</label>
                <textarea
                  value={messageBody}
                  onChange={(e) => setMessageBody(e.target.value)}
                  placeholder="Type your message..."
                  rows={4}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none resize-none"
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowComposeMessage(false);
                    setMessageSubject('');
                    setMessageBody('');
                  }}
                  aria-label="Cancel message composition"
                  className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSendMessage}
                  disabled={
                    sendMessageMutation.isPending ||
                    !messageSubject.trim() ||
                    !messageBody.trim()
                  }
                  aria-label="Send message to recipient"
                  aria-busy={sendMessageMutation.isPending}
                  className="flex-1 px-3 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
                >
                  {sendMessageMutation.isPending ? 'Sending...' : 'Send'}
                </button>
              </div>

              {sendMessageMutation.isError && (
                <p className="text-red-500 text-xs mt-2">
                  {sendMessageMutation.error instanceof Error
                    ? sendMessageMutation.error.message
                    : 'Failed to send message'}
                </p>
              )}

              {sendMessageMutation.isSuccess && (
                <p className="text-green-600 text-xs mt-2">
                  Email queued successfully
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Reprocess Thread — available regardless of human control state */}
      {(appointment.gmailThreadId || appointment.therapistGmailThreadId) && (
        <div className="mt-3 pt-3 border-t border-slate-200">
          {/* Preview button */}
          {!reprocessPreview && (
            <>
              <button
                onClick={() => previewReprocessMutation.mutate(appointment.id)}
                disabled={previewReprocessMutation.isPending}
                aria-label="Scan Gmail threads for missed messages"
                aria-busy={previewReprocessMutation.isPending}
                className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors text-sm font-medium disabled:opacity-50"
              >
                {previewReprocessMutation.isPending ? 'Scanning Thread...' : 'Scan for Missed Messages'}
              </button>
              <p className="text-xs text-slate-500 mt-1 text-center">
                Checks Gmail threads for unprocessed messages before taking action
              </p>
            </>
          )}

          {/* Preview panel */}
          {reprocessPreview && (
            <div className="p-3 border border-slate-200 rounded-lg bg-white">
              <div className="flex justify-between items-center mb-2">
                <h4 className="font-medium text-slate-800">Thread Scan Results</h4>
                <button
                  onClick={onDismissReprocessPreview}
                  aria-label="Close scan results"
                  className="text-slate-400 hover:text-slate-600 text-sm"
                >
                  &times;
                </button>
              </div>

              <p className="text-xs text-slate-600 mb-2">
                {reprocessPreview.message}
              </p>

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
                          className={`text-xs p-2 rounded border ${
                            msg.status === 'unprocessed'
                              ? 'bg-yellow-50 border-yellow-200'
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="flex justify-between items-start">
                            <span className="font-medium truncate flex-1">{msg.from}</span>
                            <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              msg.status === 'unprocessed'
                                ? 'bg-yellow-200 text-yellow-800'
                                : 'bg-slate-200 text-slate-600'
                            }`}>
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

              {/* Action buttons */}
              <div className="flex gap-2 mt-3">
                <button
                  onClick={onDismissReprocessPreview}
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
                      reprocessThreadMutation.mutate({
                        id: appointment.id,
                        forceMessageIds: unprocessedIds,
                      });
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
                    appointment={appointment}
                    preview={reprocessPreview}
                    reprocessMutation={reprocessThreadMutation}
                  />
                )}
              </div>
            </div>
          )}

          {/* Result feedback */}
          {reprocessResult && (
            <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex justify-between items-start">
                <p className="text-xs text-green-700">{reprocessResult.message}</p>
                <button
                  onClick={onDismissReprocessResult}
                  className="text-green-500 hover:text-green-700 text-xs ml-2"
                >
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
      )}
    </div>
  );
}

/**
 * Force-reprocess button: shown when all messages are already processed but admin
 * suspects partial processing. Lets them select specific messages to force-reprocess.
 * Requires explicit confirmation due to the risk of duplicate side effects.
 */
function ForceReprocessButton({
  appointment,
  preview,
  reprocessMutation,
}: {
  appointment: AppointmentDetail;
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
              id: appointment.id,
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
