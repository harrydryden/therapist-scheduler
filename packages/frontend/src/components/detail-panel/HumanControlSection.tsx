import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AppointmentDetail } from '../../types';

interface HumanControlSectionProps {
  appointment: AppointmentDetail;
  mutationError: string | null;
  onDismissError: () => void;
  // Mutations
  takeControlMutation: UseMutationResult<unknown, Error, { id: string; reason?: string }>;
  releaseControlMutation: UseMutationResult<unknown, Error, string>;
  updateAppointmentMutation: UseMutationResult<{ warning?: string }, Error, { id: string; status?: string; confirmedDateTime?: string | null }>;
  sendMessageMutation: UseMutationResult<unknown, Error, { id: string; to: string; subject: string; body: string }>;
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
    </div>
  );
}
