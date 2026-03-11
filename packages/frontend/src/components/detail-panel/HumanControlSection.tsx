import { useState } from 'react';
import type { AppointmentDetail } from '../../types';
import type { AppointmentControls } from '../../hooks/useAppointmentControls';
import ScanResultsPanel from './ScanResultsPanel';

interface HumanControlSectionProps {
  appointment: AppointmentDetail;
  controls: AppointmentControls;
}

export default function HumanControlSection({
  appointment,
  controls,
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
    controls.sendMessageMutation.mutate(
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
      {controls.mutationError && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex justify-between items-start">
            <p className="text-sm text-red-700">{controls.mutationError}</p>
            <button
              onClick={controls.dismissError}
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
              controls.takeControlMutation.mutate(
                { id: appointment.id, reason: controlReason || undefined },
                { onSuccess: () => setControlReason('') }
              );
            }}
            disabled={controls.takeControlMutation.isPending}
            aria-label="Take human control and pause AI agent"
            aria-busy={controls.takeControlMutation.isPending}
            className="w-full px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 font-medium"
          >
            {controls.takeControlMutation.isPending ? 'Taking Control...' : 'Take Human Control (Pause Agent)'}
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
            onClick={() => controls.releaseControlMutation.mutate(appointment.id)}
            disabled={controls.releaseControlMutation.isPending}
            aria-label="Release human control and resume AI agent"
            aria-busy={controls.releaseControlMutation.isPending}
            className="w-full px-4 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 font-medium"
          >
            {controls.releaseControlMutation.isPending ? 'Resuming Agent...' : 'Resume Agent (Release Control)'}
          </button>

          {/* Edit Status / Confirmed Time Panel */}
          {!controls.showEditPanel ? (
            <button
              onClick={() => controls.setShowEditPanel(true)}
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
                  value={controls.editStatus || ''}
                  onChange={(e) => controls.setEditStatus(e.target.value)}
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

              {controls.editStatus === 'confirmed' && (
                <div className="mb-2">
                  <label className="text-sm text-slate-600 block mb-1">
                    Confirmed Date/Time:
                    <span className="text-red-500 ml-1">*</span>
                  </label>
                  <input
                    type="text"
                    value={controls.editConfirmedDateTime}
                    onChange={(e) => controls.setEditConfirmedDateTime(e.target.value)}
                    placeholder="e.g., Tuesday 15th January at 2pm"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Enter the agreed appointment date and time
                  </p>
                </div>
              )}

              {controls.editStatus === 'pending' && appointment.status !== 'pending' && (
                <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                  <p className="text-xs text-yellow-800">
                    Warning: Reverting to pending is unusual. Previous status: {appointment.status}
                  </p>
                </div>
              )}
              {controls.editStatus === 'cancelled' && appointment.status === 'confirmed' && (
                <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded">
                  <p className="text-xs text-red-800">
                    Warning: Cancelling a confirmed appointment. The therapist will be unfrozen.
                  </p>
                </div>
              )}

              {controls.editWarning && (
                <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                  <p className="text-xs text-yellow-800">{controls.editWarning}</p>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    controls.setShowEditPanel(false);
                    controls.setEditStatus(appointment.status);
                    controls.setEditConfirmedDateTime(appointment.confirmedDateTime || '');
                  }}
                  aria-label="Cancel edit"
                  className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    controls.updateAppointmentMutation.mutate({
                      id: appointment.id,
                      status: controls.editStatus || undefined,
                      confirmedDateTime: controls.editStatus === 'confirmed' ? controls.editConfirmedDateTime : undefined,
                    });
                  }}
                  disabled={
                    controls.updateAppointmentMutation.isPending ||
                    (controls.editStatus === 'confirmed' && !controls.editConfirmedDateTime.trim())
                  }
                  aria-label="Save appointment changes"
                  aria-busy={controls.updateAppointmentMutation.isPending}
                  className="flex-1 px-3 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
                >
                  {controls.updateAppointmentMutation.isPending ? 'Saving...' : 'Save Changes'}
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
                    controls.sendMessageMutation.isPending ||
                    !messageSubject.trim() ||
                    !messageBody.trim()
                  }
                  aria-label="Send message to recipient"
                  aria-busy={controls.sendMessageMutation.isPending}
                  className="flex-1 px-3 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 text-sm font-medium"
                >
                  {controls.sendMessageMutation.isPending ? 'Sending...' : 'Send'}
                </button>
              </div>

              {controls.sendMessageMutation.isError && (
                <p className="text-red-500 text-xs mt-2">
                  {controls.sendMessageMutation.error instanceof Error
                    ? controls.sendMessageMutation.error.message
                    : 'Failed to send message'}
                </p>
              )}

              {controls.sendMessageMutation.isSuccess && (
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
          {!controls.reprocessPreview && (
            <>
              <button
                onClick={() => controls.previewReprocessMutation.mutate(appointment.id)}
                disabled={controls.previewReprocessMutation.isPending}
                aria-label="Scan Gmail threads for missed messages"
                aria-busy={controls.previewReprocessMutation.isPending}
                className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors text-sm font-medium disabled:opacity-50"
              >
                {controls.previewReprocessMutation.isPending ? 'Scanning Thread...' : 'Scan for Missed Messages'}
              </button>
              <p className="text-xs text-slate-500 mt-1 text-center">
                Checks Gmail threads for unprocessed messages before taking action
              </p>
            </>
          )}

          <ScanResultsPanel
            appointmentId={appointment.id}
            previewReprocessMutation={controls.previewReprocessMutation}
            reprocessThreadMutation={controls.reprocessThreadMutation}
            reprocessPreview={controls.reprocessPreview}
            reprocessResult={controls.reprocessResult}
            onDismissPreview={controls.dismissReprocessPreview}
            onDismissResult={controls.dismissReprocessResult}
          />
        </div>
      )}
    </div>
  );
}
