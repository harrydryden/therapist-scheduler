import type { AppointmentDetail } from '../../types';
import { getStatusColor } from '../../config/color-mappings';

interface DetailHeaderProps {
  appointment: AppointmentDetail;
}

export default function DetailHeader({ appointment }: DetailHeaderProps) {
  return (
    <div className="p-4 border-b border-slate-100">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="font-semibold text-slate-900">
            {appointment.userName || 'Unknown User'}
          </h2>
          <p className="text-sm text-slate-500">{appointment.userEmail}</p>
        </div>
        <span
          className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(appointment.status)}`}
        >
          {appointment.status}
        </span>
      </div>
      <div className="mt-3 text-sm text-slate-600">
        <p>
          <span className="font-medium">Therapist:</span> {appointment.therapistName}
        </p>
        <p>
          <span className="font-medium">Email:</span> {appointment.therapistEmail}
        </p>
      </div>
      {appointment.confirmedAt && (
        <div className="mt-3 p-3 bg-green-50 rounded-lg border border-green-200">
          <p className="text-sm font-medium text-green-700">
            Confirmed: {appointment.confirmedDateTime || new Date(appointment.confirmedAt).toLocaleString()}
          </p>
          <p className="text-xs text-green-600 mt-1">
            on {new Date(appointment.confirmedAt).toLocaleString()}
          </p>
        </div>
      )}
      {(appointment.gmailThreadId || appointment.therapistGmailThreadId) && (
        <div className="mt-3 p-2 bg-slate-50 rounded-lg border border-slate-200">
          <p className="text-xs font-medium text-slate-500 mb-1">Email Thread IDs</p>
          {appointment.gmailThreadId && (
            <p className="text-xs text-slate-400 font-mono">
              Client: {appointment.gmailThreadId}
            </p>
          )}
          {appointment.therapistGmailThreadId && (
            <p className="text-xs text-slate-400 font-mono">
              Therapist: {appointment.therapistGmailThreadId}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
