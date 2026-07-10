import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { POST_BOOKING_STATUSES } from '@therapist-scheduler/shared';
import { reRequestFeedback } from '../../api/appointments';
import { getErrorMessage } from '../../api/core';
import type { AppointmentDetail } from '../../types';

/**
 * Statuses from which re-requesting feedback makes sense — the shared
 * post-booking set (confirmed and beyond, excluding cancelled), the same
 * constant the backend eligibility check uses, so the gates can't drift.
 */
export const FEEDBACK_ELIGIBLE_STATUSES: readonly string[] = POST_BOOKING_STATUSES;

interface ReRequestFeedbackSectionProps {
  appointment: AppointmentDetail;
}

/**
 * Admin action: discard the appointment's existing feedback submission (if
 * any) and send a fresh, tokened feedback-form email. Recovery path for a
 * feedback form that went out too early or was submitted in error.
 *
 * Deliberately uses inline confirm UI (not the shared ConfirmDialog) — no
 * free-text input is needed, and the confirm/apply pattern mirrors
 * DeleteSection for consistency in this panel.
 */
export default function ReRequestFeedbackSection({ appointment }: ReRequestFeedbackSectionProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => reRequestFeedback(appointment.id),
    onSuccess: (data) => {
      setSuccessMessage(
        `Sent a fresh feedback form to ${data.emailSentTo}` +
          (data.deletedSubmissions > 0
            ? ` and discarded ${data.deletedSubmissions} prior submission${data.deletedSubmissions === 1 ? '' : 's'}.`
            : '.'),
      );
      setError(null);
      setShowConfirm(false);
      queryClient.invalidateQueries({ queryKey: ['appointment', appointment.id] });
      queryClient.invalidateQueries({ queryKey: ['appointments'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'], refetchType: 'none' });
    },
    onError: (err) => setError(getErrorMessage(err, 'Failed to re-request feedback')),
  });

  if (successMessage) {
    return (
      <div className="mt-4 pt-4 border-t border-slate-200">
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          {successMessage}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-slate-200">
      {!showConfirm ? (
        <button
          onClick={() => {
            setShowConfirm(true);
            setError(null);
          }}
          className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors font-medium text-sm"
        >
          Re-request Feedback
        </button>
      ) : (
        <div className="p-3 border border-amber-200 rounded-lg bg-amber-50">
          <h4 className="font-medium text-amber-800 mb-2">Re-request feedback?</h4>
          <p className="text-sm text-amber-700 mb-3">
            This discards the existing feedback submission for this appointment (if any) and emails
            the user a fresh feedback form. Use this when the form was sent too early or submitted in
            error. The appointment returns to <span className="font-medium">feedback&nbsp;requested</span>.
          </p>
          {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => {
                setShowConfirm(false);
                setError(null);
              }}
              disabled={mutation.isPending}
              className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-white transition-colors text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              aria-busy={mutation.isPending}
              className="flex-1 px-3 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50 text-sm font-medium"
            >
              {mutation.isPending ? 'Sending…' : 'Discard & re-send'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
