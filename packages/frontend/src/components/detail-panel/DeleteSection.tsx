import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { AppointmentDetail } from '../../types';

interface DeleteSectionProps {
  appointment: AppointmentDetail;
  deleteMutation: UseMutationResult<unknown, Error, { id: string; reason?: string; forceDeleteConfirmed?: boolean }>;
}

export default function DeleteSection({ appointment, deleteMutation }: DeleteSectionProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const [forceConfirmed, setForceConfirmed] = useState(false);

  return (
    <div className="mt-4 pt-4 border-t border-slate-200">
      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
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

          {appointment.status === 'confirmed' && (
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
                  checked={forceConfirmed}
                  onChange={(e) => setForceConfirmed(e.target.checked)}
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
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you deleting this appointment?"
              className="w-full px-3 py-2 border border-red-200 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setShowConfirm(false);
                setReason('');
                setForceConfirmed(false);
              }}
              aria-label="Cancel deletion"
              className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-white transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() =>
                deleteMutation.mutate(
                  {
                    id: appointment.id,
                    reason: reason || undefined,
                    forceDeleteConfirmed: appointment.status === 'confirmed' ? true : undefined,
                  },
                  {
                    onSuccess: () => {
                      setShowConfirm(false);
                      setReason('');
                      setForceConfirmed(false);
                    },
                  }
                )
              }
              disabled={
                deleteMutation.isPending ||
                (appointment.status === 'confirmed' && !forceConfirmed)
              }
              aria-label="Confirm permanent deletion of appointment"
              aria-busy={deleteMutation.isPending}
              className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 text-sm font-medium"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Yes, Delete'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
