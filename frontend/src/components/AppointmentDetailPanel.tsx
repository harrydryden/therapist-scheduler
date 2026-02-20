import { useState, useEffect, useRef, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { ErrorBoundary } from './ErrorBoundary';
import {
  takeControl,
  releaseControl,
  sendAdminMessage,
  deleteAppointment,
  updateAppointment,
} from '../api/client';
import type { AppointmentDetail } from '../types';
import { APP } from '../config/constants';
import { getStatusColor } from '../config/color-mappings';
import { getAdminId } from '../utils/admin-id';

// Sanitize text content to prevent XSS
function sanitizeText(text: string): string {
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [] });
}

interface AppointmentDetailPanelProps {
  selectedAppointment: string | null;
  appointmentDetail: AppointmentDetail | undefined;
  loadingDetail: boolean;
  onClearSelection: () => void;
}

export default function AppointmentDetailPanel({
  selectedAppointment,
  appointmentDetail,
  loadingDetail,
  onClearSelection,
}: AppointmentDetailPanelProps) {
  const queryClient = useQueryClient();
  const adminId = useMemo(() => getAdminId(), []);

  // Human control state
  const [showComposeMessage, setShowComposeMessage] = useState(false);
  const [messageRecipient, setMessageRecipient] = useState<'client' | 'therapist'>('client');
  const [messageSubject, setMessageSubject] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [controlReason, setControlReason] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Delete appointment state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const [forceDeleteConfirmed, setForceDeleteConfirmed] = useState(false);

  // Edit appointment state
  const [showEditPanel, setShowEditPanel] = useState(false);
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [editConfirmedDateTime, setEditConfirmedDateTime] = useState('');
  const [editWarning, setEditWarning] = useState<string | null>(null);
  // FIX #35: Track editWarning timeout for cleanup on unmount
  const editWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset all local state when switching appointments to prevent stale UI
  useEffect(() => {
    setShowComposeMessage(false);
    setMessageSubject('');
    setMessageBody('');
    setControlReason('');
    setMutationError(null);
    setShowDeleteConfirm(false);
    setDeleteReason('');
    setForceDeleteConfirmed(false);
    setShowEditPanel(false);
    setEditWarning(null);
  }, [selectedAppointment]);

  // Sync edit form state when appointment detail loads
  useEffect(() => {
    if (appointmentDetail) {
      setEditStatus(appointmentDetail.status);
      setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
    }
  }, [appointmentDetail]);

  // FIX #35: Clear editWarning timeout on unmount
  useEffect(() => {
    return () => {
      if (editWarningTimeoutRef.current) {
        clearTimeout(editWarningTimeoutRef.current);
      }
    };
  }, []);

  // Human control mutations
  const takeControlMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      takeControl(id, { adminId, reason }),
    // FIX #37: Clear mutationError at start of each mutation
    onMutate: () => { setMutationError(null); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setControlReason('');
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to take control');
    },
  });

  const releaseControlMutation = useMutation({
    mutationFn: (id: string) => releaseControl(id),
    // FIX #37: Clear mutationError at start of each mutation
    onMutate: () => { setMutationError(null); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to release control');
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: ({
      id,
      to,
      subject,
      body,
    }: {
      id: string;
      to: string;
      subject: string;
      body: string;
    }) => sendAdminMessage(id, { to, subject, body, adminId }),
    // FIX #37: Clear mutationError at start of each mutation
    onMutate: () => { setMutationError(null); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      setShowComposeMessage(false);
      setMessageSubject('');
      setMessageBody('');
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to send message');
    },
  });

  const deleteAppointmentMutation = useMutation({
    mutationFn: ({ id, reason, forceDeleteConfirmed: force }: { id: string; reason?: string; forceDeleteConfirmed?: boolean }) =>
      deleteAppointment(id, { adminId, reason, forceDeleteConfirmed: force }),
    // FIX #37: Clear mutationError at start of each mutation
    onMutate: () => { setMutationError(null); },
    onSuccess: () => {
      onClearSelection();
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setShowDeleteConfirm(false);
      setDeleteReason('');
      setForceDeleteConfirmed(false);
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to delete appointment');
    },
  });

  const updateAppointmentMutation = useMutation({
    mutationFn: ({
      id,
      status,
      confirmedDateTime,
    }: {
      id: string;
      status?: string;
      confirmedDateTime?: string | null;
    }) =>
      updateAppointment(id, {
        status: status as 'pending' | 'contacted' | 'negotiating' | 'confirmed' | 'cancelled' | undefined,
        confirmedDateTime,
        adminId,
      }),
    // FIX #37: Clear mutationError at start of each mutation
    onMutate: () => { setMutationError(null); },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setShowEditPanel(false);
      setMutationError(null);
      if (data.warning) {
        setEditWarning(data.warning);
        // FIX #35: Store timeout ref so it can be cleared on unmount
        if (editWarningTimeoutRef.current) {
          clearTimeout(editWarningTimeoutRef.current);
        }
        editWarningTimeoutRef.current = setTimeout(() => setEditWarning(null), 5000);
      }
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to update appointment');
    },
  });

  const handleSendMessage = () => {
    if (!appointmentDetail || !messageSubject.trim() || !messageBody.trim()) return;
    const to =
      messageRecipient === 'client'
        ? appointmentDetail.userEmail
        : appointmentDetail.therapistEmail;
    sendMessageMutation.mutate({
      id: appointmentDetail.id,
      to,
      subject: messageSubject,
      body: messageBody,
    });
  };

  if (!selectedAppointment) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-8 text-center text-slate-500 h-full flex items-center justify-center min-h-[400px]">
          <div>
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
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <p>Select an appointment to view details</p>
          </div>
        </div>
      </div>
    );
  }

  if (loadingDetail) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-8 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800 mx-auto"></div>
          <p className="text-sm text-slate-500 mt-2">Loading...</p>
        </div>
      </div>
    );
  }

  if (!appointmentDetail) return null;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
      <ErrorBoundary fallback={
        <div className="p-8 text-center text-red-500">
          <p className="font-medium mb-2">Failed to render appointment details</p>
          <button onClick={onClearSelection} className="text-sm text-spill-blue-800 hover:underline">
            Go back to list
          </button>
        </div>
      }>
      <div className="h-full flex flex-col">
        {/* Detail Header */}
        <div className="p-4 border-b border-slate-100">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="font-semibold text-slate-900">
                {appointmentDetail.userName || 'Unknown User'}
              </h2>
              <p className="text-sm text-slate-500">{appointmentDetail.userEmail}</p>
            </div>
            <span
              className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(appointmentDetail.status)}`}
            >
              {appointmentDetail.status}
            </span>
          </div>
          <div className="mt-3 text-sm text-slate-600">
            <p>
              <span className="font-medium">Therapist:</span> {appointmentDetail.therapistName}
            </p>
            <p>
              <span className="font-medium">Email:</span> {appointmentDetail.therapistEmail}
            </p>
          </div>
          {appointmentDetail.confirmedAt && (
            <div className="mt-3 p-3 bg-green-50 rounded-lg border border-green-200">
              <p className="text-sm font-medium text-green-700">
                Confirmed: {appointmentDetail.confirmedDateTime || new Date(appointmentDetail.confirmedAt).toLocaleString()}
              </p>
              <p className="text-xs text-green-600 mt-1">
                on {new Date(appointmentDetail.confirmedAt).toLocaleString()}
              </p>
            </div>
          )}
          {/* Thread IDs for debugging */}
          {(appointmentDetail.gmailThreadId || appointmentDetail.therapistGmailThreadId) && (
            <div className="mt-3 p-2 bg-slate-50 rounded-lg border border-slate-200">
              <p className="text-xs font-medium text-slate-500 mb-1">Email Thread IDs</p>
              {appointmentDetail.gmailThreadId && (
                <p className="text-xs text-slate-400 font-mono">
                  Client: {appointmentDetail.gmailThreadId}
                </p>
              )}
              {appointmentDetail.therapistGmailThreadId && (
                <p className="text-xs text-slate-400 font-mono">
                  Therapist: {appointmentDetail.therapistGmailThreadId}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Human Control Panel */}
        <div className="p-4 border-b border-slate-100 bg-slate-50">
          {/* Mutation Error Display */}
          {mutationError && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex justify-between items-start">
                <p className="text-sm text-red-700">{mutationError}</p>
                <button
                  onClick={() => setMutationError(null)}
                  aria-label="Dismiss error message"
                  className="text-red-500 hover:text-red-700"
                >
                  &times;
                </button>
              </div>
            </div>
          )}

          {!appointmentDetail.humanControlEnabled ? (
            <div>
              <input
                type="text"
                placeholder="Reason for taking control (optional)"
                value={controlReason}
                onChange={(e) => setControlReason(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-2 focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none"
              />
              <button
                onClick={() =>
                  takeControlMutation.mutate({
                    id: appointmentDetail.id,
                    reason: controlReason || undefined,
                  })
                }
                disabled={takeControlMutation.isPending}
                aria-label="Take human control and pause AI agent"
                aria-busy={takeControlMutation.isPending}
                className="w-full px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 font-medium"
              >
                {takeControlMutation.isPending
                  ? 'Taking Control...'
                  : 'Take Human Control (Pause Agent)'}
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
                  Taken by: {appointmentDetail.humanControlTakenBy || 'Unknown'}
                  {appointmentDetail.humanControlTakenAt &&
                    ` at ${new Date(appointmentDetail.humanControlTakenAt).toLocaleString()}`}
                </p>
                {appointmentDetail.humanControlReason && (
                  <p className="text-sm text-orange-600 mt-1">
                    Reason: {appointmentDetail.humanControlReason}
                  </p>
                )}
              </div>

              {/* Resume Button */}
              <button
                onClick={() => releaseControlMutation.mutate(appointmentDetail.id)}
                disabled={releaseControlMutation.isPending}
                aria-label="Release human control and resume AI agent"
                aria-busy={releaseControlMutation.isPending}
                className="w-full px-4 py-2 bg-spill-blue-800 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50 font-medium"
              >
                {releaseControlMutation.isPending
                  ? 'Resuming Agent...'
                  : 'Resume Agent (Release Control)'}
              </button>

              {/* Edit Status / Confirmed Time Panel */}
              {!showEditPanel ? (
                <button
                  onClick={() => setShowEditPanel(true)}
                  aria-label="Edit appointment status and confirmed time"
                  className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors font-medium"
                >
                  Edit Status / Confirmed Time
                </button>
              ) : (
                <div className="p-3 border border-slate-200 rounded-lg bg-white">
                  <h4 className="font-medium text-slate-800 mb-2">Edit Appointment</h4>

                  {/* Status Dropdown */}
                  <div className="mb-2">
                    <label className="text-sm text-slate-600 block mb-1">Status:</label>
                    <select
                      value={editStatus || ''}
                      onChange={(e) => setEditStatus(e.target.value)}
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

                  {/* Confirmed DateTime (only shown when status is confirmed) */}
                  {editStatus === 'confirmed' && (
                    <div className="mb-2">
                      <label className="text-sm text-slate-600 block mb-1">
                        Confirmed Date/Time:
                        <span className="text-red-500 ml-1">*</span>
                      </label>
                      <input
                        type="text"
                        value={editConfirmedDateTime}
                        onChange={(e) => setEditConfirmedDateTime(e.target.value)}
                        placeholder="e.g., Tuesday 15th January at 2pm"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        Enter the agreed appointment date and time
                      </p>
                    </div>
                  )}

                  {/* Warning for unusual transitions */}
                  {editStatus === 'pending' && appointmentDetail.status !== 'pending' && (
                    <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                      <p className="text-xs text-yellow-800">
                        Warning: Reverting to pending is unusual. Previous status: {appointmentDetail.status}
                      </p>
                    </div>
                  )}
                  {editStatus === 'cancelled' && appointmentDetail.status === 'confirmed' && (
                    <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded">
                      <p className="text-xs text-red-800">
                        Warning: Cancelling a confirmed appointment. The therapist will be unfrozen.
                      </p>
                    </div>
                  )}

                  {/* Edit warning from response */}
                  {editWarning && (
                    <div className="mb-2 p-2 bg-yellow-50 border border-yellow-200 rounded">
                      <p className="text-xs text-yellow-800">{editWarning}</p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setShowEditPanel(false);
                        setEditStatus(appointmentDetail.status);
                        setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
                      }}
                      aria-label="Cancel edit"
                      className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        updateAppointmentMutation.mutate({
                          id: appointmentDetail.id,
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

                  {/* Recipient Select */}
                  <div className="mb-2">
                    <label className="text-sm text-slate-600 block mb-1">To:</label>
                    <select
                      value={messageRecipient}
                      onChange={(e) =>
                        setMessageRecipient(e.target.value as 'client' | 'therapist')
                      }
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
                    >
                      <option value="client">
                        Client ({appointmentDetail.userEmail})
                      </option>
                      <option value="therapist">
                        Therapist ({appointmentDetail.therapistEmail})
                      </option>
                    </select>
                  </div>

                  {/* Subject */}
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

                  {/* Body */}
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

                  {/* Actions */}
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
                </div>
              )}
            </div>
          )}

          {/* Delete Appointment Section */}
          <div className="mt-4 pt-4 border-t border-slate-200">
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                aria-label="Show delete appointment confirmation"
                className="w-full px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors font-medium text-sm"
              >
                Delete Appointment
              </button>
            ) : (
              <div className="p-3 border border-red-200 rounded-lg bg-red-50">
                <h4 className="font-medium text-red-800 mb-2">Delete Appointment?</h4>
                <p className="text-sm text-red-700 mb-3">
                  This will permanently delete this appointment request and all conversation history.
                  This action cannot be undone.
                </p>

                {/* Extra warning for confirmed appointments */}
                {appointmentDetail.status === 'confirmed' && (
                  <div className="mb-3 p-2 bg-red-100 border border-red-300 rounded">
                    <p className="text-sm text-red-800 font-medium mb-2">
                      This is a CONFIRMED appointment!
                    </p>
                    <p className="text-xs text-red-700 mb-2">
                      Deleting this will also unfreeze the therapist, allowing them to accept new bookings.
                      Only delete if the session did NOT take place.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={forceDeleteConfirmed}
                        onChange={(e) => setForceDeleteConfirmed(e.target.checked)}
                        className="w-4 h-4 text-red-600 border-red-300 rounded focus:ring-red-500"
                      />
                      <span className="text-sm text-red-800 font-medium">
                        I confirm the session did NOT take place
                      </span>
                    </label>
                  </div>
                )}

                <div className="mb-3">
                  <label className="text-sm text-red-700 block mb-1">Reason (optional):</label>
                  <input
                    type="text"
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                    placeholder="Why are you deleting this appointment?"
                    className="w-full px-3 py-2 border border-red-200 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setDeleteReason('');
                      setForceDeleteConfirmed(false);
                    }}
                    aria-label="Cancel deletion"
                    className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-white transition-colors text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() =>
                      deleteAppointmentMutation.mutate({
                        id: appointmentDetail.id,
                        reason: deleteReason || undefined,
                        forceDeleteConfirmed: appointmentDetail.status === 'confirmed' ? true : undefined,
                      })
                    }
                    disabled={
                      deleteAppointmentMutation.isPending ||
                      (appointmentDetail.status === 'confirmed' && !forceDeleteConfirmed)
                    }
                    aria-label="Confirm permanent deletion of appointment"
                    aria-busy={deleteAppointmentMutation.isPending}
                    className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 text-sm font-medium"
                  >
                    {deleteAppointmentMutation.isPending ? 'Deleting...' : 'Yes, Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Conversation - show latest message from each role */}
        <div className="flex-1 overflow-y-auto p-4 max-h-[450px]">
          <h3 className="font-medium text-slate-700 mb-3">Latest Messages</h3>
          {(() => {
            const messages = appointmentDetail.conversation?.messages;
            if (!messages || messages.length === 0) {
              return <p className="text-slate-500 text-sm">No conversation history</p>;
            }

            // Extract the last message from each role
            const latestByRole = new Map<string, typeof messages[0]>();
            for (const msg of messages) {
              latestByRole.set(msg.role, msg);
            }

            const latestMessages = Array.from(latestByRole.values());

            return (
              <div className="space-y-3">
                {latestMessages.map((msg, idx) => (
                  <div
                    key={`${msg.role}-${idx}`}
                    className={`p-3 rounded-lg ${
                      msg.role === 'assistant'
                        ? 'bg-primary-50 border border-primary-100'
                        : msg.role === 'admin'
                          ? 'bg-orange-50 border border-orange-100'
                          : 'bg-slate-100 border border-slate-200'
                    }`}
                  >
                    <p
                      className={`text-xs font-medium mb-1 ${
                        msg.role === 'admin' ? 'text-orange-600' : 'text-slate-500'
                      }`}
                    >
                      {msg.role === 'assistant'
                        ? APP.COORDINATOR_NAME
                        : msg.role === 'admin'
                          ? 'Admin (Human)'
                          : 'Email Received'}
                    </p>
                    <p className="text-sm text-slate-800 whitespace-pre-wrap">{sanitizeText(msg.content)}</p>
                  </div>
                ))}
                <p className="text-xs text-slate-400 text-center">
                  {messages.length} total messages in conversation
                </p>
              </div>
            );
          })()}
        </div>
      </div>
      </ErrorBoundary>
    </div>
  );
}
