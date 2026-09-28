import { useState } from 'react';
import type { AppointmentDetail } from '../../types';
import { formatDateTime } from '../../utils/date-format';
import ConfirmDialog from '../ConfirmDialog';

interface ClosureRecommendationSectionProps {
  appointment: AppointmentDetail;
  onAction: (action: 'cancel' | 'dismiss') => Promise<void>;
}

export default function ClosureRecommendationSection({
  appointment,
  onAction,
}: ClosureRecommendationSectionProps) {
  const [isActioning, setIsActioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancelling is irreversible and emails both parties, so it goes through
  // a confirmation dialog rather than firing on a single click.
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // Only show if there's an unactioned closure recommendation
  if (!appointment.closureRecommendedAt || appointment.closureRecommendationActioned) {
    // Show chase info if chase was sent but no closure recommendation yet
    if (appointment.chaseSentAt && !appointment.closureRecommendedAt) {
      return (
        <div className="p-3 mx-4 mt-3 bg-amber-50 rounded-lg border border-amber-200">
          <p className="text-sm font-medium text-amber-800">Chase follow-up sent</p>
          <p className="text-xs text-amber-600 mt-1">
            Sent to {appointment.chaseSentTo} on{' '}
            {formatDateTime(appointment.chaseSentAt)} (UK).
            Awaiting response.
          </p>
        </div>
      );
    }
    return null;
  }

  const handleAction = async (action: 'cancel' | 'dismiss') => {
    setIsActioning(true);
    setError(null);
    try {
      await onAction(action);
      setConfirmingCancel(false);
    } catch (err) {
      // Keep the dialog open on failure so the admin sees why and can retry.
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setIsActioning(false);
    }
  };

  return (
    <div className="p-3 mx-4 mt-3 bg-red-50 rounded-lg border border-red-300">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-red-800">Closure recommended</p>
          <p className="text-xs text-red-600 mt-1">
            {appointment.closureRecommendedReason}
          </p>
          <p className="text-xs text-red-500 mt-1">
            Recommended on{' '}
            {formatDateTime(appointment.closureRecommendedAt)} (UK)
          </p>
        </div>
      </div>
      {error && !confirmingCancel && (
        <p role="alert" className="text-xs text-red-700 mt-2 bg-red-100 p-1 rounded">{error}</p>
      )}
      <div className="flex gap-2 mt-3">
        <button
          onClick={() => {
            setError(null);
            setConfirmingCancel(true);
          }}
          disabled={isActioning}
          className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
        >
          Cancel appointment
        </button>
        <button
          onClick={() => handleAction('dismiss')}
          disabled={isActioning}
          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg disabled:opacity-50"
        >
          {isActioning && !confirmingCancel ? 'Processing...' : 'Dismiss'}
        </button>
      </div>
      {confirmingCancel && (
        <ConfirmDialog
          title="Cancel this appointment?"
          confirmLabel="Cancel appointment"
          cancelLabel="Keep appointment"
          confirmVariant="danger"
          isPending={isActioning}
          onConfirm={() => handleAction('cancel')}
          onCancel={() => {
            if (isActioning) return;
            setConfirmingCancel(false);
            setError(null);
          }}
        >
          <p className="text-sm text-slate-600">
            This cancels the appointment between{' '}
            <span className="font-medium text-slate-900">{appointment.userName || appointment.userEmail}</span>{' '}
            and <span className="font-medium text-slate-900">{appointment.therapistName}</span>, and sends
            both of them a cancellation email (if cancellation emails are enabled in Settings).
            This can&apos;t be undone.
          </p>
          {error && (
            <p role="alert" className="text-sm text-red-700 mt-3 bg-red-50 border border-red-200 p-2 rounded">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
